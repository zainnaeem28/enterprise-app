// Database-free tests of the alert stream (ARCHITECTURE 32): the closed event shapes, the payload parser, and the hub's
// backpressure, limits, ping, drain and resync behaviour against fake connections.
//   pnpm --filter @ehr/api build && node --test apps/api/dist/src/modules/notifications/stream/stream.test.js
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { KernelDb, ScopeSettings } from '@ehr/kernel';
import type { AlertService } from '../alerts/service.js';
import type { AlertView } from '../alerts/types.js';
import {
  MAX_STREAMS_PER_PRINCIPAL,
  MAX_STREAMS_PER_SESSION,
  StreamHub,
  WRITE_BUFFER_LIMIT,
  parseLastEventId,
  parsePayload,
} from './hub.js';
import type { ListenClient, StreamResponse } from './hub.js';
import {
  ALERT_CLOSED_EVENT_FIELDS,
  ALERT_EVENT_FIELDS,
  alertClosedEvent,
  alertEvent,
} from './serialize.js';

const ID = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const scope = (p: string): ScopeSettings => ({
  audience: 'staff',
  realm: 'google',
  orgId: ID(1),
  principalId: p,
});

const view = (n: number, over: Partial<AlertView> = {}): AlertView => ({
  alertId: ID(100 + n),
  seq: n,
  type: 'red_flag',
  severity: 'critical',
  status: 'open',
  createdAt: '2030-01-01T00:00:00.000Z',
  escalationLevel: 0,
  escalatesAt: null,
  acknowledgedAt: null,
  acknowledgedBy: null,
  acknowledgedByDisplayName: null,
  patientId: ID(900),
  resourceType: 'triage_assessment',
  resourceId: ID(901),
  link: `/alerts/${ID(100 + n)}`,
  ...over,
});

class FakeRes implements StreamResponse {
  chunks: string[] = [];
  ended = false;
  destroyed = false;
  closeCb: (() => void) | undefined;
  writableLength = 0;
  get writableEnded(): boolean {
    return this.ended;
  }
  status(): unknown {
    return this;
  }
  setHeader(): unknown {
    return this;
  }
  flushHeaders(): void {}
  write(c: string): boolean {
    this.chunks.push(c);
    return true;
  }
  end(): unknown {
    this.ended = true;
    return this;
  }
  destroy(): unknown {
    this.destroyed = true;
    this.ended = true;
    return this;
  }
  on(_e: 'close', cb: () => void): unknown {
    this.closeCb = cb;
    return this;
  }
  text(): string {
    return this.chunks.join('');
  }
}

class FakeListen implements ListenClient {
  handler: ((m: { channel: string; payload?: string }) => void) | undefined;
  connect = (): Promise<void> => Promise.resolve();
  query = (): Promise<void> => Promise.resolve();
  on(event: string, cb: never): unknown {
    if (event === 'notification') this.handler = cb as never;
    return this;
  }
  end = (): Promise<void> => Promise.resolve();
}

function hubWith(
  views: AlertView[],
  opts: { replay?: AlertView[]; pingMs?: number } = {},
): { hub: StreamHub; listen: FakeListen } {
  const listen = new FakeListen();
  const db = {
    withScope: (_s: ScopeSettings, fn: (tx: unknown) => Promise<unknown>) =>
      fn({ query: () => Promise.resolve({ rows: [] }) }),
  } as unknown as KernelDb;
  const alerts = {
    replay: () => Promise.resolve(opts.replay ?? []),
    view: (_tx: unknown, id: string) => Promise.resolve(views.find((v) => v.alertId === id)),
  } as unknown as AlertService;
  const hub = new StreamHub({
    db,
    alerts,
    listen: () => listen,
    pingMs: opts.pingMs ?? 15_000,
    revalidateMs: 3_600_000,
  });
  return { hub, listen };
}
const who = (principal: string, session: string) => ({
  principalId: principal,
  sessionId: session,
  scope: scope(principal),
});

