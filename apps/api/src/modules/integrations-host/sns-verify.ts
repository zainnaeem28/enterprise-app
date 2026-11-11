// Amazon SNS HTTPS message verification (ARCHITECTURE 25.7, 29.5; AWS-ADAPTERS.md "Receipts"). Pure of persistence: given the raw
// request bytes it returns what the message is, or why it is refused. The rules, in order of cost:
//   1. the body is a JSON object with the fields SNS sends; `SignatureVersion` must be "2" (SHA256). Version "1" (SHA1) is refused;
//   2. `TopicArn` is on the configured allowlist (an SNS topic anyone can create must not be able to post here);
//   3. `SigningCertURL` is https, host exactly `sns.<region>.amazonaws.com` (region from configuration), no port, no credentials,
//      path `/SimpleNotificationService-<id>.pem`, no query;
//   4. `Timestamp` is inside the window (not stale, not from the future);
//   5. the certificate (fetched through an injected function, cached) is inside its validity period, is RSA, and chains to a
//      configured trust anchor when anchors are configured;
//   6. the RSA-SHA256 signature over the canonical string verifies.
// Nothing from a message is logged here. A refusal carries a fixed reason, never message content.
import { createVerify, X509Certificate } from 'node:crypto';

export type SnsType = 'Notification' | 'SubscriptionConfirmation' | 'UnsubscribeConfirmation';

export interface SnsMessage {
  type: SnsType;
  messageId: string;
  topicArn: string;
  message: string;
  timestamp: string;
  subscribeUrl?: string;
  token?: string;
}

export type SnsRefusal =
  | 'malformed'
  | 'signature_version'
  | 'topic_not_allowed'
  | 'cert_url'
  | 'stale_timestamp'
  | 'cert_unavailable'
  | 'cert_invalid'
  | 'bad_signature';

export type SnsVerdict = { ok: true; message: SnsMessage } | { ok: false; reason: SnsRefusal };

export interface SnsVerifierConfig {
  /** AWS Region of the SNS endpoint; pins the signing-certificate and subscribe-URL host. */
  region: string;
  /** TopicArn allowlist. */
  topicArns: ReadonlySet<string>;
  /** Returns the PEM text of a signing certificate. The URL has already been pinned. */
  fetchCertificate: (url: string) => Promise<string>;
  /** Reject a message older than this (default 3600 s: SNS retries a failed delivery for a while, and a retry keeps its Timestamp). */
  maxAgeSeconds?: number;
  /** Reject a Timestamp this far ahead of the clock (default 300 s). */
  maxFutureSeconds?: number;
  /** PEM certificates the signing certificate must chain to. Empty: the TLS-pinned fetch from the pinned host is the only anchor. */
  trustAnchorsPem?: readonly string[];
  now?: () => Date;
}

const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;
const CERT_PATH = /^\/SimpleNotificationService-[A-Za-z0-9]{1,128}\.pem$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const STRING_TO_SIGN_FIELDS: Record<SnsType, readonly string[]> = {
  Notification: ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'],
  SubscriptionConfirmation: [
    'Message',
    'MessageId',
    'SubscribeURL',
    'Timestamp',
    'Token',
    'TopicArn',
    'Type',
  ],
  UnsubscribeConfirmation: [
    'Message',
    'MessageId',
    'SubscribeURL',
    'Timestamp',
    'Token',
    'TopicArn',
    'Type',
  ],
};

/** `https://sns.<region>.amazonaws.com/...`, exactly: no port, no credentials, no look-alike host. */
export function isPinnedSnsUrl(raw: string, region: string): URL | undefined {
  if (raw.length > 2048) return undefined;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'https:') return undefined;
  if (u.hostname !== `sns.${region}.amazonaws.com`) return undefined;
  if (u.port !== '' || u.username !== '' || u.password !== '' || u.hash !== '') return undefined;
  return u;
}

export function assertSnsConfig(c: Pick<SnsVerifierConfig, 'region' | 'topicArns'>): void {
  if (!REGION.test(c.region)) throw new Error('SNS receipt region is not an AWS Region name');
  if (c.topicArns.size === 0) throw new Error('SNS receipt topic allowlist is empty');
}

/** The canonical string SNS signs: `Name\nValue\n` per field, in the fixed order, a missing optional field (Subject) left out. */
export function stringToSign(type: SnsType, fields: Readonly<Record<string, string>>): string {
  let out = '';
  for (const name of STRING_TO_SIGN_FIELDS[type]) {
    const v = fields[name];
    if (v === undefined) continue;
    out += `${name}\n${v}\n`;
  }
  return out;
}

