// Notification providers on AWS (AWS-BE-3): SES v2 for e-mail, AWS End User Messaging SMS for text, and the security-contact notice of
// the identity worker (B2-9). Each is a `ProviderClient` behind the existing `EmailAdapter`/`SmsAdapter`, so integration-core's gateway
// keeps the log, retry and circuit and a vendor can be swapped by registering another ProviderClient. The PHI-free allowlist is enforced
// upstream (notifications render/allowlist); nothing here widens it. Selected by configuration like every AWS adapter: absent -> the
// gateway has no adapter and a call is refused ("no adapter"); partial -> startup fails.
import {
  GetAccountCommand,
  SendEmailCommand,
  SESv2Client,
  type MessageTag,
} from '@aws-sdk/client-sesv2';
import {
  DescribeAccountAttributesCommand,
  PinpointSMSVoiceV2Client,
  SendTextMessageCommand,
} from '@aws-sdk/client-pinpoint-sms-voice-v2';
import {
  AwsConfigError,
  awsSettings,
  selectByEnv,
  type AwsSettings,
  type Env,
  type Logger,
} from '@ehr/kernel';
import { EmailAdapter, ProviderError, SmsAdapter } from '../jobs/notifications/index.js';
import type { ProviderClient, ProviderRequest } from '../jobs/notifications/adapters.js';
import type { SecurityNotice, SecurityNoticePort } from '../jobs/identity/index.js';

export const SES_VARS = ['EHR_SES_FROM_ADDRESS'] as const;
export const SMS_VARS = ['EHR_SMS_ORIGINATION_IDENTITY'] as const;
export const SECURITY_CONTACT_VARS = ['EHR_SECURITY_CONTACT_EMAIL'] as const;

