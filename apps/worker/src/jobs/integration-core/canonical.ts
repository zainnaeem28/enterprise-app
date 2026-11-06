// SEC-01 O2-1: the canonical request bytes of an admin-entered inbound-verification secret, and the challenge both
// approving persons sign. Versioned and length-prefixed (4-byte big-endian length, UTF-8 bytes), so no field can bleed
// into the next. The value never appears: only a fingerprint salted with the request ID and a per-request nonce (SC-6).
// The API (apps/api/src/modules/integration-core/canonical.ts) holds an identical copy; both tests pin the same vector.
//
// Deviation from O2-1, recorded as open note INT-N3: the approver's person ID is not inside the bytes (the approver is
// unknown when the request is created, and the bytes are immutable once stored). The approver is bound by the worker check
// instead: the approver assertion's credential must belong to the stated approver person and differ from the requester.
import { createHash } from 'node:crypto';

export const CANONICAL_VERSION = 'ehr.secret_change.v1';

export interface CanonicalFields {
  requestId: string;
  connectionId: string;
  name: string;
  valueFingerprintHex: string;
  requesterPersonId: string;
  expiresAt: Date;
}

export function valueFingerprint(requestId: string, nonce: Buffer, value: string): string {
  return createHash('sha256')
    .update(
      Buffer.concat([
        Buffer.from(requestId, 'utf8'),
        Buffer.from([0]),
        nonce,
        Buffer.from([0]),
        Buffer.from(value, 'utf8'),
      ]),
    )
    .digest('hex');
}

export function canonicalRequest(f: CanonicalFields): Buffer {
  const parts = [
    CANONICAL_VERSION,
    f.requestId,
    f.connectionId,
    f.name,
    f.valueFingerprintHex,
    f.requesterPersonId,
    f.expiresAt.toISOString(),
  ];
  return Buffer.concat(
    parts.map((p) => {
      const b = Buffer.from(p, 'utf8');
      const len = Buffer.alloc(4);
      len.writeUInt32BE(b.length);
      return Buffer.concat([len, b]);
    }),
  );
}

/** The WebAuthn challenge: SHA-256 of the canonical bytes. Also stored as `request_hash`. */
export const challengeOf = (canonical: Buffer): Buffer =>
  createHash('sha256').update(canonical).digest();