export class SnsVerifier {
  private readonly certs = new Map<string, { pem: string; at: number }>();
  private readonly anchors: X509Certificate[];

  constructor(private readonly c: SnsVerifierConfig) {
    assertSnsConfig(c);
    this.anchors = (c.trustAnchorsPem ?? []).map((p) => new X509Certificate(p));
  }

  async verify(rawBody: Buffer): Promise<SnsVerdict> {
    const now = (this.c.now ?? (() => new Date()))();
    const no = (reason: SnsRefusal): SnsVerdict => ({ ok: false, reason });

    let j: unknown;
    try {
      j = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return no('malformed');
    }
    if (j === null || typeof j !== 'object' || Array.isArray(j)) return no('malformed');
    const o = j as Record<string, unknown>;
    const str = (k: string): string | undefined => (typeof o[k] === 'string' ? o[k] : undefined);
    const type = str('Type');
    if (
      type !== 'Notification' &&
      type !== 'SubscriptionConfirmation' &&
      type !== 'UnsubscribeConfirmation'
    )
      return no('malformed');
    const messageId = str('MessageId');
    const topicArn = str('TopicArn');
    const message = str('Message');
    const timestamp = str('Timestamp');
    const signature = str('Signature');
    const certUrl = str('SigningCertURL');
    const version = str('SignatureVersion');
    if (
      messageId === undefined ||
      topicArn === undefined ||
      message === undefined ||
      timestamp === undefined ||
      signature === undefined ||
      certUrl === undefined ||
      version === undefined
    )
      return no('malformed');
    if (
      type !== 'Notification' &&
      (str('SubscribeURL') === undefined || str('Token') === undefined)
    )
      return no('malformed');
    if (!/^[A-Za-z0-9-]{1,128}$/.test(messageId) || !ISO.test(timestamp)) return no('malformed');
    if (version !== '2') return no('signature_version'); // 1 = SHA1, never accepted
    if (!this.c.topicArns.has(topicArn)) return no('topic_not_allowed');

    const url = isPinnedSnsUrl(certUrl, this.c.region);
    if (url === undefined || !CERT_PATH.test(url.pathname) || url.search !== '')
      return no('cert_url');

    const ageSec = (now.getTime() - Date.parse(timestamp)) / 1000;
    if (
      !Number.isFinite(ageSec) ||
      ageSec > (this.c.maxAgeSeconds ?? 3600) ||
      ageSec < -(this.c.maxFutureSeconds ?? 300)
    )
      return no('stale_timestamp');

    if (!BASE64.test(signature) || signature.length > 1024) return no('malformed');

    let pem: string;
    try {
      pem = await this.certificate(url.toString(), now);
    } catch {
      return no('cert_unavailable');
    }
    let cert: X509Certificate;
    try {
      cert = new X509Certificate(pem);
    } catch {
      return no('cert_invalid');
    }
    if (
      now < new Date(cert.validFrom) ||
      now > new Date(cert.validTo) ||
      cert.publicKey.asymmetricKeyType !== 'rsa' ||
      (this.anchors.length > 0 &&
        !this.anchors.some((a) => cert.checkIssued(a) && cert.verify(a.publicKey)))
    )
      return no('cert_invalid');

    const fields: Record<string, string> = {};
    for (const name of STRING_TO_SIGN_FIELDS[type]) {
      const v = str(name);
      if (v !== undefined) fields[name] = v;
    }
    const ok = createVerify('RSA-SHA256')
      .update(stringToSign(type, fields), 'utf8')
      .verify(cert.publicKey, Buffer.from(signature, 'base64'));
    if (!ok) return no('bad_signature');

    const subscribeUrl = str('SubscribeURL');
    const token = str('Token');
    return {
      ok: true,
      message: {
        type,
        messageId,
        topicArn,
        message,
        timestamp,
        ...(subscribeUrl === undefined ? {} : { subscribeUrl }),
        ...(token === undefined ? {} : { token }),
      },
    };
  }

  private async certificate(url: string, now: Date): Promise<string> {
    const hit = this.certs.get(url);
    if (hit !== undefined && now.getTime() - hit.at < 3_600_000) return hit.pem;
    const pem = await this.c.fetchCertificate(url);
    if (this.certs.size >= 8) this.certs.clear(); // the pinned host serves a handful of certificates; this is a bound, not a policy
    this.certs.set(url, { pem, at: now.getTime() });
    return pem;
  }
}
