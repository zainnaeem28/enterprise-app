// Recorded-response stub of the Chime SDK client: stub evidence only (no Chime emulator exists).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AwsConfigError, createLogger } from '@ehr/kernel';
import { CHIME_CLIENT_LIMITS, ChimeVideoVendor, selectChimeVideoVendor } from './chime-video.js';

const log = createLogger({ sink: () => undefined });
const req = {
  vendor: 'chime',
  meetingId: 'm-1',
  participantRef: '11111111-1111-4111-8111-111111111111',
  role: 'patient' as const,
  idempotencyToken: 't',
  ttlSeconds: 600,
};
function stub(h: (name: string, input: Record<string, unknown>) => unknown) {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  return {
    calls,
    send: async (c: { constructor: { name: string }; input: Record<string, unknown> }) => {
      calls.push({ name: c.constructor.name, input: c.input });
      const r = h(c.constructor.name, c.input);
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

test('join token: attendee is created for our participant id; the token is returned and nothing else is called', async () => {
  const s = stub(() => ({ Attendee: { AttendeeId: 'a-1', JoinToken: 'tok' } }));
  const g = await new ChimeVideoVendor(s, log).issueJoinToken(req);
  assert.deepEqual(g, { attendeeId: 'a-1', attendeeToken: 'tok' });
  assert.deepEqual(s.calls, [
    {
      name: 'CreateAttendeeCommand',
      input: { MeetingId: 'm-1', ExternalUserId: req.participantRef },
    },
  ]);
});

test('join token: wrong vendor, bad meeting id, empty answer and vendor errors all refuse', async () => {
  const ok = stub(() => ({ Attendee: { AttendeeId: 'a', JoinToken: 'x' } }));
  await assert.rejects(new ChimeVideoVendor(ok, log).issueJoinToken({ ...req, vendor: 'other' }));
  await assert.rejects(new ChimeVideoVendor(ok, log).issueJoinToken({ ...req, meetingId: 'a b' }));
  assert.equal(ok.calls.length, 0);
  await assert.rejects(
    new ChimeVideoVendor(
      stub(() => ({})),
      log,
    ).issueJoinToken(req),
  );
  await assert.rejects(
    new ChimeVideoVendor(
      stub(() => Object.assign(new Error('x'), { name: 'ForbiddenException' })),
      log,
    ).issueJoinToken(req),
  );
});

function capture() {
  const lines: { level: string; msg: string; fields: Record<string, unknown> }[] = [];
  const l = createLogger({
    sink: (e: string) => {
      const r = JSON.parse(e) as Record<string, unknown>;
      lines.push({ level: String(r['level']), msg: String(r['msg']), fields: r });
    },
    level: 'debug',
  });
  return { lines, l };
}

test('the port has no end-meeting call: closing a meeting is the worker job', () => {
  assert.equal(
    (ChimeVideoVendor.prototype as unknown as Record<string, unknown>)['endMeeting'],
    undefined,
  );
});

test('C1/C2: one vendor_call line per call with only the allowed keys; the token appears in no log line and no error', async () => {
  const TOKEN = 'SECRET-JOIN-TOKEN-0123456789';
  const { lines, l } = capture();
  const ok = new ChimeVideoVendor(
    stub(() => ({ Attendee: { AttendeeId: 'ATT-ID-1', JoinToken: TOKEN } })),
    l,
  );
  await ok.issueJoinToken(req);
  const bad = new ChimeVideoVendor(
    stub(() =>
      Object.assign(new Error(`vendor said ${TOKEN} m-1 ${req.participantRef}`), {
        name: 'ThrottlingException',
      }),
    ),
    l,
  );
  await assert.rejects(bad.issueJoinToken(req));
  const slow = new ChimeVideoVendor(
    stub(() => Object.assign(new Error('x'), { name: 'TimeoutError' })),
    l,
  );
  await assert.rejects(slow.issueJoinToken(req));
  const long = new ChimeVideoVendor(
    stub(() => ({ Attendee: { AttendeeId: 'a', JoinToken: TOKEN.repeat(500) } })),
    l,
  );
  await assert.rejects(long.issueJoinToken(req), (e: Error) => !e.message.includes(TOKEN));
  const empty = new ChimeVideoVendor(
    stub(() => ({ Attendee: { AttendeeId: 'a', JoinToken: '' } })),
    l,
  );
  await assert.rejects(empty.issueJoinToken(req));
  await assert.rejects(ok.issueJoinToken({ ...req, meetingId: 'a b' }));

  assert.deepEqual(
    lines.map((x) => `${x.level}|${x.fields['outcome']}|${x.fields['errorClass'] ?? ''}`),
    [
      'info|ok|',
      'warn|error|ThrottlingException',
      'warn|timeout|TimeoutError',
      'warn|rejected|',
      'warn|rejected|',
      'warn|rejected|',
    ],
  );
  for (const x of lines) {
    const keys = Object.keys(x.fields).filter((k) => !['time', 'ts', 'level', 'msg'].includes(k));
    assert.ok(
      keys.every((k) =>
        [
          'event',
          'kind',
          'vendor',
          'operation',
          'outcome',
          'latencyMs',
          'errorClass',
          'correlationId',
        ].includes(k),
      ),
      `unexpected keys: ${keys.join(',')}`,
    );
    assert.equal(x.fields['correlationId'], req.idempotencyToken);
  }
  const all = JSON.stringify(lines);
  for (const secret of [TOKEN, 'ATT-ID-1', req.participantRef, 'm-1', 'vendor said'])
    assert.ok(!all.includes(secret), `${secret} leaked into the log`);
});

test('selection: absent keeps the refusing port; half-set stops the start', () => {
  assert.equal(selectChimeVideoVendor({}, log), undefined);
  assert.throws(
    () => selectChimeVideoVendor({ EHR_CHIME_MEDIA_REGION: 'us-east-1' }, log),
    AwsConfigError,
  );
  assert.ok(
    selectChimeVideoVendor({ EHR_CHIME_MEDIA_REGION: 'us-east-1', AWS_REGION: 'us-east-1' }, log),
  );
});

test('client limits: bounded timeouts and attempts so a hung call cannot hold a join open', () => {
  assert.ok(CHIME_CLIENT_LIMITS.requestTimeout <= 10_000);
  assert.ok(CHIME_CLIENT_LIMITS.connectionTimeout < CHIME_CLIENT_LIMITS.requestTimeout);
  assert.ok(CHIME_CLIENT_LIMITS.maxAttempts <= 3);
});
