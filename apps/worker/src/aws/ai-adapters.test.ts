// Chime / GuardDuty / Textract adapters against RECORDED-RESPONSE STUBS of the SDK client. Stub evidence only: no Chime, GuardDuty or
// Textract emulator exists, so nothing here shows the real service behaves this way (go-live checklist).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AwsConfigError, createLogger } from '@ehr/kernel';
import { AdapterFailure } from '../jobs/integration-core/errors.js';
import { ChimeVideoTransport, selectChimeVideoAdapter } from './chime-video.js';
import {
  GUARDDUTY_TAG,
  S3TagScanClient,
  guardDutyScanCaller,
  selectGuardDutyScanner,
} from './guardduty-scan.js';
import { TextractOcrClient, classifyText, selectTextractAdapter } from './textract-ocr.js';

const log = createLogger({ sink: () => undefined });
type Call = { name: string; input: Record<string, unknown> };
function stub(h: (c: Call) => unknown): { send: (c: never) => Promise<unknown>; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const c = { name: cmd.constructor.name, input: cmd.input };
      calls.push(c);
      const r = h(c);
      if (r instanceof Error) throw r;
      return r;
    },
  } as never;
}
const sdkError = (name: string, status: number): Error =>
  Object.assign(new Error('vendor body with a secret'), {
    name,
    $metadata: { httpStatusCode: status },
  });
const sig = new AbortController().signal;

test('chime: create uses the idempotency token, no recording, media region; attendee uses our participant id', async () => {
  const s = stub((c) =>
    c.name === 'CreateMeetingCommand'
      ? { Meeting: { MeetingId: 'm-1' } }
      : { Attendee: { AttendeeId: 'a-1', JoinToken: 'tok' } },
  );
  const t = new ChimeVideoTransport(s as never, 'us-east-1');
  assert.deepEqual(
    await t.createMeeting({
      externalId: 'e',
      idempotencyToken: 'idem',
      recording: false,
      signal: sig,
    }),
    { meetingId: 'm-1' },
  );
  assert.deepEqual(
    await t.createAttendee({
      meetingId: 'm-1',
      externalUserId: 'p',
      ttlSeconds: 60,
      idempotencyToken: 'i',
      signal: sig,
    }),
    { attendeeId: 'a-1', joinToken: 'tok' },
  );
  const create = s.calls[0]?.input;
  assert.equal(create?.['ClientRequestToken'], 'idem');
  assert.equal(create?.['MediaRegion'], 'us-east-1');
  assert.equal(s.calls[1]?.input['ExternalUserId'], 'p');
  assert.equal(await t.findMeeting(), null);
  assert.ok(s.calls.every((c) => !/pipeline|capture/i.test(c.name)));
});

test('chime: errors carry class and status only; 404 on end is success; ping needs 404 or ok', async () => {
  const bodyless = async (name: string, status: number): Promise<AdapterFailure> => {
    const t = new ChimeVideoTransport(stub(() => sdkError(name, status)) as never, 'us-east-1');
    const e = await t
      .createAttendee({
        meetingId: 'm',
        externalUserId: 'p',
        ttlSeconds: 60,
        idempotencyToken: 'i',
        signal: sig,
      })
      .catch((x: unknown) => x);
    assert.ok(e instanceof AdapterFailure);
    assert.ok(
      !JSON.stringify(e).includes('secret') && !String((e as Error).message).includes('secret'),
    );
    return e;
  };
  assert.equal((await bodyless('ThrottlingException', 429)).retryable, true);
  assert.equal((await bodyless('ForbiddenException', 403)).retryable, false);
  const gone = new ChimeVideoTransport(
    stub(() => sdkError('NotFoundException', 404)) as never,
    'r',
  );
  await gone.endMeeting({ meetingId: 'm', idempotencyToken: 'i', signal: sig });
  assert.equal(await gone.ping({ signal: sig }), true);
  const denied = new ChimeVideoTransport(
    stub(() => sdkError('ForbiddenException', 403)) as never,
    'r',
  );
  assert.equal(await denied.ping({ signal: sig }), false);
});

