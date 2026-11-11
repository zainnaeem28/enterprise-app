// `telehealth.close_meeting` against the in-memory video vendor stub: closed after the end of a visit, after the join window, once
// only per job key, a missing room counts as closed, and a vendor that keeps failing retries and then dies (the alarm's log line).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Task } from 'graphile-worker';
import { createLogger, type KernelDb, type Queue, type Tx } from '@ehr/kernel';
import { wrapTask } from '../../runner.js';
import { FakeVideoTransport } from './fake-transport.js';
import { runCloseMeeting } from './close-meeting.js';
import { createTelehealthTasks } from './index.js';
import { runOnReservationConfirmed } from './on-reservation-confirmed.js';
import { runOnVisitOver } from './on-visit-over.js';
import type { CloseOutcome, TelehealthJobDeps, TelehealthWorkerPort } from './ports.js';
import { VideoAdapter } from './video-adapter.js';

const RID = '0192abcd-1234-7abc-8def-0123456789a1';
const PID = '0192abcd-1234-7abc-8def-0123456789a2';
const SID = '0192abcd-1234-7abc-8def-0123456789a3';
const START = new Date('2026-12-01T10:00:00Z');
const END = new Date('2026-12-01T10:30:00Z');

type Occ = 'confirmed' | 'cancelled_patient' | 'no_show' | 'completed';

function world(opts: { now: Date; occ?: Occ; session?: 'open' | 'ended'; meeting?: boolean }) {
  const transport = new FakeVideoTransport();
  const adapter = new VideoAdapter(transport);
  const state = {
    occ: opts.occ ?? 'confirmed',
    session: opts.session ?? 'open',
    audits: [] as string[],
    jobs: new Map<string, { name: string; runAt: Date }>(),
  };
  transport.meetings.set(SID, { meetingId: 'mtg-1', ended: false, recording: false });
  const telehealth: TelehealthWorkerPort = {
    ensureSession: () =>
      Promise.resolve({
        outcome: 'created',
        sessionId: SID,
        startsAt: START.toISOString(),
        endsAt: END.toISOString(),
        hasMeeting: false,
      }),
    recordMeeting: () => Promise.resolve(true),
    staleSessions: () => Promise.resolve([]),
    endStale: () => Promise.resolve({ status: 'already', vendor: null, meetingId: null }),
    meetingToClose: (): Promise<CloseOutcome> => {
      if (opts.meeting === false) return Promise.resolve({ outcome: 'none' });
      const live = state.session === 'open';
      const windowClosed = opts.now.getTime() >= END.getTime() + 30 * 60_000;
      if (live && state.occ === 'confirmed' && !windowClosed)
        return Promise.resolve({ outcome: 'not_due' });
      if (live) {
        state.session = 'ended';
        state.audits.push('session_ended');
      }
      return Promise.resolve({
        outcome: 'close',
        sessionId: SID,
        vendor: 'sandboxvendor',
        meetingId: 'mtg-1',
      });
    },
    recordMeetingClosed: () => {
      state.audits.push('meeting_closed');
      return Promise.resolve();
    },
  };
  const queue = {
    enqueue: (_tx: Tx, name: string, _p: unknown, o: { runAt?: Date; jobKey?: string }) => {
      state.jobs.set(`${name}:${o.jobKey}`, { name, runAt: o.runAt as Date }); // replace mode
      return Promise.resolve();
    },
  } as unknown as Queue;
  const db = {
    withScope: (_s: unknown, fn: (tx: Tx) => unknown) => fn({} as Tx),
  } as unknown as KernelDb;
  const out: string[] = [];
  const log = createLogger({ sink: (l) => out.push(l) });
  const deps: TelehealthJobDeps = {
    db,
    orgId: '0192abcd-1234-7abc-8def-0123456789a0',
    queue,
    telehealth,
    log,
    now: () => opts.now,
    vendor: {
      callVendor: (_k, operation, args, corr) =>
        adapter.call({
          operation: operation as never,
          args: args ?? {},
          connection: { id: 'c', kind: 'video', vendor: 'sandboxvendor', settings: {} },
          credentials: { get: () => Promise.resolve('x') },
          idempotencyToken: corr?.idempotencyToken ?? 't',
          signal: new AbortController().signal,
        } as never),
    },
  };
  return { transport, state, deps, out };
}

