// Recorded-response stub of the Chime SDK client: stub evidence only (no Chime emulator exists).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AwsConfigError, createLogger } from '@ehr/kernel';
import { ChimeVideoVendor, selectChimeVideoVendor } from './chime-video.js';

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
  const g = await new ChimeVideoVendor(s).issueJoinToken(req);
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
  await assert.rejects(new ChimeVideoVendor(ok).issueJoinToken({ ...req, vendor: 'other' }));
  await assert.rejects(new ChimeVideoVendor(ok).issueJoinToken({ ...req, meetingId: 'a b' }));
  assert.equal(ok.calls.length, 0);
  await assert.rejects(new ChimeVideoVendor(stub(() => ({}))).issueJoinToken(req));
  await assert.rejects(
    new ChimeVideoVendor(
      stub(() => Object.assign(new Error('x'), { name: 'ForbiddenException' })),
    ).issueJoinToken(req),
  );
});

test('end meeting: an already-ended meeting is success; other errors surface', async () => {
  const nf = stub(() => Object.assign(new Error('x'), { name: 'NotFoundException' }));
  await new ChimeVideoVendor(nf).endMeeting({
    vendor: 'chime',
    meetingId: 'm-1',
    idempotencyToken: 't',
  });
  const bad = stub(() => Object.assign(new Error('x'), { name: 'ServiceFailureException' }));
  await assert.rejects(
    new ChimeVideoVendor(bad).endMeeting({
      vendor: 'chime',
      meetingId: 'm-1',
      idempotencyToken: 't',
    }),
  );
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
