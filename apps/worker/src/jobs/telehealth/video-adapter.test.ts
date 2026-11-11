import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CredentialReader, VendorCall } from '../integration-core/adapters.js';
import { AdapterFailure } from '../integration-core/errors.js';
import { FakeVideoTransport } from './fake-transport.js';
import { TELEHEALTH_JOBS } from './jobs.js';
import { MAX_TTL_SECONDS, MIN_TTL_SECONDS, VideoAdapter } from './video-adapter.js';

const SESSION = '0192abcd-1234-7abc-8def-0123456789ab';
const PART = '0192abcd-1234-7abc-8def-0123456789ac';
const creds: CredentialReader = { get: () => Promise.resolve('CRED-CANARY') };

function harness(opts: { token?: boolean } = {}) {
  const transport = new FakeVideoTransport({ supportsIdempotencyToken: opts.token ?? true });
  const adapter = new VideoAdapter(transport);
  const call = (operation: string, args: Record<string, unknown>, token = 'idem-token-1') =>
    adapter.call({
      operation: operation as never,
      args,
      connection: { id: 'c', kind: 'video', vendor: 'sandboxvendor', settings: {} },
      credentials: creds,
      idempotencyToken: token,
      signal: new AbortController().signal,
    } satisfies VendorCall as never);
  return { transport, adapter, call };
}

test('create_meeting: recording is off, and asking for it is refused before the vendor is touched', async () => {
  const h = harness();
  const ok = await h.call('create_meeting', { externalId: SESSION, recording: false });
  assert.equal((ok.data as { vendor: string }).vendor, 'sandboxvendor');
  assert.equal(h.transport.calls.at(0)?.recording, false);
  for (const recording of [true, 'true', 1, null]) {
    await assert.rejects(
      h.call('create_meeting', { externalId: SESSION, recording }),
      (e: unknown) =>
        e instanceof AdapterFailure && e.errorClass === 'bad_argument' && !e.retryable,
    );
  }
  assert.equal(h.transport.calls.filter((c) => c.op === 'create').length, 1);
  // not asking is the default, and the transport is told false
  await h.call('create_meeting', { externalId: SESSION }, 'idem-token-2');
  assert.ok(h.transport.calls.filter((c) => c.op === 'create').every((c) => c.recording === false));
});

test('create_meeting: the same idempotency token answers with the same room', async () => {
  const h = harness();
  const a = await h.call('create_meeting', { externalId: SESSION }, 'same-token-1');
  const b = await h.call('create_meeting', { externalId: SESSION }, 'same-token-1');
  assert.equal(
    (a.data as { meetingId: string }).meetingId,
    (b.data as { meetingId: string }).meetingId,
  );
});

test('find: a vendor without a token is asked for the room by our external ID', async () => {
  const h = harness({ token: false });
  assert.equal(h.adapter.supportsIdempotencyToken, false);
  const req = (operation: string) =>
    ({
      operation,
      args: { externalId: SESSION },
      connection: { id: 'c', kind: 'video', vendor: 'v', settings: {} },
      credentials: creds,
      idempotencyToken: 'idem-token-3',
      signal: new AbortController().signal,
    }) as never;
  assert.equal(await h.adapter.find(req('create_meeting')), null);
  const made = await h.adapter.call(req('create_meeting'));
  const found = await h.adapter.find(req('create_meeting'));
  assert.equal(
    (found?.data as { meetingId: string }).meetingId,
    (made.data as { meetingId: string }).meetingId,
  );
  assert.equal(await h.adapter.find(req('join_token')), null);
});

