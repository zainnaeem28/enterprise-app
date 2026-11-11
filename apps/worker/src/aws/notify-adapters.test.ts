import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLogger } from '@ehr/kernel';
import { SendEmailCommand } from '@aws-sdk/client-sesv2';
import { SendTextMessageCommand } from '@aws-sdk/client-pinpoint-sms-voice-v2';
import {
  EndUserMessagingSmsProvider,
  notifyAdapters,
  selectNotifyWorkerInfra,
  SesEmailProvider,
  SesSecurityNotice,
  toProviderError,
  type Sender,
} from './notify-adapters.js';
import { ProviderError } from '../jobs/notifications/index.js';
import type { ProviderRequest } from '../jobs/notifications/adapters.js';

const log = createLogger({ sink: () => undefined });
const conn = { id: 'c', kind: 'email', vendor: 'ses', settings: {} };
const req = (o: Partial<ProviderRequest> = {}): ProviderRequest => ({
  to: 'p@example.org',
  subject: 'Hello',
  text: 'body',
  idempotencyToken: 'tok-1',
  connection: conn,
  credentials: { get: () => Promise.reject(new Error('unused')) },
  signal: new AbortController().signal,
  ...o,
});
const stub = (out: unknown | Error): { s: Sender; sent: unknown[] } => {
  const sent: unknown[] = [];
  return {
    sent,
    s: {
      send: (c) => {
        sent.push(c);
        return out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
      },
    },
  };
};
const awsErr = (name: string, status?: number): Error =>
  Object.assign(new Error('x'), {
    name,
    ...(status === undefined ? {} : { $metadata: { httpStatusCode: status } }),
  });

test('nothing configured -> no providers, no notice', () => {
  const r = selectNotifyWorkerInfra({}, log);
  assert.deepEqual(r, { providers: {} });
  assert.deepEqual(notifyAdapters(r.providers), []);
});

test('configured groups build providers; adapters declare no idempotency token', () => {
  const r = selectNotifyWorkerInfra(
    {
      AWS_REGION: 'eu-west-2',
      EHR_SES_FROM_ADDRESS: 'no-reply@example.org',
      EHR_SMS_ORIGINATION_IDENTITY: 'pool-1',
      EHR_SECURITY_CONTACT_EMAIL: 'sec@example.org',
    },
    log,
  );
  assert.ok(r.providers.email && r.providers.sms && r.securityNotice);
  const a = notifyAdapters(r.providers);
  assert.deepEqual(
    a.map((x) => [x.kind, x.supportsIdempotencyToken]),
    [
      ['email', false],
      ['sms', false],
    ],
  );
});

test('security contact without a from address fails the start', () => {
  assert.throws(
    () =>
      selectNotifyWorkerInfra(
        { AWS_REGION: 'r', EHR_SECURITY_CONTACT_EMAIL: 'sec@example.org' },
        log,
      ),
    /EHR_SES_FROM_ADDRESS/,
  );
});

test('a configured adapter without AWS_REGION, or with a bad address, fails the start', () => {
  assert.throws(
    () => selectNotifyWorkerInfra({ EHR_SES_FROM_ADDRESS: 'a@example.org' }, log),
    /AWS_REGION/,
  );
  assert.throws(
    () => selectNotifyWorkerInfra({ AWS_REGION: 'r', EHR_SES_FROM_ADDRESS: 'not an address' }, log),
    /not an e-mail address/,
  );
});

test('SES: simple send with from, to, tag and message id', async () => {
  const { s, sent } = stub({ MessageId: 'ses-1', $metadata: { httpStatusCode: 200 } });
  const r = await new SesEmailProvider(s, 'no-reply@example.org', 'cfg').send(req());
  assert.deepEqual(r, { messageId: 'ses-1', httpStatus: 200 });
  const c = sent[0] as SendEmailCommand;
  assert.ok(c instanceof SendEmailCommand);
  assert.equal(c.input.FromEmailAddress, 'no-reply@example.org');
  assert.deepEqual(c.input.Destination?.ToAddresses, ['p@example.org']);
  assert.equal(c.input.ConfigurationSetName, 'cfg');
  assert.deepEqual(c.input.EmailTags, [{ Name: 'ehr_ref', Value: 'tok-1' }]);
  assert.equal(c.input.Content?.Simple?.Body?.Text?.Data, 'body');
});

test('SES: attachments go as a raw MIME message', async () => {
  const { s, sent } = stub({ MessageId: 'ses-2' });
  await new SesEmailProvider(s, 'no-reply@example.org').send(
    req({ attachments: [{ filename: 'a.txt', contentType: 'text/plain', content: 'hi' }] }),
  );
  const raw = Buffer.from(
    (sent[0] as SendEmailCommand).input.Content?.Raw?.Data as Uint8Array,
  ).toString();
  assert.match(raw, /multipart\/mixed/);
  assert.match(raw, /Content-Disposition: attachment; filename="a\.txt"/);
  assert.match(raw, /To: p@example\.org/);
});

