// audit.archive_anchors (every minute, key = minute; INT04-F10 decision D-2, design 3.1-3.3; SEC05-F02). Copies every anchor that has no
// receipt to the Object Lock archive and records an `audit.anchor_archive_receipt`. The job never updates audit.anchor and never deletes an
// object. The object-store call happens outside any database transaction (the app_worker role kills a transaction idle for 30 s): the
// advisory lock only serialises the selection, and a second writer is harmless because the put is conditional (412 -> compare bytes) and
// the receipt insert is `ON CONFLICT DO NOTHING`.
import { createHash } from 'node:crypto';
import type { KernelDb, Queue } from '@ehr/kernel';
import { ISO_US, systemScope } from './scope.js';

export interface ArchiveVersion {
  key: string;
  versionId: string;
  /** ISO-8601 instant; orders the versions of one key (oldest first). */
  lastModified: string;
}

export type PutResult = { outcome: 'created'; versionId: string } | { outcome: 'exists' };

/**
 * The log-archive bucket as the worker sees it (Object Lock compliance mode, versioning on). The S3 adapter is infrastructure (DEVOPS-PLAN);
 * tests use an in-process fake with versioning and `If-None-Match`.
 */
export interface AnchorArchiveStore {
  /** `PutObject` with `If-None-Match: *` and `x-amz-checksum-sha256`. Resolves `exists` on HTTP 412; any other failure rejects. */
  putAnchor(key: string, body: Buffer, sha256: Buffer): Promise<PutResult>;
  /** Every version of every key under the prefix (paged by the adapter). */
  listVersions(prefix: string): AsyncIterable<ArchiveVersion>;
  getVersion(key: string, versionId: string): Promise<Buffer>;
}

export interface AnchorRow {
  id: string;
  organisationId: string;
  fromTs: string;
  toTs: string;
  rowCount: string;
  merkleRoot: Buffer;
  prevHash: Buffer;
  hash: Buffer;
  lateRows: number;
}

/** Selects the columns of {@link AnchorRow} (alias `a`). */
export const ANCHOR_COLUMNS = `a.id::text AS id, a.organisation_id::text AS organisation_id, a.row_count::text AS row_count,
  a.merkle_root, a.prev_hash, a.hash, a.late_rows,
  to_char(a.from_ts AT TIME ZONE 'UTC', ${ISO_US}) AS from_text, to_char(a.to_ts AT TIME ZONE 'UTC', ${ISO_US}) AS to_text`;

export function anchorRowOf(r: Record<string, unknown>): AnchorRow {
  return {
    id: String(r['id']),
    organisationId: String(r['organisation_id']),
    fromTs: String(r['from_text']),
    toTs: String(r['to_text']),
    rowCount: String(r['row_count']),
    merkleRoot: r['merkle_root'] as Buffer,
    prevHash: r['prev_hash'] as Buffer,
    hash: r['hash'] as Buffer,
    lateRows: Number(r['late_rows']),
  };
}

function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/** The archive object body (design 3.1): canonical JSON, sorted keys, no whitespace, UTF-8; bigints as strings; no PHI exists in an anchor. */
export function canonicalAnchorBody(a: AnchorRow): Buffer {
  return Buffer.from(
    canonicalJson({
      schema: 1,
      id: a.id,
      organisation_id: a.organisationId,
      from_ts: a.fromTs,
      to_ts: a.toTs,
      row_count: a.rowCount,
      merkle_root: a.merkleRoot.toString('hex'),
      prev_hash: a.prevHash.toString('hex'),
      hash: a.hash.toString('hex'),
      late_rows: a.lateRows,
    }),
    'utf8',
  );
}

/** `anchors/<organisation_id>/<yyyy>/<mm>/<dd>/<to_ts as UTC ISO, microseconds>_<anchor id>.json` (design 3.1). */
export function anchorArchiveKey(a: Pick<AnchorRow, 'organisationId' | 'toTs' | 'id'>): string {
  const [y, m, d] = a.toTs.slice(0, 10).split('-');
  return `anchors/${a.organisationId}/${y}/${m}/${d}/${a.toTs}_${a.id}.json`;
}

export const sha256 = (b: Buffer): Buffer => createHash('sha256').update(b).digest();

/** Object Lock keeps every version, so the first one written is the authority; a later version is itself a finding (design 3.4). */
export function groupByKey(versions: ArchiveVersion[]): Map<string, ArchiveVersion[]> {
  const byKey = new Map<string, ArchiveVersion[]>();
  for (const v of versions) {
    const list = byKey.get(v.key);
    if (list === undefined) byKey.set(v.key, [v]);
    else list.push(v);
  }
  for (const list of byKey.values())
    list.sort((x, y) => Date.parse(x.lastModified) - Date.parse(y.lastModified));
  return byKey;
}

