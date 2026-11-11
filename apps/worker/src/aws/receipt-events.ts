// Maps provider delivery events onto the normalised receipt body that `notifications.on_receipt` reads
// ({ providerMessageId, eventId, status, occurredAt }, notifications/receipt.ts). Pure functions. There is NO inbound HTTP route yet
// (integration-core/inbound.ts: "the HTTP route is not part of this ticket", INT-N2), so nothing calls these: SES/SNS -> webhook wiring
// belongs to the ticket that adds the route and a verifier for SNS signatures. Field names follow the AWS event formats and must be
// compared with a real event at go-live (docs/GO-LIVE.md); no real event has been seen by this code.
export interface NormalisedReceipt {
  providerMessageId: string;
  eventId: string;
  status: 'delivered' | 'bounced' | 'complaint' | 'failed';
  occurredAt: string;
}

const obj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

function unwrapSns(body: Record<string, unknown>): Record<string, unknown> | undefined {
  if (body['Type'] !== 'Notification') return body;
  const m = str(body['Message']);
  if (m === undefined) return undefined;
  try {
    return obj(JSON.parse(m));
  } catch {
    return undefined;
  }
}

/** SES event publishing (Delivery, Bounce, Complaint), directly or inside an SNS Notification. Other event types return `undefined`. */
export function sesEventToReceipt(input: unknown): NormalisedReceipt | undefined {
  const top = obj(input);
  const e = top === undefined ? undefined : unwrapSns(top);
  const type = str(e?.['eventType'] ?? e?.['notificationType']);
  const mail = obj(e?.['mail']);
  const id = str(mail?.['messageId']);
  if (e === undefined || type === undefined || id === undefined) return undefined;
  const at = (o: Record<string, unknown> | undefined): string | undefined => {
    const t = str(o?.['timestamp']) ?? str(mail?.['timestamp']);
    return t !== undefined && !Number.isNaN(Date.parse(t)) ? new Date(t).toISOString() : undefined;
  };
  if (type === 'Delivery') {
    const occurredAt = at(obj(e['delivery']));
    return occurredAt === undefined
      ? undefined
      : { providerMessageId: id, eventId: `${id}:delivery`, status: 'delivered', occurredAt };
  }
  if (type === 'Bounce') {
    const b = obj(e['bounce']);
    const occurredAt = at(b);
    if (occurredAt === undefined) return undefined;
    return {
      providerMessageId: id,
      eventId: str(b?.['feedbackId']) ?? `${id}:bounce`,
      // A transient bounce may still be retried by SES; only a permanent one is a bounced address.
      status: b?.['bounceType'] === 'Permanent' ? 'bounced' : 'failed',
      occurredAt,
    };
  }
  if (type === 'Complaint') {
    const c = obj(e['complaint']);
    const occurredAt = at(c);
    return occurredAt === undefined
      ? undefined
      : {
          providerMessageId: id,
          eventId: str(c?.['feedbackId']) ?? `${id}:complaint`,
          status: 'complaint',
          occurredAt,
        };
  }
  return undefined;
}

const SMS_OK = new Set(['TEXT_DELIVERED', 'TEXT_SUCCESSFUL']);
const SMS_FAIL = new Set([
  'TEXT_BLOCKED',
  'TEXT_CARRIER_BLOCKED',
  'TEXT_CARRIER_UNREACHABLE',
  'TEXT_INVALID',
  'TEXT_INVALID_MESSAGE',
  'TEXT_UNREACHABLE',
  'TEXT_UNKNOWN',
  'TEXT_SPAM',
  'TEXT_TTL_EXPIRED',
]);

/** End User Messaging SMS event destination record (`eventType`, `messageId`, `eventTimestamp` in epoch ms). */
export function smsEventToReceipt(input: unknown): NormalisedReceipt | undefined {
  const top = obj(input);
  const e = top === undefined ? undefined : unwrapSns(top);
  const type = str(e?.['eventType']);
  const id = str(e?.['messageId']);
  const ts = e?.['eventTimestamp'];
  if (type === undefined || id === undefined || typeof ts !== 'number' || !Number.isFinite(ts))
    return undefined;
  const status = SMS_OK.has(type) ? 'delivered' : SMS_FAIL.has(type) ? 'failed' : undefined;
  if (status === undefined) return undefined; // TEXT_PENDING and the like are not a result
  return {
    providerMessageId: id,
    eventId: `${id}:${type}`,
    status,
    occurredAt: new Date(ts).toISOString(),
  };
}
