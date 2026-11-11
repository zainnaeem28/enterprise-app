// Emulator evidence only (LocalStack SES v2): see docs/runbooks/AWS-ADAPTERS.md. Skipped unless EHR_EMULATOR_SES_ENDPOINT is set.
// End User Messaging SMS (pinpoint-sms-voice-v2) is not covered: LocalStack's community edition does not implement it, so the SMS
// provider has unit evidence only. Nothing here proves a behaviour of real AWS (sandbox, verified identities, bounces).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CreateEmailIdentityCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { SesEmailProvider, SesSecurityNotice } from './notify-adapters.js';

const endpoint = process.env['EHR_EMULATOR_SES_ENDPOINT'];
const skip = endpoint === undefined ? 'EHR_EMULATOR_SES_ENDPOINT not set' : false;

test('SES provider and security notice against the emulator', { skip }, async () => {
  const ses = new SESv2Client({ region: 'eu-west-2', endpoint });
  await ses.send(new CreateEmailIdentityCommand({ EmailIdentity: 'no-reply@example.org' }));
  const p = new SesEmailProvider(ses, 'no-reply@example.org');
  const sent = await p.send({
    to: 'person@example.org',
    subject: 'Hello',
    text: 'body',
    idempotencyToken: 'emulator-1',
    connection: { id: 'c', kind: 'email', vendor: 'ses', settings: {} },
    credentials: { get: () => Promise.reject(new Error('unused')) },
    signal: new AbortController().signal,
  });
  assert.ok(sent.messageId.length > 0);
  await new SesSecurityNotice(ses, 'no-reply@example.org', 'sec@example.org').notify({
    kind: 'credential_revoked',
    principalId: '0192e0aa-0000-7000-8000-000000000001',
    jobRef: 'job-1',
  });
});