test('guardduty: tag maps to clean/infected; missing tag is pending; other values and outages are never clean', async () => {
  const caller = (h: () => unknown) =>
    guardDutyScanCaller(new S3TagScanClient(stub(h) as never, { quarantine: 'qb', clean: 'cb' }));
  const key = 'q/' + 'a'.repeat(32);
  const withTag = (v: string) => () => ({
    TagSet: [
      { Key: 'other', Value: 'x' },
      { Key: GUARDDUTY_TAG, Value: v },
    ],
  });
  assert.equal(await caller(withTag('NO_THREATS_FOUND'))('quarantine', key), 'clean');
  assert.equal(await caller(withTag('THREATS_FOUND'))('quarantine', key), 'infected');
  for (const v of ['UNSUPPORTED', 'ACCESS_DENIED', 'FAILED', 'clean', ''])
    assert.equal(await caller(withTag(v))('quarantine', key), 'error', v);
  assert.equal(await caller(() => ({ TagSet: [] }))('quarantine', key), 'pending');
  assert.equal(await caller(() => ({}))('quarantine', key), 'pending');
  await assert.rejects(caller(() => sdkError('InternalError', 500))('quarantine', key));
  const s = stub(withTag('NO_THREATS_FOUND'));
  await guardDutyScanCaller(new S3TagScanClient(s as never, { quarantine: 'qb', clean: 'cb' }))(
    'clean',
    'c/' + 'b'.repeat(32),
  );
  assert.equal(s.calls[0]?.input['Bucket'], 'cb');
});

test('textract: classifies by phrase, unreadable files give no suggestion, text never returned', async () => {
  const lines = (...t: string[]) => ({
    Blocks: [{ BlockType: 'PAGE' }, ...t.map((Text) => ({ BlockType: 'LINE', Text }))],
    $metadata: { requestId: 'rq' },
  });
  const c = (h: () => unknown) =>
    new TextractOcrClient(stub(h) as never, { quarantine: 'qb', clean: 'cb' });
  const r = await c(() => lines('ACME Health', 'Member ID 123', 'Group No 9')).classify({
    bucket: 'clean',
    key: 'c/x',
    signal: sig,
  });
  assert.deepEqual(r, { documentType: 'insurance_card', vendorRef: 'rq' });
  assert.equal(classifyText('Passport of someone'), 'id_document');
  assert.equal(classifyText('I consent. Signature: __'), 'consent');
  assert.equal(classifyText('consent without anything else'), null);
  assert.equal(classifyText('a shopping list'), null);
  const un = await c(() => sdkError('UnsupportedDocumentException', 400)).classify({
    bucket: 'clean',
    key: 'c/x',
    signal: sig,
  });
  assert.equal(un.documentType, null);
  await assert.rejects(
    c(() => sdkError('ProvisionedThroughputExceededException', 400)).classify({
      bucket: 'clean',
      key: 'c/x',
      signal: sig,
    }),
    (e: { retryable?: boolean; message: string }) =>
      e.message === 'ProvisionedThroughputExceededException' && e.retryable === false,
  );
  await assert.rejects(
    c(() => sdkError('ThrottlingException', 429)).classify({
      bucket: 'clean',
      key: 'c/x',
      signal: sig,
    }),
    (e: { retryable?: boolean }) => e.retryable === true,
  );
  const s = stub(() => lines('x'));
  await new TextractOcrClient(s as never, { quarantine: 'qb', clean: 'cb' }).classify({
    bucket: 'quarantine',
    key: 'q/x',
    signal: sig,
  });
  assert.deepEqual(s.calls[0]?.input['Document'], { S3Object: { Bucket: 'qb', Name: 'q/x' } });
});

test('selection: nothing set keeps refusing; half-set or bad value stops the start', () => {
  assert.equal(selectChimeVideoAdapter({}, log), undefined);
  assert.equal(selectGuardDutyScanner({}, log), undefined);
  assert.equal(selectTextractAdapter({}, log), undefined);
  assert.throws(
    () => selectChimeVideoAdapter({ EHR_CHIME_MEDIA_REGION: 'us-east-1' }, log),
    AwsConfigError,
  );
  assert.throws(
    () => selectChimeVideoAdapter({ EHR_CHIME_MEDIA_REGION: 'nope', AWS_REGION: 'us-east-1' }, log),
    /region/,
  );
  assert.throws(() => selectGuardDutyScanner({ EHR_MALWARE_SCAN: 'other' }, log), AwsConfigError);
  assert.throws(
    () => selectGuardDutyScanner({ EHR_MALWARE_SCAN: 'guardduty' }, log),
    AwsConfigError,
  );
  assert.throws(
    () => selectTextractAdapter({ EHR_OCR: 'textract', AWS_REGION: 'us-east-1' }, log),
    AwsConfigError,
  );
  const env = {
    EHR_S3_DOCS_QUARANTINE_BUCKET: 'q',
    EHR_S3_DOCS_CLEAN_BUCKET: 'c',
    AWS_REGION: 'us-east-1',
  };
  assert.equal(
    typeof selectGuardDutyScanner({ ...env, EHR_MALWARE_SCAN: 'guardduty' }, log),
    'function',
  );
  assert.equal(selectTextractAdapter({ ...env, EHR_OCR: 'textract' }, log)?.kind, 'ocr');
  assert.equal(
    selectChimeVideoAdapter({ AWS_REGION: 'us-east-1', EHR_CHIME_MEDIA_REGION: 'us-east-1' }, log)
      ?.kind,
    'video',
  );
});