const payload = { reservationId: RID, patientId: PID };
const ends = (t: FakeVideoTransport) => t.calls.filter((c) => c.op === 'end').length;

test('a cancelled or no-show visit brings the close forward to now, under the one job key', async () => {
  const w = world({ now: new Date('2026-12-01T09:00:00Z') });
  await runOnReservationConfirmed(w.deps, payload);
  const key = `telehealth.close_meeting:close_meeting_${RID}`;
  assert.equal(w.state.jobs.get(key)?.runAt.toISOString(), '2026-12-01T11:00:00.000Z');
  await runOnVisitOver(w.deps, payload, 'telehealth.on_no_show');
  assert.equal(w.state.jobs.get(key)?.runAt.toISOString(), '2026-12-01T09:00:00.000Z');
  assert.equal([...w.state.jobs.keys()].filter((k) => k.includes('close_meeting')).length, 1);
});

test('the room is closed at the vendor after a cancelled visit, and the close is audited', async () => {
  const w = world({ now: new Date('2026-12-01T09:00:00Z'), occ: 'cancelled_patient' });
  assert.equal(await runCloseMeeting(w.deps, payload), 'closed');
  assert.equal(w.transport.meetings.get(SID)?.ended, true);
  assert.deepEqual(w.state.audits, ['session_ended', 'meeting_closed']);
});

test('the room is closed after the join window, and not before it', async () => {
  const early = world({ now: new Date('2026-12-01T10:45:00Z') });
  assert.equal(await runCloseMeeting(early.deps, payload), 'not_due');
  assert.equal(ends(early.transport), 0);
  const late = world({ now: new Date('2026-12-01T11:00:00Z') });
  assert.equal(await runCloseMeeting(late.deps, payload), 'closed');
  assert.equal(late.transport.meetings.get(SID)?.ended, true);
});

test('a visit with no room is left alone', async () => {
  const w = world({ now: new Date('2026-12-01T12:00:00Z'), meeting: false });
  assert.equal(await runCloseMeeting(w.deps, payload), 'none');
  assert.equal(ends(w.transport), 0);
});

test('a room the vendor no longer has counts as closed', async () => {
  const w = world({ now: new Date('2026-12-01T12:00:00Z'), session: 'ended' });
  const end = w.transport.endMeeting.bind(w.transport);
  w.transport.endMeeting = async (i) => {
    await end(i);
    const { AdapterFailure } = await import('../integration-core/errors.js');
    throw new AdapterFailure(false, 404, 'not_found');
  };
  assert.equal(await runCloseMeeting(w.deps, payload), 'closed');
  assert.deepEqual(w.state.audits, ['meeting_closed']);
});

test('the queue holds one close job per reservation however many events ask for it', async () => {
  const w = world({ now: new Date('2026-12-01T12:00:00Z'), session: 'ended' });
  await runOnVisitOver(w.deps, payload, 'telehealth.on_reservation_cancelled');
  await runOnVisitOver(w.deps, payload, 'telehealth.on_no_show');
  assert.equal(w.state.jobs.size, 1);
});

test('vendor errors retry, and the last failed attempt is the job_dead line the alarm filters on', async () => {
  const w = world({ now: new Date('2026-12-01T12:00:00Z'), session: 'ended' });
  w.transport.unavailable = true;
  const task = createTelehealthTasks(w.deps)['telehealth.close_meeting'] as Task;
  for (const attempts of [1, 8]) {
    const out: string[] = [];
    const log = createLogger({ sink: (l) => out.push(l) });
    const run = async (): Promise<void> => {
      await wrapTask(
        'telehealth.close_meeting',
        task,
        log,
      )(payload, {
        job: { id: '7', attempts, max_attempts: 8 },
      } as never);
    };
    await assert.rejects(run());
    const dead = out
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.event === 'job_dead');
    assert.equal(dead.length, attempts === 8 ? 1 : 0);
    if (attempts === 8) assert.equal(dead[0]?.jobType, 'telehealth.close_meeting');
  }
  assert.equal(w.state.audits.includes('meeting_closed'), false);
  w.transport.unavailable = false;
  assert.equal(await runCloseMeeting(w.deps, payload), 'closed');
});
