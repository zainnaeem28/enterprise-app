// Inbound vendor message (ARCHITECTURE 25.7, TDR-04/05; ticket acceptance: "records the message under the vendor event ID
// and enqueues the dispatch job together; a duplicate enqueues nothing"). The receiver runs with no session:
//   verify (no table read) -> seal the payload -> ONE transaction { receive_inbound ; if inserted: enqueue dispatch + publish }
//   -> 200 (also for a duplicate). If the transaction fails the vendor gets 503 and retries: the message and its job are
//   either both stored or neither.
// The HTTP route (controller, raw-body capture, rate limit) is not part of this ticket: it needs the platform layer to keep
// the raw request bytes (open note INT-N2). The receiver takes the raw bytes and returns the status the route must send.
import type { KernelDb, Logger, Queue } from '@ehr/kernel';
import type { InboundKeyProvider, PayloadSealer } from './secret-store.js';
import type { WebhookHeaders, WebhookVerifier } from './verifiers.js';

export const MAX_WEBHOOK_BODY_BYTES = 262_144;
export const DISPATCH_JOB = 'integration_core.dispatch_inbound';
export const INBOUND_RECEIVED_EVENT = 'integration_core.inbound_received';

export type ReceiveResult =
  { status: 200; outcome: 'inserted' | 'duplicate' } | { status: 400 | 401 | 404 | 413 | 503 };

export interface ReceiverDeps {
  db: KernelDb;
  queue: Queue;
  sealer: PayloadSealer;
  keys: InboundKeyProvider;
  /** Organisation of the deployment (21.3: `app.org_id` comes from configuration, never from the request). */
  orgId: string;
  verifiers: ReadonlyMap<string, WebhookVerifier>;
  logger?: Logger;
  /** A failed verification is counted, not recorded (29.5). */
  onVerificationFailure?: (info: { source: string; reason: 'unauthenticated' | 'invalid' }) => void;
  now?: () => Date;
}

const SOURCE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

export class InboundReceiver {
  constructor(private readonly d: ReceiverDeps) {}

  async receive(req: {
    source: string;
    headers: WebhookHeaders;
    rawBody: Buffer;
  }): Promise<ReceiveResult> {
    if (req.rawBody.length > MAX_WEBHOOK_BODY_BYTES) return { status: 413 };
    if (!SOURCE.test(req.source)) return { status: 404 };
    const verifier = this.d.verifiers.get(req.source);
    if (verifier === undefined) return { status: 404 };

    let verdict;
    try {
      const keys = await this.d.keys.keys(req.source);
      verdict = verifier.verify(
        { source: req.source, headers: req.headers, rawBody: req.rawBody },
        keys,
        (this.d.now ?? (() => new Date()))(),
      );
    } catch {
      this.d.logger?.error('webhook key lookup failed', { source: req.source });
      return { status: 503 }; // the secret store did not answer: the vendor retries
    }
    if (!verdict.ok) {
      this.d.onVerificationFailure?.({ source: req.source, reason: verdict.reason });
      return { status: verdict.reason === 'invalid' ? 400 : 401 };
    }
    if (verdict.payload.length > MAX_WEBHOOK_BODY_BYTES || verdict.payload.length === 0)
      return { status: 400 };

    try {
      // DF-4: the context is the source and the vendor's event ID, so a ciphertext cannot be moved to another message.
      const sealed = await this.d.sealer.seal(
        verdict.payload,
        `inbound:${req.source}\n${verdict.eventId}`,
      );
      const outcome = await this.d.db.withScope(
        { audience: 'anonymous', orgId: this.d.orgId },
        async (tx) => {
          const r = await tx.query(
            'SELECT outcome, message_id FROM integration_core.receive_inbound($1, $2, $3, $4)',
            [req.source, verdict.eventId, verdict.messageType, sealed],
          );
          const row = r.rows[0];
          if (row === undefined) throw new Error('receive_inbound returned nothing');
          if (row.outcome !== 'inserted') return 'duplicate' as const;
          const messageId = String(row.message_id);
          // Same transaction: the message and its job commit together or not at all. Job key = message ID.
          await this.d.queue.enqueue(tx, DISPATCH_JOB, { messageId }, { jobKey: messageId });
          await this.d.queue.publish(tx, INBOUND_RECEIVED_EVENT, {
            messageId,
            organisationId: this.d.orgId,
          });
          return 'inserted' as const;
        },
        { idempotent: true },
      );
      return { status: 200, outcome };
    } catch (err) {
      this.d.logger?.error('webhook transaction failed', {
        source: req.source,
        sqlstate: (err as { code?: unknown } | null)?.code,
      });
      return { status: 503 };
    }
  }
}
