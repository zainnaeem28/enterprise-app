// Maps the vendor events that arrive through SNS to the normalised receipt `notifications.on_receipt` reads
// ({ providerMessageId, eventId, status, occurredAt }, apps/worker/src/jobs/notifications/receipt.ts). Only those four fields leave
// this function: the recipient address, phone number, bounce diagnostics and every other vendor field are dropped here, so nothing
// else is stored, sealed or logged (3.2 rule 7).
//
// SES event publishing (Delivery, Bounce, Complaint): { eventType, mail: { messageId }, delivery|bounce|complaint: { timestamp } }.
// End User Messaging SMS event record: { eventType: "TEXT_...", eventTimestamp (epoch ms), messageId, ... }.
// Both shapes are from the vendors' documentation and are UNVERIFIED against a real account (no AWS call was made).

export type ReceiptChannel = 'email' | 'sms';

export interface NormalisedReceipt {
  providerMessageId: string;
  eventId: string;
  status: 'delivered' | 'bounced' | 'complaint' | 'failed';
  occurredAt: string;
}

/** SMS final states that mean the text did not arrive. TEXT_PENDING/QUEUED/SUCCESSFUL (accepted by the carrier) and UNKNOWN are not receipts. */
const SMS_FAILED = new Set([
  'TEXT_INVALID',
  'TEXT_INVALID_MESSAGE',
  'TEXT_UNREACHABLE',
  'TEXT_CARRIER_UNREACHABLE',
  'TEXT_BLOCKED',
  'TEXT_CARRIER_BLOCKED',
  'TEXT_SPAM',
  'TEXT_TTL_EXPIRED',
]);

const ID = /^[A-Za-z0-9._=+/-]{1,120}$/;
const SES_STATUS = { Delivery: 'delivered', Bounce: 'bounced', Complaint: 'complaint' } as const;
const SES_KEY = { Delivery: 'delivery', Bounce: 'bounce', Complaint: 'complaint' } as const;

const obj = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

export type MapResult =
  { kind: 'receipt'; receipt: NormalisedReceipt } | { kind: 'ignored' } | { kind: 'invalid' };

export function mapReceiptEvent(channel: ReceiptChannel, snsMessage: string): MapResult {
  let j: unknown;
  try {
    j = JSON.parse(snsMessage);
  } catch {
    return { kind: 'invalid' };
  }
  const o = obj(j);
  if (o === undefined) return { kind: 'invalid' };
  return channel === 'email' ? mapSes(o) : mapSms(o);
}

function mapSes(o: Record<string, unknown>): MapResult {
  const type = o['eventType'] ?? o['notificationType']; // the latter is the older notification shape
  if (typeof type !== 'string') return { kind: 'invalid' };
  if (!Object.hasOwn(SES_STATUS, type)) return { kind: 'ignored' }; // Send, Reject, DeliveryDelay, Open, Click ...
  const t = type as keyof typeof SES_STATUS;
  const messageId = obj(o['mail'])?.['messageId'];
  const at = obj(o[SES_KEY[t]])?.['timestamp'];
  if (typeof messageId !== 'string' || !ID.test(messageId)) return { kind: 'invalid' };
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) return { kind: 'invalid' };
  const occurredAt = new Date(at).toISOString();
  return {
    kind: 'receipt',
    receipt: {
      providerMessageId: messageId,
      eventId: `${t.toLowerCase()}:${messageId}:${occurredAt}`,
      status: SES_STATUS[t],
      occurredAt,
    },
  };
}

function mapSms(o: Record<string, unknown>): MapResult {
  const type = o['eventType'];
  if (typeof type !== 'string') return { kind: 'invalid' };
  const status =
    type === 'TEXT_DELIVERED' ? 'delivered' : SMS_FAILED.has(type) ? 'failed' : undefined;
  if (status === undefined) return { kind: 'ignored' };
  const messageId = o['messageId'];
  const ts = o['eventTimestamp'];
  if (typeof messageId !== 'string' || !ID.test(messageId)) return { kind: 'invalid' };
  if (
    typeof ts !== 'number' ||
    !Number.isFinite(ts) ||
    ts <= 0 ||
    Number.isNaN(new Date(ts).getTime())
  )
    return { kind: 'invalid' };
  const occurredAt = new Date(ts).toISOString();
  return {
    kind: 'receipt',
    receipt: {
      providerMessageId: messageId,
      eventId: `${type.toLowerCase()}:${messageId}:${ts}`,
      status,
      occurredAt,
    },
  };
}
