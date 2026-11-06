// Webhook verification rules of ARCHITECTURE 29.5. Pure functions over (headers, raw body, keys, clock): no table is read
// before a request is verified (a webhook transaction has no audience, TDR-05). A failed check is `unauthenticated` (401,
// not recorded, counted in metrics by the caller); a malformed request is `invalid` (400).
import { createHmac, timingSafeEqual } from 'node:crypto';

export type WebhookHeaders = Readonly<Record<string, string | undefined>>;

export interface WebhookRequest {
  source: string;
  /** Header names lower-cased by the caller. */
  headers: WebhookHeaders;
  /** The raw bytes as received: signatures cover them, so a parsed-and-reserialised body is never used. */
  rawBody: Buffer;
}

export type Verdict =
  | { ok: true; eventId: string; messageType: string; payload: Buffer }
  | { ok: false; reason: 'unauthenticated' | 'invalid' };

export interface KeyVersion {
  version: string;
  key: Buffer;
}

export interface WebhookVerifier {
  verify(req: WebhookRequest, keys: readonly KeyVersion[], now: Date): Verdict;
}

const bad = (reason: 'unauthenticated' | 'invalid'): Verdict => ({ ok: false, reason });

/** Constant-time comparison that is also safe for different lengths. */
export function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) {
    timingSafeEqual(a, a); // keep the work independent of the guess
    return false;
  }
  return timingSafeEqual(a, b);
}

export interface HmacTimestampOptions {
  signatureHeader: string;
  timestampHeader: string;
  /** Signed timestamp must be within this many seconds of now. 29.5: 5 minutes. */
  toleranceSeconds?: number;
  /** Maps the parsed JSON body to the vendor's event ID and our message type, or null if the shape is wrong (400). */
  extract: (body: Record<string, unknown>) => { eventId: string; messageType: string } | null;
  /** CN-12: unknown JSON fields are rejected on `integrations.`. When set, any other top-level key is a 400. */
  allowedFields?: readonly string[];
}

/**
 * The generic vendor scheme: `hex(HMAC-SHA256(key, "<timestamp>.<raw body>"))`, optionally prefixed `v1=`, with a signed
 * epoch-seconds timestamp inside the replay window. The vendor-specific schemes (checked per vendor at G2) are further
 * implementations of {@link WebhookVerifier}; each is added with its adapter ticket.
 */
export function hmacTimestampVerifier(o: HmacTimestampOptions): WebhookVerifier {
  const tolerance = o.toleranceSeconds ?? 300;
  return {
    verify(req, keys, now) {
      const sig = req.headers[o.signatureHeader];
      const ts = req.headers[o.timestampHeader];
      if (sig === undefined || ts === undefined || keys.length === 0) return bad('unauthenticated');
      if (!/^\d{9,12}$/.test(ts)) return bad('unauthenticated');
      if (Math.abs(now.getTime() / 1000 - Number(ts)) > tolerance) return bad('unauthenticated');
      const hex = sig.startsWith('v1=') ? sig.slice(3) : sig;
      if (!/^[0-9a-f]{64}$/i.test(hex)) return bad('unauthenticated');
      const given = Buffer.from(hex, 'hex');
      let match = false;
      for (const k of keys) {
        const expect = createHmac('sha256', k.key).update(`${ts}.`).update(req.rawBody).digest();
        if (safeEqual(expect, given)) match = true; // no early exit: every key costs the same
      }
      if (!match) return bad('unauthenticated');
      // Verified: only now is the body looked at.
      let body: unknown;
      try {
        body = JSON.parse(req.rawBody.toString('utf8'));
      } catch {
        return bad('invalid');
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) return bad('invalid');
      const obj = body as Record<string, unknown>;
      if (
        o.allowedFields !== undefined &&
        Object.keys(obj).some((k) => !o.allowedFields?.includes(k))
      )
        return bad('invalid');
      const x = o.extract(obj);
      if (x === null) return bad('invalid');
      return { ok: true, eventId: x.eventId, messageType: x.messageType, payload: req.rawBody };
    },
  };
}

const CHANNEL_ID = /^[A-Za-z0-9_-]{1,128}$/;
const STATES = new Set(['sync', 'exists', 'not_exists']);
export const GOOGLE_MAX_TOKEN_SECONDS = 7 * 24 * 3600;

/** The token the worker sets when it registers a watch channel (29.5): `v.<key version>.<expiry epoch>.<base64url HMAC>`. */
export function googleChannelToken(
  key: KeyVersion,
  channelId: string,
  expiryEpoch: number,
): string {
  const mac = createHmac('sha256', key.key)
    .update(`${channelId}.${expiryEpoch}`)
    .digest('base64url');
  return `v.${key.version}.${expiryEpoch}.${mac}`;
}

/**
 * Google Calendar push (no signature, no timestamp, no body). The token is recomputed from the header channel ID and the
 * embedded expiry with the named key version (current or previous), compared in constant time. The embedded expiry must not
 * have passed and may not lie more than 7 days ahead. `X-Goog-Resource-State` must be sync|exists|not_exists. The event ID is
 * `<channel id>:<message number>`: a replay inside the token's life is de-duplicated, and can only start an incremental sync.
 */
export const googleCalendarVerifier: WebhookVerifier = {
  verify(req, keys, now) {
    const channelId = req.headers['x-goog-channel-id'];
    const token = req.headers['x-goog-channel-token'];
    if (channelId === undefined || token === undefined) return bad('unauthenticated');
    const m = /^v\.([A-Za-z0-9_-]{1,32})\.(\d{9,12})\.([A-Za-z0-9_-]{43})$/.exec(token);
    if (m === null || !CHANNEL_ID.test(channelId)) return bad('unauthenticated');
    const [, version, expiryRaw, mac] = m as unknown as [string, string, string, string];
    const key = keys.find((k) => k.version === version);
    if (key === undefined) return bad('unauthenticated');
    const expect = createHmac('sha256', key.key).update(`${channelId}.${expiryRaw}`).digest();
    if (!safeEqual(expect, Buffer.from(mac, 'base64url'))) return bad('unauthenticated');
    const expiry = Number(expiryRaw);
    const nowSec = now.getTime() / 1000;
    if (expiry <= nowSec || expiry - nowSec > GOOGLE_MAX_TOKEN_SECONDS)
      return bad('unauthenticated');
    const state = req.headers['x-goog-resource-state'];
    const number = req.headers['x-goog-message-number'];
    const resource = req.headers['x-goog-resource-id'];
    if (state === undefined || !STATES.has(state)) return bad('invalid');
    if (number === undefined || !/^\d{1,15}$/.test(number)) return bad('invalid');
    if (resource === undefined || !/^[A-Za-z0-9_-]{1,256}$/.test(resource)) return bad('invalid');
    return {
      ok: true,
      eventId: `${channelId}:${number}`,
      messageType: 'google_calendar.push',
      // Google sends no body; what the worker handler needs is stored as a tiny JSON document.
      payload: Buffer.from(
        JSON.stringify({ channelId, resourceId: resource, resourceState: state }),
        'utf8',
      ),
    };
  },
};