test('SES: error classes (throttle retryable, rejected not, no id not)', async () => {
  const send = (e: Error | object) => new SesEmailProvider(stub(e).s, 'a@example.org').send(req());
  await assert.rejects(
    send(awsErr('TooManyRequestsException', 429)),
    (e: ProviderError) => e.retryable && e.httpStatus === 429,
  );
  await assert.rejects(
    send(awsErr('MessageRejected', 400)),
    (e: ProviderError) => !e.retryable && e.errorClass === 'MessageRejected',
  );
  await assert.rejects(send(awsErr('InternalFailure', 500)), (e: ProviderError) => e.retryable);
  await assert.rejects(send(awsErr('Error')), (e: ProviderError) => e.retryable); // network: no status
  await assert.rejects(
    send({}),
    (e: ProviderError) => !e.retryable && e.errorClass === 'no_message_id',
  );
  assert.equal(
    toProviderError(Object.assign(new Error(), { name: 'bad name with spaces' })).errorClass,
    'provider_error',
  );
});

test('SMS: transactional text to the origination identity', async () => {
  const { s, sent } = stub({ MessageId: 'sms-1', $metadata: { httpStatusCode: 200 } });
  const r = await new EndUserMessagingSmsProvider(s, 'pool-1', 'cfg').send(
    req({ to: '+447700900123', text: 'code' }),
  );
  assert.equal(r.messageId, 'sms-1');
  const c = sent[0] as SendTextMessageCommand;
  assert.ok(c instanceof SendTextMessageCommand);
  assert.equal(c.input.OriginationIdentity, 'pool-1');
  assert.equal(c.input.DestinationPhoneNumber, '+447700900123');
  assert.equal(c.input.MessageType, 'TRANSACTIONAL');
  assert.equal(c.input.MessageBody, 'code');
  assert.deepEqual(c.input.Context, { ehr_ref: 'tok-1' });
  await assert.rejects(
    new EndUserMessagingSmsProvider(stub(awsErr('ValidationException', 400)).s, 'p').send(req()),
    (e: ProviderError) => !e.retryable,
  );
});

test('security notice: PHI-free fixed content to the configured contact', async () => {
  const { s, sent } = stub({ MessageId: 'm' });
  const n = new SesSecurityNotice(s, 'no-reply@example.org', 'sec@example.org');
  await n.notify({
    kind: 'credential_revoked',
    principalId: '0192e0aa-0000-7000-8000-000000000001',
    jobRef: 'job-1',
  });
  await n.notify({
    kind: 'bootstrap_run',
    jobRef: 'job-2',
    run: {
      mode: 'create',
      runId: 'r1',
      runRef: 'ci-9',
      ticketRef: 'T-1',
      tokenExpiresAt: '2026-01-01T00:00:00Z',
      principalIds: ['p1', 'p2'],
    },
  });
  const a = sent[0] as SendEmailCommand;
  assert.deepEqual(a.input.Destination?.ToAddresses, ['sec@example.org']);
  assert.equal(a.input.Content?.Simple?.Subject?.Data, '[EHR security notice] credential_revoked');
  assert.match(a.input.Content?.Simple?.Body?.Text?.Data ?? '', /Principal: 0192e0aa/);
  assert.match(
    (sent[1] as SendEmailCommand).input.Content?.Simple?.Body?.Text?.Data ?? '',
    /Ticket: T-1[\s\S]*Principal: p2/,
  );
  await assert.rejects(
    new SesSecurityNotice(
      stub(awsErr('Throttling', 400)).s,
      'a@example.org',
      'b@example.org',
    ).notify({
      kind: 'credential_revoked',
      principalId: 'x',
      jobRef: 'j',
    }),
  );
});

test('health checks call the cheap account read', async () => {
  const { s, sent } = stub({ $metadata: { httpStatusCode: 200 } });
  const sig = new AbortController().signal;
  assert.deepEqual(await new SesEmailProvider(s, 'a@example.org').health({ signal: sig }), {
    ok: true,
    httpStatus: 200,
  });
  assert.deepEqual(await new EndUserMessagingSmsProvider(s, 'p').health({ signal: sig }), {
    ok: true,
    httpStatus: 200,
  });
  assert.deepEqual(
    sent.map((c) => (c as { constructor: { name: string } }).constructor.name),
    ['GetAccountCommand', 'DescribeAccountAttributesCommand'],
  );
});
