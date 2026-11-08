// The video adapter (kind `video`, ARCHITECTURE 22.3, 24, 33.1, 34.3; ticket BE-15): the vendor side of telehealth, implementing
// integration-core's `VendorAdapter<'video'>` (BE-02). It owns no log, retry or circuit: `callVendor` wraps every call.
//
// WHICH VENDOR is not decided (C-11; the sandbox is C-10): the adapter is vendor-neutral. All a vendor needs to provide is a
// `VideoTransport`: five calls that map onto the four contract operations. Nothing in this file names a vendor, a URL or a header.
// Hostnames belong to the transport and come from code or IaC, never from a connection setting or an argument (SEC01-F-12, INT-N7).
// The real-vendor cases (TC-TH-01..05 against a sandbox) stay BLOCKED until a transport for the chosen vendor exists.
//
// What the adapter guarantees whatever the vendor:
//  * recording is off: `create_meeting` refuses an argument asking for it, and the transport is called with `recording: false` (SEC-D-14);
//  * a join token is per attendee and short-lived: the lifetime is bounded (30 s .. 15 min) and the attendee's external ID is our
//    participant ID, an opaque UUID with no name;
//  * the attendee token is returned in `data` and nowhere else: not in `vendorRef`, not in an error, not in a log (the gateway never
//    logs `data`); an error carries a class and a status, never a vendor body;
//  * arguments are validated before the transport is touched.
import {
  type HealthResult,
  type OperationOf,
  type VendorAdapter,
  type VendorCall,
  type VendorResult,
} from '../integration-core/adapters.js';
import { AdapterFailure } from '../integration-core/errors.js';
import { isUuid } from './ids.js';

/** The vendor-specific half. Every method honours `signal` (the gateway's timeout) and throws `AdapterFailure` for a failed call. */
export interface VideoTransport {
  /** True when the vendor accepts our idempotency token on create (checked per vendor at G2). Otherwise `findMeeting` is used. */
  readonly supportsIdempotencyToken: boolean;
  readonly timeoutMs?: number;
  createMeeting(i: {
    externalId: string;
    idempotencyToken: string;
    /** Always false in R1. */
    recording: false;
    signal: AbortSignal;
  }): Promise<{ meetingId: string }>;
  endMeeting(i: {
    meetingId: string;
    idempotencyToken: string;
    signal: AbortSignal;
  }): Promise<void>;
  createAttendee(i: {
    meetingId: string;
    externalUserId: string;
    ttlSeconds: number;
    idempotencyToken: string;
    signal: AbortSignal;
  }): Promise<{ attendeeId: string; joinToken: string; expiresAt?: string }>;
  findMeeting(i: {
    externalId: string;
    signal: AbortSignal;
  }): Promise<{ meetingId: string } | null>;
  /** A cheap authenticated call; never echoes a credential. */
  ping(i: { signal: AbortSignal }): Promise<boolean>;
}

const MEETING_ID = /^[\x21-\x7e]{1,200}$/;
export const MIN_TTL_SECONDS = 30;
export const MAX_TTL_SECONDS = 900;

const bad = (): AdapterFailure => new AdapterFailure(false, undefined, 'bad_argument');

function uuid(a: Readonly<Record<string, unknown>>, k: string): string {
  const v = a[k];
  if (!isUuid(v)) throw bad();
  return v.toLowerCase();
}

function meetingId(a: Readonly<Record<string, unknown>>): string {
  const v = a['meetingId'];
  if (typeof v !== 'string' || !MEETING_ID.test(v)) throw bad();
  return v;
}

/** A transport that throws anything but AdapterFailure is treated as a retryable vendor error with no text carried. */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AdapterFailure) throw e;
    throw new AdapterFailure(true, undefined, 'vendor_error');
  }
}

export class VideoAdapter implements VendorAdapter<'video'> {
  readonly kind = 'video' as const;
  readonly supportsIdempotencyToken: boolean;
  readonly timeoutMs: number;

  constructor(private readonly transport: VideoTransport) {
    this.supportsIdempotencyToken = transport.supportsIdempotencyToken;
    this.timeoutMs = transport.timeoutMs ?? 10_000;
  }

  async call(req: VendorCall & { operation: OperationOf<'video'> }): Promise<VendorResult> {
    const a = req.args;
    switch (req.operation) {
      case 'create_meeting': {
        // Recording is not a choice in R1: asking for it at all is refused, so no caller can turn it on by accident.
        if (a['recording'] !== undefined && a['recording'] !== false) throw bad();
        const m = await guarded(() =>
          this.transport.createMeeting({
            externalId: uuid(a, 'externalId'),
            idempotencyToken: req.idempotencyToken,
            recording: false,
            signal: req.signal,
          }),
        );
        if (!MEETING_ID.test(m.meetingId))
          throw new AdapterFailure(false, undefined, 'bad_response');
        return {
          data: { meetingId: m.meetingId, vendor: req.connection.vendor },
          vendorRef: m.meetingId,
        };
      }
      case 'end_meeting': {
        const id = meetingId(a);
        await guarded(() =>
          this.transport.endMeeting({
            meetingId: id,
            idempotencyToken: req.idempotencyToken,
            signal: req.signal,
          }),
        );
        return { data: { ended: true }, vendorRef: id };
      }
      case 'join_token': {
        const id = meetingId(a);
        const ttl = a['ttlSeconds'];
        if (
          typeof ttl !== 'number' ||
          !Number.isInteger(ttl) ||
          ttl < MIN_TTL_SECONDS ||
          ttl > MAX_TTL_SECONDS
        )
          throw bad();
        const att = await guarded(() =>
          this.transport.createAttendee({
            meetingId: id,
            externalUserId: uuid(a, 'participantRef'),
            ttlSeconds: ttl,
            idempotencyToken: req.idempotencyToken,
            signal: req.signal,
          }),
        );
        if (
          typeof att.joinToken !== 'string' ||
          att.joinToken.length === 0 ||
          att.joinToken.length > 4096 ||
          typeof att.attendeeId !== 'string' ||
          !MEETING_ID.test(att.attendeeId)
        )
          throw new AdapterFailure(false, undefined, 'bad_response');
        // The token is in `data` only. `vendorRef` is the meeting: the call log keeps no credential.
        return {
          data: {
            attendeeId: att.attendeeId,
            attendeeToken: att.joinToken,
            ...(att.expiresAt === undefined ? {} : { expiresAt: att.expiresAt }),
          },
          vendorRef: id,
        };
      }
      case 'lookup_meeting': {
        const m = await guarded(() =>
          this.transport.findMeeting({ externalId: uuid(a, 'externalId'), signal: req.signal }),
        );
        return {
          data: m === null ? null : { meetingId: m.meetingId, vendor: req.connection.vendor },
          ...(m === null ? {} : { vendorRef: m.meetingId }),
        };
      }
    }
  }

  /** For a vendor without an idempotency token (34.3): the room made by an earlier, uncertain attempt, found by our external ID. */
  async find(req: VendorCall): Promise<VendorResult | null> {
    if (req.operation !== 'create_meeting') return null;
    const m = await guarded(() =>
      this.transport.findMeeting({ externalId: uuid(req.args, 'externalId'), signal: req.signal }),
    );
    return m === null
      ? null
      : {
          data: { meetingId: m.meetingId, vendor: req.connection.vendor },
          vendorRef: m.meetingId,
        };
  }

  async healthCheck(req: { signal: AbortSignal }): Promise<HealthResult> {
    try {
      return { ok: await this.transport.ping({ signal: req.signal }) };
    } catch {
      return { ok: false };
    }
  }
}