describe('event shapes (32.1, SEC-01 ST-2)', () => {
  test('an alert event carries exactly the closed field list, id: is the seq, and nothing else of the alert leaks', () => {
    const frame = alertEvent(
      view(7, { escalatesAt: '2030-01-01T00:10:00.000Z', escalationLevel: 0 }),
    );
    assert.match(frame, /^id: 7\nevent: alert\ndata: \{.*\}\n\n$/);
    const data = JSON.parse(/data: (.*)\n/.exec(frame)?.[1] as string) as Record<string, unknown>;
    assert.deepEqual(Object.keys(data).sort(), [...ALERT_EVENT_FIELDS].sort());
    for (const leak of [ID(900), ID(901), 'triage_assessment', 'patientId', 'acknowledgedBy'])
      assert.ok(!frame.includes(leak), leak);
    const hostile = {
      ...view(8),
      patientName: 'ZZ-PHI-CANARY',
      alertText: 'chest pain',
    } as AlertView;
    assert.ok(!alertEvent(hostile).includes('ZZ-PHI-CANARY'));
    assert.ok(!alertEvent(hostile).includes('chest pain'));
  });
  test('alert_closed carries alertId and seq only', () => {
    const f = alertClosedEvent(ID(5), 5);
    assert.equal(f, `event: alert_closed\ndata: {"alertId":"${ID(5)}","seq":5}\n\n`);
    assert.deepEqual(Object.keys(JSON.parse(/data: (.*)\n/.exec(f)?.[1] as string)), [
      ...ALERT_CLOSED_EVENT_FIELDS,
    ]);
  });
  test('the notification payload parser accepts IDs only and rejects anything else', () => {
    const ok = parsePayload(
      JSON.stringify({ alertId: ID(1), seq: 3, kind: 'closed', targets: [ID(2).toUpperCase()] }),
    );
    assert.deepEqual(ok, { alertId: ID(1), seq: 3, kind: 'closed', targets: [ID(2)] });
    assert.equal(parsePayload(JSON.stringify({ alertId: ID(1), seq: 3 }))?.kind, 'alert');
    assert.equal(
      parsePayload(JSON.stringify({ alertId: ID(1), seq: 3, broadcast: true }))?.targets,
      undefined,
    );
    for (const bad of [
      undefined,
      '',
      'not json',
      '{}',
      JSON.stringify({ alertId: 'x', seq: 1 }),
      JSON.stringify({ alertId: ID(1), seq: 'a' }),
      JSON.stringify({ alertId: ID(1), seq: 1, kind: 'x' }),
      JSON.stringify({ alertId: ID(1), seq: 1, targets: ['x'] }),
      'x'.repeat(8001),
    ])
      assert.equal(parsePayload(bad), undefined, String(bad));
  });
  test('Last-Event-ID: a number is the cursor; missing or malformed means every open alert', () => {
    assert.equal(parseLastEventId('42'), 42);
    assert.equal(parseLastEventId(['9']), 9);
    for (const v of [undefined, '', '-1', '1.5', 'abc', '1e3', '9'.repeat(16)])
      assert.equal(parseLastEventId(v), 0, String(v));
  });
});

