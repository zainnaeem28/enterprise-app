// `POST /webhooks/google/calendar` (ARCHITECTURE 29.5, 38.2 item 13). Google sends no body and no signature: only
// `X-Goog-Channel-ID`, `X-Goog-Channel-Token`, `X-Goog-Resource-ID`, `X-Goog-Resource-State`, `X-Goog-Message-Number`.
// The receiver (integration-core) verifies the HMAC channel token WITHOUT reading `calendar_sync.watch_channel` (TDR-05): the key
// comes from the secret store, the check is pure, and a failed check is `401` (or `400` for a malformed resource state), not recorded,
// counted in metrics. A valid request is stored under `<channel id>:<message number>` (a repeat is a duplicate: `200`, no second
// job) and the dispatch job is enqueued in the same transaction. The worker handler then checks the channel against the table and only
// starts an idempotent incremental sync; the push is never the source of a change.
import {
  InboundReceiver,
  googleCalendarVerifier,
  type InboundKeyProvider,
  type PayloadSealer,
  type ReceiveResult,
} from '../integration-core/index.js';
import type { KernelDb, Logger, Queue } from '@ehr/kernel';

/** The `source` of the stored message and the `<env>/integration/inbound/<source>` key it is verified with (key name: README). */
export const GOOGLE_CALENDAR_SOURCE = 'google_calendar';
export const GOOGLE_PUSH_MESSAGE_TYPE = 'google_calendar.push';

export interface GooglePushDeps {
  db: KernelDb;
  /** API-tier queue (it enqueues the dispatch job). */
  queue: Queue;
  sealer: PayloadSealer;
  /** Fetches the channel key (current, then previous) from the secret store by its fixed name. No table is read. */
  keys: InboundKeyProvider;
  orgId: string;
  logger?: Logger;
  /** Verification failures are counted, not recorded (29.5). */
  onVerificationFailure?: (info: { source: string; reason: 'unauthenticated' | 'invalid' }) => void;
  now?: () => Date;
}

const HEADERS = [
  'x-goog-channel-id',
  'x-goog-channel-token',
  'x-goog-resource-id',
  'x-goog-resource-state',
  'x-goog-message-number',
] as const;

export class GoogleCalendarPush {
  private readonly receiver: InboundReceiver;

  constructor(d: GooglePushDeps) {
    this.receiver = new InboundReceiver({
      db: d.db,
      queue: d.queue,
      sealer: d.sealer,
      keys: d.keys,
      orgId: d.orgId,
      verifiers: new Map([[GOOGLE_CALENDAR_SOURCE, googleCalendarVerifier]]),
      ...(d.logger === undefined ? {} : { logger: d.logger }),
      ...(d.onVerificationFailure === undefined ? {} : { onVerificationFailure: d.onVerificationFailure }),
      ...(d.now === undefined ? {} : { now: d.now }),
    });
  }

  /** Only the five Google headers are passed on (single values, lower-cased); the body is ignored: it is never the change source. */
  receive(headers: Readonly<Record<string, string | string[] | undefined>>): Promise<ReceiveResult> {
    const h: Record<string, string | undefined> = {};
    for (const name of HEADERS) {
      const v = headers[name];
      h[name] = typeof v === 'string' ? v : undefined; // a repeated header is treated as missing
    }
    return this.receiver.receive({ source: GOOGLE_CALENDAR_SOURCE, headers: h, rawBody: Buffer.alloc(0) });
  }
}
