// The inbound delivery-receipt route's receiver (INT-N2): Amazon SNS HTTPS notifications from the SES configuration-set event
// destination (source `email`) and the End User Messaging SMS event destination (source `sms`). Flow:
//   verify (sns-verify.ts) -> by Type:
//     SubscriptionConfirmation  SubscribeURL must be https on sns.<region>.amazonaws.com, carry this message's Token and TopicArn;
//                               it is requested once and the answer must be 2xx
//     UnsubscribeConfirmation   logged by class only; never re-subscribed automatically
//     Notification              mapped (receipt-events.ts) and stored through integration-core's sealed inbound path, event ID = the
//                               SNS MessageId, so an SNS redelivery or a replay is a duplicate there; the worker's
//                               `notifications.on_receipt` writes the append-only `delivery_receipt` row, idempotent by vendor event ID
// An unverifiable request is 401 (not stored), a malformed one 400, a failed fetch or store 503 (SNS retries). A replayed MessageId is
// answered 200 and does nothing. Nothing from the message body is logged.
import type { Logger } from '@ehr/kernel';
import { mapReceiptEvent } from './receipt-events.js';
import type { ReceiptChannel } from './receipt-events.js';
import { isPinnedSnsUrl, SnsVerifier } from './sns-verify.js';
import type { SnsRefusal, SnsVerifierConfig } from './sns-verify.js';

export interface VerifiedInboundStore {
  storeVerified(m: {
    source: string;
    eventId: string;
    messageType: string;
    payload: Buffer;
  }): Promise<{ status: number }>;
}

export interface SnsReceiptConfig extends Omit<SnsVerifierConfig, 'topicArns'> {
  /** TopicArn -> the vendor channel whose events it carries. Also the allowlist. */
  topics: ReadonlyMap<string, ReceiptChannel>;
  /** GET of the pinned SubscribeURL; resolves with the HTTP status. */
  confirmSubscription: (url: string) => Promise<number>;
  store: VerifiedInboundStore;
  logger?: Logger;
  /** Counted, not recorded (29.5): the fixed reason only. */
  onRefused?: (info: { reason: SnsRefusal | 'subscribe_url' | 'event_invalid' }) => void;
}

export type SnsReceiptStatus = { status: 200 | 400 | 401 | 503 };

const REPLAY_CAP = 10_000;

export class SnsReceiptReceiver {
  private readonly verifier: SnsVerifier;
  /** MessageIds already stored by this process (a fast path; the durable de-duplication is the inbound unique key). */
  private readonly seen = new Map<string, number>();

  constructor(private readonly c: SnsReceiptConfig) {
    this.verifier = new SnsVerifier({ ...c, topicArns: new Set(c.topics.keys()) });
  }

  async receive(rawBody: Buffer): Promise<SnsReceiptStatus> {
    const now = (this.c.now ?? (() => new Date()))();
    const v = await this.verifier.verify(rawBody);
    if (!v.ok) {
      this.c.onRefused?.({ reason: v.reason });
      return { status: v.reason === 'malformed' ? 400 : 401 };
    }
    const m = v.message;
    if (m.type === 'UnsubscribeConfirmation') {
      this.c.logger?.warn('sns subscription removed', { event: 'unsubscribe_confirmation' });
      return { status: 200 };
    }
    if (m.type === 'SubscriptionConfirmation') return this.confirm(m);

    this.prune(now);
    if (this.seen.has(m.messageId)) return { status: 200 }; // replay: already stored
    const channel = this.c.topics.get(m.topicArn) as ReceiptChannel; // allowlisted by the verifier
    const mapped = mapReceiptEvent(channel, m.message);
    if (mapped.kind === 'invalid') {
      this.c.onRefused?.({ reason: 'event_invalid' });
      this.c.logger?.warn('receipt dropped', { reason: 'event_invalid', channel });
      return { status: 400 };
    }
    if (mapped.kind === 'ignored') return { status: 200 };
    let r: { status: number };
    try {
      r = await this.c.store.storeVerified({
        source: channel,
        eventId: m.messageId,
        messageType: 'delivery_receipt',
        payload: Buffer.from(JSON.stringify(mapped.receipt), 'utf8'),
      });
    } catch {
      return { status: 503 };
    }
    if (r.status !== 200) return { status: 503 };
    this.seen.set(m.messageId, now.getTime());
    return { status: 200 };
  }

  private async confirm(m: {
    topicArn: string;
    token?: string | undefined;
    subscribeUrl?: string | undefined;
  }): Promise<SnsReceiptStatus> {
    const u = isPinnedSnsUrl(m.subscribeUrl ?? '', this.c.region);
    if (
      u === undefined ||
      u.searchParams.get('Action') !== 'ConfirmSubscription' ||
      u.searchParams.get('TopicArn') !== m.topicArn ||
      u.searchParams.get('Token') !== m.token
    ) {
      this.c.onRefused?.({ reason: 'subscribe_url' });
      return { status: 401 };
    }
    try {
      const code = await this.c.confirmSubscription(u.toString());
      if (code < 200 || code > 299) return { status: 503 };
    } catch {
      return { status: 503 };
    }
    this.c.logger?.info('sns subscription confirmed', { event: 'subscription_confirmation' });
    return { status: 200 };
  }

  private prune(now: Date): void {
    const horizon = now.getTime() - ((this.c.maxAgeSeconds ?? 3600) + 300) * 1000;
    for (const [k, t] of this.seen) {
      if (t < horizon || this.seen.size > REPLAY_CAP) this.seen.delete(k);
      else break; // insertion order = age order
    }
  }
}
