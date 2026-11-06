import { createHash } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

export const sha256 = (s: string | Buffer): Buffer => createHash('sha256').update(s).digest();

/** The name of a doctor's refresh-token reference (22.9). The table CHECK repeats this rule. */
export const tokenSecretName = (clinicianId: string): string => `cal-${clinicianId.toLowerCase()}`;

/**
 * The Google event ID of a Busy event, derived from the occupancy ID (34.3): a retry cannot create a duplicate. Google event IDs are
 * lower-case base32hex (a-v, 0-9), 5 to 1024 characters: 'ehr' plus the 32 hex digits of the UUID is inside that alphabet.
 */
export const eventIdFor = (occupancyId: string): string => `ehr${occupancyId.toLowerCase().replaceAll('-', '')}`;

/** `calendar_sync.full_resync` marker for a discarded token: the first 128 bits of SHA-256(token) as a UUID (IDs-only payloads, BD-09). */
export function discardedMarker(hash: Buffer): string {
  const h = hash.subarray(0, 16).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The hash of a Google event ID stored as `scheduling.busy_block.external_hash` (22.8: the hash of the event ID, no title). */
export const externalHash = (googleEventId: string): Buffer => sha256(`google-event\u0000${googleEventId}`);