describe('the hub (32.2, 32.3)', () => {
  test('a client that does not read is dropped, never buffered: nothing is written once its buffer is over 64 KB', async () => {
    const a = view(1);
    const { hub, listen } = hubWith([a]);
    await hub.start();
    const slow = new FakeRes();
    const fast = new FakeRes();
    await hub.attach(slow, who(ID(10), ID(20)), undefined);
    await hub.attach(fast, who(ID(11), ID(21)), undefined);
    slow.writableLength = WRITE_BUFFER_LIMIT; // the socket is not draining
    const written = slow.chunks.length;
    listen.handler?.({
      channel: 'staff_alert',
      payload: JSON.stringify({ alertId: a.alertId, seq: 1, kind: 'alert' }),
    });
    await hub.idle();
    assert.equal(slow.destroyed, true, 'connection destroyed');
    assert.equal(slow.chunks.length, written, 'no write after the limit');
    assert.equal(fast.destroyed, false);
    assert.match(fast.text(), /event: alert/);
    assert.equal(hub.count(), 1);
    await hub.stop();
  });

  test('3 streams per session and 10 per principal: the oldest is closed with event: closed', async () => {
    const { hub } = hubWith([]);
    const r = Array.from({ length: MAX_STREAMS_PER_SESSION + 1 }, () => new FakeRes());
    for (const x of r) await hub.attach(x, who(ID(10), ID(20)), undefined);
    assert.equal(r[0]?.ended, true);
    assert.match(r[0]?.text() ?? '', /event: closed/);
    assert.ok(r.slice(1).every((x) => !x.ended));
    const many = Array.from({ length: MAX_STREAMS_PER_PRINCIPAL + 1 }, () => new FakeRes());
    let n = 100;
    for (const x of many) await hub.attach(x, who(ID(11), ID(n++)), undefined);
    assert.equal(many[0]?.ended, true);
    assert.ok(many.slice(1).every((x) => !x.ended));
    await hub.stop();
  });

  test('ping every interval; drain and stop close every stream with event: closed', async () => {
    const { hub } = hubWith([], { pingMs: 15 });
    await hub.start();
    const a = new FakeRes();
    const b = new FakeRes();
    await hub.attach(a, who(ID(10), ID(20)), undefined);
    await hub.attach(b, who(ID(11), ID(21)), undefined);
    await new Promise((r) => setTimeout(r, 80));
    assert.ok((a.text().match(/event: ping/g) ?? []).length >= 2);
    await hub.stop();
    for (const x of [a, b]) {
      assert.match(x.text(), /event: closed\ndata: \{\}\n\n$/);
      assert.equal(x.ended, true);
    }
    assert.equal(hub.count(), 0);
  });

  test('more than 200 missed alerts: one resync event and no alert events', async () => {
    const many = Array.from({ length: 201 }, (_, i) => view(i + 1));
    const { hub } = hubWith([], { replay: many });
    const res = new FakeRes();
    await hub.attach(res, who(ID(10), ID(20)), undefined);
    assert.match(res.text(), /event: resync\ndata: \{\}\n\n/);
    assert.ok(!res.text().includes('event: alert'));
    await hub.stop();
  });

  test('a notification for a principal with no stream, and a malformed one, do nothing', async () => {
    const a = view(1);
    const { hub, listen } = hubWith([a]);
    await hub.start();
    const res = new FakeRes();
    await hub.attach(res, who(ID(10), ID(20)), undefined);
    const before = res.chunks.length;
    listen.handler?.({
      channel: 'staff_alert',
      payload: JSON.stringify({ alertId: a.alertId, seq: 1, kind: 'alert', targets: [ID(99)] }),
    });
    listen.handler?.({ channel: 'staff_alert', payload: 'garbage' });
    listen.handler?.({ channel: 'other', payload: '{}' });
    await hub.idle();
    assert.equal(res.chunks.length, before);
    await hub.stop();
  });

  test('a read that finds the alert not visible writes nothing (RLS decides; the payload is never trusted)', async () => {
    const { hub, listen } = hubWith([]); // the fake read returns undefined: the principal is not a target
    await hub.start();
    const res = new FakeRes();
    await hub.attach(res, who(ID(10), ID(20)), undefined);
    const before = res.chunks.length;
    listen.handler?.({
      channel: 'staff_alert',
      payload: JSON.stringify({ alertId: ID(555), seq: 9, kind: 'alert', broadcast: true }),
    });
    await hub.idle();
    assert.equal(res.chunks.length, before);
    await hub.stop();
  });
});