export async function listAll(
  store: AnchorArchiveStore,
  prefix: string,
): Promise<ArchiveVersion[]> {
  const out: ArchiveVersion[] = [];
  for await (const v of store.listVersions(prefix)) out.push(v);
  return out;
}

export interface ArchiveOptions {
  store: AnchorArchiveStore;
  queue: Queue;
  /** Anchors handled per run (design 3.3: 100). */
  batchSize?: number;
}

export interface ArchiveResult {
  archived: number;
  /** Receipts inserted after a 412 whose existing object matched. */
  adopted: number;
  /** Anchors whose existing object differs from the canonical body (a mismatch was published, no receipt inserted). */
  differing: number;
  /** Anchors left for the next run after an object-store error. */
  failed: number;
  /** Age in seconds of the oldest anchor without a receipt after the run (0 when none): metric `AuditAnchorArchiveLagSeconds`. */
  lagSeconds: number;
}

export async function runArchiveAnchors(
  db: KernelDb,
  orgId: string,
  opts: ArchiveOptions,
): Promise<ArchiveResult> {
  const batch = Math.max(1, Math.floor(opts.batchSize ?? 100));
  const result: ArchiveResult = { archived: 0, adopted: 0, differing: 0, failed: 0, lagSeconds: 0 };

  // 1. Up to 100 anchors without a receipt, in id order. The lock only serialises this read (see the file comment).
  const pending: AnchorRow[] = await db.withScope(systemScope(orgId), async (tx) => {
    const lock = await tx.query(
      `SELECT pg_try_advisory_xact_lock(hashtextextended('audit.archive_anchors:' || $1::text, 0)) AS ok`,
      [orgId],
    );
    if (lock.rows[0]?.['ok'] !== true) return [];
    const r = await tx.query(
      `SELECT ${ANCHOR_COLUMNS}
         FROM audit.anchor a
        WHERE a.organisation_id = $1::uuid
          AND NOT EXISTS (SELECT 1 FROM audit.anchor_archive_receipt r WHERE r.anchor_id = a.id)
        ORDER BY a.id LIMIT $2`,
      [orgId, batch],
    );
    return r.rows.map(anchorRowOf);
  });

  for (const anchor of pending) {
    const key = anchorArchiveKey(anchor);
    const body = canonicalAnchorBody(anchor);
    const digest = sha256(body);
    let versionId: string;
    try {
      // 2. Conditional put.
      const put = await opts.store.putAnchor(key, body, digest);
      if (put.outcome === 'created') {
        versionId = put.versionId;
      } else {
        // 3. The object exists (a crash between put and insert, or a forged object): compare the earliest version with the canonical body.
        const versions = (await listAll(opts.store, key)).filter((v) => v.key === key);
        const earliest = groupByKey(versions).get(key)?.[0];
        if (earliest === undefined) throw new Error('archive object exists but lists no version');
        const existing = await opts.store.getVersion(key, earliest.versionId);
        if (!existing.equals(body)) {
          result.differing++;
          await db.withScope(systemScope(orgId), (tx) =>
            opts.queue.publish(
              tx,
              'audit.anchor_mismatch',
              { organisationId: orgId, anchorId: Number(anchor.id), kind: 'archive_differs' },
              { jobKey: `${anchor.id}_archive_differs` },
            ),
          );
          continue;
        }
        versionId = earliest.versionId;
        result.adopted++;
      }
    } catch {
      // Any other object-store error leaves the anchor unreceipted for the next run; the lag metric shows it.
      result.failed++;
      continue;
    }
    // 4. The receipt, in its own short transaction.
    await db.withScope(systemScope(orgId), (tx) =>
      tx.query(
        `INSERT INTO audit.anchor_archive_receipt (anchor_id, organisation_id, archive_key, version_id, body_sha256)
         VALUES ($1::bigint, $2::uuid, $3, $4, $5) ON CONFLICT (anchor_id) DO NOTHING`,
        [anchor.id, orgId, key, versionId, digest],
      ),
    );
    result.archived++;
  }

  // 5. Lag: age of the oldest anchor without a receipt (0 when none).
  result.lagSeconds = await db.withScope(systemScope(orgId), async (tx) => {
    const r = await tx.query(
      `SELECT COALESCE(extract(epoch FROM (now() - min(a.created_at))), 0)::float8 AS lag
         FROM audit.anchor a
        WHERE a.organisation_id = $1::uuid
          AND NOT EXISTS (SELECT 1 FROM audit.anchor_archive_receipt r WHERE r.anchor_id = a.id)`,
      [orgId],
    );
    return Math.max(0, Number(r.rows[0]?.['lag'] ?? 0));
  });
  return result;
}
