// Anchoring arithmetic (ARCHITECTURE section 6, SAR-04). Leaves are the database's `audit.row_digest(row)`; this file
// builds the tree and the chained anchor hash. Domain-separated (0x00 leaf, 0x01 node) so a leaf can never be read as
// a node. An odd node at a level is carried up unchanged.
import { createHash } from 'node:crypto';

const sha256 = (...parts: Buffer[]): Buffer => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};

export const EMPTY_ROOT: Buffer = sha256();
export const GENESIS_HASH: Buffer = Buffer.alloc(32);

export function leafHash(rowDigest: Buffer): Buffer {
  return sha256(Buffer.from([0x00]), rowDigest);
}

/** Merkle root over row digests, in the order given (the caller orders by occurred_at, event_id). */
export function merkleRoot(rowDigests: readonly Buffer[]): Buffer {
  if (rowDigests.length === 0) return EMPTY_ROOT;
  let level = rowDigests.map(leafHash);
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const l = level[i] as Buffer;
      const r = level[i + 1];
      next.push(r === undefined ? l : sha256(Buffer.from([0x01]), l, r));
    }
    level = next;
  }
  return level[0] as Buffer;
}

/** Instants are the UTC text the database produced (`YYYY-MM-DD"T"HH24:MI:SS.US"Z"`), so both sides hash the same bytes. */
export function anchorHash(a: {
  prevHash: Buffer;
  fromTs: string;
  toTs: string;
  rowCount: bigint;
  merkleRoot: Buffer;
}): Buffer {
  const count = Buffer.alloc(8);
  count.writeBigUInt64BE(a.rowCount);
  return sha256(
    a.prevHash,
    Buffer.from(a.fromTs, 'utf8'),
    Buffer.from('\n', 'utf8'),
    Buffer.from(a.toTs, 'utf8'),
    Buffer.from('\n', 'utf8'),
    count,
    a.merkleRoot,
  );
}