test('join_token: unique per call, bounded life, the token only in data, a participant reference that is an opaque UUID', async () => {
  const h = harness();
  const room = await h.call('create_meeting', { externalId: SESSION });
  const meetingId = (room.data as { meetingId: string }).meetingId;
  const a = await h.call(
    'join_token',
    { meetingId, participantRef: PART, ttlSeconds: 300 },
    'tok-idem-1',
  );
  const b = await h.call(
    'join_token',
    { meetingId, participantRef: PART, ttlSeconds: 300 },
    'tok-idem-2',
  );
  const ta = (a.data as { attendeeToken: string }).attendeeToken;
  const tb = (b.data as { attendeeToken: string }).attendeeToken;
  assert.notEqual(ta, tb);
  // the call log keeps vendorRef: it is the meeting, never a credential
  assert.equal(a.vendorRef, meetingId);
  assert.ok(!JSON.stringify({ ref: a.vendorRef, status: a.httpStatus }).includes(ta));
  for (const ttlSeconds of [
    MIN_TTL_SECONDS - 1,
    MAX_TTL_SECONDS + 1,
    0,
    -5,
    30.5,
    '300',
    undefined,
  ])
    await assert.rejects(
      h.call('join_token', { meetingId, participantRef: PART, ttlSeconds }),
      (e: unknown) => e instanceof AdapterFailure && e.errorClass === 'bad_argument',
    );
  for (const participantRef of ['Jane Doe', 'jane@example.com', '', 5, undefined])
    await assert.rejects(
      h.call('join_token', { meetingId, participantRef, ttlSeconds: 300 }),
      (e: unknown) => e instanceof AdapterFailure && e.errorClass === 'bad_argument',
    );
});

test('a vendor outage is a retryable failure that carries a class and a status and no vendor text', async () => {
  const h = harness();
  h.transport.unavailable = true;
  await assert.rejects(
    h.call('create_meeting', { externalId: SESSION }),
    (e: unknown) =>
      e instanceof AdapterFailure &&
      e.retryable &&
      e.httpStatus === 503 &&
      e.message === 'vendor_unavailable',
  );
  // a transport that throws something else is treated the same, and its message is dropped
  const odd = new VideoAdapter({
    ...new FakeVideoTransport(),
    supportsIdempotencyToken: true,
    createMeeting: () => Promise.reject(new Error('Bearer SECRET-FROM-VENDOR')),
  } as never);
  await assert.rejects(
    odd.call({
      operation: 'create_meeting',
      args: { externalId: SESSION },
      connection: { id: 'c', kind: 'video', vendor: 'v', settings: {} },
      credentials: creds,
      idempotencyToken: 'idem-token-9',
      signal: new AbortController().signal,
    } as never),
    (e: unknown) =>
      e instanceof AdapterFailure && e.retryable && !String(e.message).includes('SECRET'),
  );
  h.transport.unavailable = false;
  assert.deepEqual(await h.adapter.healthCheck({ signal: new AbortController().signal }), {
    ok: true,
  });
  h.transport.unavailable = true;
  assert.deepEqual(await h.adapter.healthCheck({ signal: new AbortController().signal }), {
    ok: false,
  });
});

test('end_meeting and lookup_meeting', async () => {
  const h = harness();
  const room = await h.call('create_meeting', { externalId: SESSION });
  const meetingId = (room.data as { meetingId: string }).meetingId;
  assert.deepEqual((await h.call('end_meeting', { meetingId })).data, { ended: true });
  assert.equal(h.transport.meetings.get(SESSION)?.ended, true);
  assert.equal((await h.call('lookup_meeting', { externalId: PART })).data, null);
  await assert.rejects(h.call('end_meeting', { meetingId: 'has space' }), AdapterFailure);
});

test('the job list is pinned (the API side pins the same one)', () => {
  assert.deepEqual(
    TELEHEALTH_JOBS.map(
      (j) => `${j.name}|${j.jobClass}|${j.jobScope}|${j.onMerged}|${j.maxAttempts}`,
    ),
    [
      'telehealth.on_reservation_confirmed|handler|patients|resolve|5',
      'telehealth.create_meeting|job|patients|resolve|8',
      'telehealth.close_meeting|job|patients|resolve|8',
      'telehealth.end_stale|system|org|none|3',
    ],
  );
});
