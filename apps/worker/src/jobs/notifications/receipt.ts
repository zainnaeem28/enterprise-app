// `notifications.on_receipt` (ARCHITECTURE 33.1): the inbound handler for delivery events from the e-mail and SMS vendors
// (25.7), registered with integration-core for `(source, 'delivery_receipt')`. It inserts one `delivery_receipt` row,
// idempotent by (notification, vendor event ID), carrying the SURVIVOR's patient ID when the patient was merged (SBR-16: the
// notification itself is a kept row and stays on the merged ID, so the receipt is a new row on the survivor).
//
// The payload is UNTRUSTED (SEC-01 DF-3: a compromised API tier can forge a message): it is schema-checked, and a receipt is
// recorded only for a KNOWN outbound reference (a notification we sent, found by the provider's message ID). Anything else is
// logged by class and dropped. The vendor-specific wire formats are normalised by the real adapters (C-10/C-11); this handler
// reads the normalised shape  { providerMessageId, eventId, status, occurredAt }.
import type { KernelDb, Logger, Tx } from '@ehr/kernel';
import type { InboundHandlerFn, InboundHandlerRegistry } from '../integration-core/index.js';
import { uuidv7 } from './ids.js';
import { systemScope } from './scope.js';

const STATUSES = ['delivered', 'bounced', 'complaint', 'failed'] as const;
type ReceiptStatus = (typeof STATUSES)[number];

export interface Receipt {
  providerMessageId: string;
  eventId: string;
  status: ReceiptStatus;
  occurredAt: Date;
}

export function parseReceipt(body: Buffer): Receipt | undefined {
  if (body.length > 8192) return undefined;
  let j: unknown;
  try {
    j = JSON.parse(body.toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof j !== 'object' || j === null || Array.isArray(j)) return undefined;
  const o = j as Record<string, unknown>;
  const mid = o['providerMessageId'];
  const eid = o['eventId'];
  const st = o['status'];
  const at = o['occurredAt'];
  if (typeof mid !== 'string' || mid.length < 1 || mid.length > 200) return undefined;
  if (typeof eid !== 'string' || eid.length < 1 || eid.length > 200) return undefined;
  if (typeof st !== 'string' || !(STATUSES as readonly string[]).includes(st)) return undefined;
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) return undefined;
  return {
    providerMessageId: mid,
    eventId: eid,
    status: st as ReceiptStatus,
    occurredAt: new Date(at),
  };
}

export type ReceiptResult = 'recorded' | 'duplicate' | 'unknown_reference' | 'invalid';

export interface ReceiptDeps {
  /** `patient`'s closure: the survivor of a (possibly merged) patient ID. Without it the notification's own ID is used. */
  survivorOf?: (patientId: string) => Promise<string | undefined>;
}

export async function recordReceipt(
  deps: ReceiptDeps,
  ctx: { db: KernelDb; orgId: string; log: Logger },
  body: Buffer,
): Promise<ReceiptResult> {
  const r = parseReceipt(body);
  if (r === undefined) {
    ctx.log.warn('receipt dropped', { reason: 'invalid_payload' });
    return 'invalid';
  }
  const known = await ctx.db.withScope(
    systemScope(ctx.orgId),
    async (tx: Tx) =>
      (
        await tx.query(
          `SELECT id, patient_id FROM notifications.notification
          WHERE provider_message_id = $1 AND channel IN ('email', 'sms', 'push') AND status = 'sent' LIMIT 2`,
          [r.providerMessageId],
        )
      ).rows,
  );
  if (known.length !== 1) {
    ctx.log.warn('receipt dropped', { reason: 'unknown_reference' });
    return 'unknown_reference';
  }
  const notificationId = String(known[0]?.['id']);
  let patientId = (known[0]?.['patient_id'] as string | null) ?? null;
  if (patientId !== null && deps.survivorOf !== undefined)
    patientId = (await deps.survivorOf(patientId)) ?? patientId;
  const ins = await ctx.db.withScope(systemScope(ctx.orgId), (tx: Tx) =>
    tx.query(
      `INSERT INTO notifications.delivery_receipt (id, organisation_id, notification_id, patient_id, status, received_at, vendor_event_id)
       VALUES ($1, $2, $3::uuid, $4, $5, $6, $7) ON CONFLICT (organisation_id, notification_id, vendor_event_id) DO NOTHING`,
      [uuidv7(), ctx.orgId, notificationId, patientId, r.status, r.occurredAt, r.eventId],
    ),
  );
  return (ins.rowCount ?? 0) === 1 ? 'recorded' : 'duplicate';
}

export function createReceiptHandler(deps: ReceiptDeps = {}): InboundHandlerFn {
  return async (msg, ctx) => {
    await recordReceipt(deps, ctx, msg.body);
  };
}

/** Registers the handler for each configured e-mail/SMS source. One handler per pair (integration-core refuses a second). */
export function registerReceiptHandlers(
  registry: InboundHandlerRegistry,
  sources: readonly string[],
  deps: ReceiptDeps = {},
): void {
  for (const s of sources)
    registry.register(
      s,
      'delivery_receipt',
      'notifications.on_receipt',
      createReceiptHandler(deps),
    );
}