const ADDRESS = /^[^\s@<>()[\],;:\\"]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}$/;
const TAG_VALUE = /^[A-Za-z0-9_.@-]{1,256}$/;

const sesClient = (s: AwsSettings): SESv2Client =>
  new SESv2Client({
    region: s.region,
    ...(s.endpoint === undefined ? {} : { endpoint: s.endpoint }),
  });
const smsClient = (s: AwsSettings): PinpointSMSVoiceV2Client =>
  new PinpointSMSVoiceV2Client({
    region: s.region,
    ...(s.endpoint === undefined ? {} : { endpoint: s.endpoint }),
  });

/** The send surface of both SDK clients, so tests inject a stub. */
export interface Sender {
  send(command: unknown, opts?: { abortSignal?: AbortSignal }): Promise<unknown>;
}

/** Throttling, 5xx and network failures are retried by the gateway; every other 4xx (rejected, unverified, access denied) is not. */
export function toProviderError(e: unknown): ProviderError {
  const o = (e ?? {}) as {
    name?: unknown;
    $metadata?: { httpStatusCode?: number };
    $retryable?: unknown;
  };
  const status = o.$metadata?.httpStatusCode;
  const name =
    typeof o.name === 'string' && /^[A-Za-z0-9]{1,80}$/.test(o.name) ? o.name : 'provider_error';
  const throttled = /Throttl|TooManyRequests|LimitExceeded|ServiceUnavailable|InternalServer/.test(
    name,
  );
  const retryable =
    throttled ||
    status === undefined ||
    status >= 500 ||
    status === 429 ||
    o.$retryable !== undefined;
  return new ProviderError(retryable, status, name);
}

const b64Lines = (s: string): string =>
  (
    Buffer.from(s, 'utf8')
      .toString('base64')
      .match(/.{1,76}/g) ?? []
  ).join('\r\n');

/** RFC 5322 raw message for the (<= 2) attachment case; SES simple content cannot carry attachments. */
function rawMessage(from: string, req: ProviderRequest): Buffer {
  const boundary = `ehr_${req.idempotencyToken.replace(/[^A-Za-z0-9]/g, '').slice(0, 32)}_${Date.now().toString(36)}`;
  const parts = [
    `From: ${from}`,
    `To: ${req.to}`,
    `Subject: =?UTF-8?B?${Buffer.from(req.subject ?? '', 'utf8').toString('base64')}?=`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64Lines(req.text),
  ];
  for (const a of req.attachments ?? [])
    parts.push(
      `--${boundary}`,
      `Content-Type: ${a.contentType}; name="${a.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${a.filename}"`,
      '',
      b64Lines(a.content),
    );
  parts.push(`--${boundary}--`, '');
  return Buffer.from(parts.join('\r\n'), 'utf8');
}

export class SesEmailProvider implements ProviderClient {
  constructor(
    private readonly ses: Sender,
    private readonly from: string,
    private readonly configurationSet?: string,
  ) {}

  async send(req: ProviderRequest): Promise<{ messageId: string; httpStatus?: number }> {
    const tags: MessageTag[] = TAG_VALUE.test(req.idempotencyToken)
      ? [{ Name: 'ehr_ref', Value: req.idempotencyToken }]
      : [];
    const attachments = req.attachments ?? [];
    try {
      const out = (await this.ses.send(
        new SendEmailCommand({
          FromEmailAddress: this.from,
          Destination: { ToAddresses: [req.to] },
          Content:
            attachments.length > 0
              ? { Raw: { Data: rawMessage(this.from, req) } }
              : {
                  Simple: {
                    Subject: { Data: req.subject ?? '', Charset: 'UTF-8' },
                    Body: { Text: { Data: req.text, Charset: 'UTF-8' } },
                  },
                },
          ...(this.configurationSet === undefined
            ? {}
            : { ConfigurationSetName: this.configurationSet }),
          EmailTags: tags,
        }),
        { abortSignal: req.signal },
      )) as { MessageId?: string; $metadata?: { httpStatusCode?: number } };
      if (out.MessageId === undefined || out.MessageId === '')
        throw new ProviderError(false, out.$metadata?.httpStatusCode, 'no_message_id');
      return {
        messageId: out.MessageId,
        ...(out.$metadata?.httpStatusCode === undefined
          ? {}
          : { httpStatus: out.$metadata.httpStatusCode }),
      };
    } catch (e) {
      throw e instanceof ProviderError ? e : toProviderError(e);
    }
  }

  async health(req: { signal: AbortSignal }): Promise<{ ok: boolean; httpStatus?: number }> {
    const out = (await this.ses.send(new GetAccountCommand({}), { abortSignal: req.signal })) as {
      $metadata?: { httpStatusCode?: number };
    };
    return {
      ok: true,
      ...(out.$metadata?.httpStatusCode === undefined
        ? {}
        : { httpStatus: out.$metadata.httpStatusCode }),
    };
  }
}

export class EndUserMessagingSmsProvider implements ProviderClient {
  constructor(
    private readonly sms: Sender,
    private readonly originationIdentity: string,
    private readonly configurationSet?: string,
  ) {}

  async send(req: ProviderRequest): Promise<{ messageId: string; httpStatus?: number }> {
    try {
      const out = (await this.sms.send(
        new SendTextMessageCommand({
          DestinationPhoneNumber: req.to,
          OriginationIdentity: this.originationIdentity,
          MessageBody: req.text,
          MessageType: 'TRANSACTIONAL',
          ...(this.configurationSet === undefined
            ? {}
            : { ConfigurationSetName: this.configurationSet }),
          ...(TAG_VALUE.test(req.idempotencyToken)
            ? { Context: { ehr_ref: req.idempotencyToken } }
            : {}),
        }),
        { abortSignal: req.signal },
      )) as { MessageId?: string; $metadata?: { httpStatusCode?: number } };
      if (out.MessageId === undefined || out.MessageId === '')
        throw new ProviderError(false, out.$metadata?.httpStatusCode, 'no_message_id');
      return {
        messageId: out.MessageId,
        ...(out.$metadata?.httpStatusCode === undefined
          ? {}
          : { httpStatus: out.$metadata.httpStatusCode }),
      };
    } catch (e) {
      throw e instanceof ProviderError ? e : toProviderError(e);
    }
  }

  async health(req: { signal: AbortSignal }): Promise<{ ok: boolean; httpStatus?: number }> {
    const out = (await this.sms.send(new DescribeAccountAttributesCommand({}), {
      abortSignal: req.signal,
    })) as { $metadata?: { httpStatusCode?: number } };
    return {
      ok: true,
      ...(out.$metadata?.httpStatusCode === undefined
        ? {}
        : { httpStatus: out.$metadata.httpStatusCode }),
    };
  }
}

/**
 * The PHI-free notice to the security contact mailbox (B2-9): a kind, IDs and references, never a name or credential detail. Sent straight
 * through SES to one configured mailbox (not through the gateway: the contact is configuration, not a patient or staff address). SES does
 * not de-duplicate, so a retried job may send a second copy; the notice carries the job reference so a duplicate is recognisable.
 */
export class SesSecurityNotice implements SecurityNoticePort {
  constructor(
    private readonly ses: Sender,
    private readonly from: string,
    private readonly contact: string,
    private readonly configurationSet?: string,
  ) {}

  async notify(n: SecurityNotice): Promise<void> {
    const lines = [`Event: ${n.kind}`, `Job reference: ${n.jobRef}`];
    if (n.kind === 'bootstrap_run') {
      lines.push(
        `Mode: ${n.run.mode}`,
        `Run: ${n.run.runId}`,
        `CI run: ${n.run.runRef}`,
        `Ticket: ${n.run.ticketRef}`,
        `Token expires: ${n.run.tokenExpiresAt}`,
        ...n.run.principalIds.map((p) => `Principal: ${p}`),
      );
    } else lines.push(`Principal: ${n.principalId}`);
    lines.push(
      '',
      'No clinical or personal data is in this message. Review the event in the admin audit log.',
    );
    try {
      await this.ses.send(
        new SendEmailCommand({
          FromEmailAddress: this.from,
          Destination: { ToAddresses: [this.contact] },
          Content: {
            Simple: {
              Subject: { Data: `[EHR security notice] ${n.kind}`, Charset: 'UTF-8' },
              Body: { Text: { Data: lines.join('\n'), Charset: 'UTF-8' } },
            },
          },
          ...(this.configurationSet === undefined
            ? {}
            : { ConfigurationSetName: this.configurationSet }),
          EmailTags: [
            { Name: 'ehr_kind', Value: 'security_notice' },
            ...(TAG_VALUE.test(n.jobRef) ? [{ Name: 'ehr_ref', Value: n.jobRef }] : []),
          ],
        }),
      );
    } catch (e) {
      throw toProviderError(e); // the job retries and dead-letters; the audit row and alert are untouched (S1)
    }
  }
}

export interface NotifyWorkerInfra {
  providers: { email?: ProviderClient; sms?: ProviderClient };
  securityNotice?: SecurityNoticePort;
}

function checkAddress(adapter: string, name: string, v: string): string {
  if (!ADDRESS.test(v))
    throw new AwsConfigError(`${adapter} (${name} is not an e-mail address)`, [], []);
  return v;
}

export function selectNotifyWorkerInfra(env: Env, log: Logger): NotifyWorkerInfra {
  const out: NotifyWorkerInfra = { providers: {} };
  const configSet = (name: string): string | undefined => (env[name] ?? '').trim() || undefined;

  const from = selectByEnv({
    adapter: 'e-mail (SES)',
    env,
    vars: SES_VARS,
    log,
    build: (v) => {
      const settings = awsSettings(env, 'e-mail (SES)');
      const a = checkAddress(
        'e-mail (SES)',
        'EHR_SES_FROM_ADDRESS',
        v['EHR_SES_FROM_ADDRESS'] as string,
      );
      return {
        address: a,
        client: sesClient(settings),
        set: configSet('EHR_SES_CONFIGURATION_SET'),
      };
    },
  });
  if (from !== undefined)
    out.providers.email = new SesEmailProvider(from.client, from.address, from.set);

  const sms = selectByEnv({
    adapter: 'SMS (End User Messaging)',
    env,
    vars: SMS_VARS,
    log,
    build: (v) => ({
      identity: v['EHR_SMS_ORIGINATION_IDENTITY'] as string,
      client: smsClient(awsSettings(env, 'SMS (End User Messaging)')),
      set: configSet('EHR_SMS_CONFIGURATION_SET'),
    }),
  });
  if (sms !== undefined)
    out.providers.sms = new EndUserMessagingSmsProvider(sms.client, sms.identity, sms.set);

  const notice = selectByEnv({
    adapter: 'security notice (SES)',
    env,
    vars: SECURITY_CONTACT_VARS,
    log,
    build: (v) => {
      if (from === undefined)
        throw new AwsConfigError(
          'security notice (SES)',
          ['EHR_SES_FROM_ADDRESS'],
          ['EHR_SECURITY_CONTACT_EMAIL'],
        );
      return new SesSecurityNotice(
        from.client,
        from.address,
        checkAddress(
          'security notice (SES)',
          'EHR_SECURITY_CONTACT_EMAIL',
          v['EHR_SECURITY_CONTACT_EMAIL'] as string,
        ),
        from.set,
      );
    },
  });
  if (notice !== undefined) out.securityNotice = notice;
  return out;
}

/** The gateway adapters for the configured providers. SES and End User Messaging do not accept our idempotency token or look a message up. */
export function notifyAdapters(p: NotifyWorkerInfra['providers']): (EmailAdapter | SmsAdapter)[] {
  const out: (EmailAdapter | SmsAdapter)[] = [];
  if (p.email !== undefined)
    out.push(new EmailAdapter(p.email, { supportsIdempotencyToken: false }));
  if (p.sms !== undefined) out.push(new SmsAdapter(p.sms, { supportsIdempotencyToken: false }));
  return out;
}
