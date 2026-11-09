// audit.verify_anchors (daily, key = date). Recomputes every anchor (or the optional lookback window) from the stored rows and checks the chain. A
// changed, removed or added row in an anchored range, a broken link or a gap raises `audit.anchor_mismatch` (the
// notifications handler turns it into the `audit_anchor_mismatch` staff alert, 22.13).
// With an archive store the ARCHIVE is the authority (INT04-F10 D-2, design 3.4; SEC05-F02): the earliest version of every archived anchor
// must equal the database anchor byte for byte (`db_differs_from_archive`), every anchor older than the grace needs a receipt that
// resolves to its object (`not_archived`), and the archived chain itself is checked. The archive is read outside the database transaction.
import type { KernelDb, Queue } from '@ehr/kernel';
import {
  ANCHOR_COLUMNS,
  anchorArchiveKey,
  anchorRowOf,
  canonicalAnchorBody,
  groupByKey,
  listAll,
  type AnchorArchiveStore,
  type AnchorRow,
} from './archive.js';
import { anchorHash, GENESIS_HASH, merkleRoot } from './merkle.js';
import { ISO_US, systemScope } from './scope.js';

export type MismatchKind =
  | 'row_count'
  | 'root'
  | 'hash'
  | 'chain_link'
  | 'chain_gap'
  | 'db_differs_from_archive'
  | 'not_archived'
  | 'archive_extra_version';

export interface Mismatch {
  anchorId: string;
  kind: MismatchKind;
}

export interface VerifyOptions {
  /** Restrict recomputation to anchors created within this many days. Default: every anchor (full chain), so tampering in older ranges is detected too. */
  lookbackDays?: number;
  pageSize?: number;
  /** Where mismatches are published. Without it the result still reports them. */
  queue?: Queue;
  /** The Object Lock archive. Without it only the database is checked (the result says `archive: 'not_checked'`). */
  archive?: AnchorArchiveStore;
  /** An anchor must have a receipt once it is older than this (design 3.4: 15 minutes). */
  archiveGraceMinutes?: number;
  /** Point-in-time restore point (ARCHITECTURE 33): archived anchors that end after it and are missing from the database are not tampering. */
  restorePointAt?: string;
}

export interface VerifyResult {
  checked: number;
  mismatches: Mismatch[];
  /** Days of partitions left after the newest partition bound; null when no partition has a bound. */
  partitionHorizonDays: number | null;
  /** `unavailable`: the archive could not be listed or read; the database checks still ran, the caller must fail the job. */
  archive: 'not_checked' | 'checked' | 'unavailable';
  archivedChecked: number;
  /** Archived anchors missing from the database that end after `restorePointAt` (recorded, not reported). */
  afterRestorePoint: number;
}

interface ArchivedAnchor {
  key: string;
  idFromKey: string;
  versions: { versionId: string }[];
  body: Buffer;
}

const KEY_ID = /_(\d+)\.json$/;

function parseArchived(body: Buffer): AnchorRow | null {
  try {
    const o = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
    const str = (k: string): string | null => (typeof o[k] === 'string' ? (o[k] as string) : null);
    const hex = (k: string): Buffer | null => {
      const v = str(k);
      return v !== null && /^[0-9a-f]{64}$/.test(v) ? Buffer.from(v, 'hex') : null;
    };
    const id = str('id');
    const org = str('organisation_id');
    const from = str('from_ts');
    const to = str('to_ts');
    const rows = str('row_count');
    const root = hex('merkle_root');
    const prev = hex('prev_hash');
    const hash = hex('hash');
    if (
      o['schema'] !== 1 ||
      id === null ||
      org === null ||
      from === null ||
      to === null ||
      rows === null ||
      root === null ||
      prev === null ||
      hash === null ||
      typeof o['late_rows'] !== 'number'
    )
      return null;
    return {
      id,
      organisationId: org,
      fromTs: from,
      toTs: to,
      rowCount: rows,
      merkleRoot: root,
      prevHash: prev,
      hash,
      lateRows: o['late_rows'],
    };
  } catch {
    return null;
  }
}

/** Prefixes to list: the whole organisation for a full-chain run, otherwise one per UTC day of the window (plus one day of margin). */
function archivePrefixes(orgId: string, lookbackDays: number | null, now: Date): string[] {
  if (lookbackDays === null) return [`anchors/${orgId}/`];
  const out: string[] = [];
  for (let d = lookbackDays + 1; d >= 0; d--) {
    const day = new Date(now.getTime() - d * 86_400_000).toISOString().slice(0, 10);
    out.push(`anchors/${orgId}/${day.replaceAll('-', '/')}/`);
  }
  return out;
}

async function readArchive(
  store: AnchorArchiveStore,
  orgId: string,
  lookbackDays: number | null,
): Promise<ArchivedAnchor[]> {
  const versions = [];
  for (const prefix of archivePrefixes(orgId, lookbackDays, new Date()))
    versions.push(...(await listAll(store, prefix)));
  const out: ArchivedAnchor[] = [];
  for (const [key, list] of groupByKey(versions)) {
    const first = list[0];
    if (first === undefined) continue;
    out.push({
      key,
      idFromKey: KEY_ID.exec(key)?.[1] ?? '0',
      versions: list,
      body: await store.getVersion(key, first.versionId),
    });
  }
  return out;
}

export async function runVerify(
  db: KernelDb,
  orgId: string,
  opts: VerifyOptions = {},
): Promise<VerifyResult> {
  const lookback =
    opts.lookbackDays === undefined ? null : Math.max(1, Math.floor(opts.lookbackDays));
  const page = Math.max(1, Math.floor(opts.pageSize ?? 5000));
  // The archive is read before the transaction: no object-store call inside a database transaction.
  let archived: ArchivedAnchor[] = [];
  let archive: VerifyResult['archive'] = 'not_checked';
  if (opts.archive !== undefined) {
    try {
      archived = await readArchive(opts.archive, orgId, lookback);
      archive = 'checked';
    } catch {
      archive = 'unavailable';
    }
  }
  const graceMinutes = Math.max(0, Math.floor(opts.archiveGraceMinutes ?? 15));
  return db.withScope(systemScope(orgId), async (tx) => {
    const anchors = (
      await tx.query(
        `SELECT id, row_count, merkle_root, prev_hash, hash,
                to_char(from_ts AT TIME ZONE 'UTC', ${ISO_US}) AS from_text,
                to_char(to_ts AT TIME ZONE 'UTC', ${ISO_US}) AS to_text,
                (SELECT hash FROM audit.anchor p WHERE p.organisation_id = a.organisation_id AND p.to_ts < a.to_ts
                  ORDER BY p.to_ts DESC LIMIT 1) AS stored_prev_hash,
                (SELECT to_char(p.to_ts AT TIME ZONE 'UTC', ${ISO_US}) FROM audit.anchor p
                  WHERE p.organisation_id = a.organisation_id AND p.to_ts < a.to_ts ORDER BY p.to_ts DESC LIMIT 1) AS stored_prev_to
           FROM audit.anchor a
          WHERE a.organisation_id = $1::uuid AND ($2::int IS NULL OR a.created_at >= now() - make_interval(days => $2::int))
          ORDER BY a.to_ts`,
        [orgId, lookback],
      )
    ).rows;
    const mismatches: Mismatch[] = [];
    for (const a of anchors) {
      const id = String(a.id);
      const found = new Set<MismatchKind>();
      const prevStored = (a.stored_prev_hash as Buffer | null) ?? GENESIS_HASH;
      if (!(a.prev_hash as Buffer).equals(prevStored)) found.add('chain_link');
      if (a.stored_prev_to !== null && a.stored_prev_to !== a.from_text) found.add('chain_gap');
      const leaves: Buffer[] = [];
      let cursor: { at: string; id: string } | undefined;
      for (;;) {
        const params: unknown[] = [
          orgId,
          (a.from_text as string).replace('Z', '+00'),
          (a.to_text as string).replace('Z', '+00'),
          page,
        ];
        let after = '';
        if (cursor !== undefined) {
          params.push(cursor.at, cursor.id);
          after = ` AND (e.occurred_at, e.event_id) > ($5::timestamptz, $6::uuid)`;
        }
        const r = await tx.query(
          `SELECT audit.row_digest(e) AS d, e.event_id, to_char(e.occurred_at AT TIME ZONE 'UTC', ${ISO_US}) AS at
             FROM audit.event e
            WHERE e.organisation_id = $1::uuid AND e.occurred_at >= $2::timestamptz AND e.occurred_at < $3::timestamptz${after}
            ORDER BY e.occurred_at, e.event_id LIMIT $4`,
          params,
        );
        for (const row of r.rows) leaves.push(row.d as Buffer);
        if (r.rows.length < page) break;
        const lastRow = r.rows[r.rows.length - 1] as { event_id: string; at: string };
        cursor = { at: lastRow.at.replace('Z', '+00'), id: lastRow.event_id };
      }
      // A late row changes both the count and the root; the count is reported first because it names the cause.
      if (BigInt(leaves.length) !== BigInt(a.row_count as string)) found.add('row_count');
      const root = merkleRoot(leaves);
      if (!root.equals(a.merkle_root as Buffer)) found.add('root');
      const expected = anchorHash({
        prevHash: a.prev_hash as Buffer,
        fromTs: a.from_text as string,
        toTs: a.to_text as string,
        rowCount: BigInt(a.row_count as string),
        merkleRoot: a.merkle_root as Buffer,
      });
      if (!expected.equals(a.hash as Buffer)) found.add('hash');
      for (const kind of found) mismatches.push({ anchorId: id, kind });
    }
    let afterRestorePoint = 0;
    if (archive === 'checked') {
      const seen = new Set(mismatches.map((m) => `${m.anchorId}_${m.kind}`));
      const flag = (anchorId: string, kind: MismatchKind): void => {
        if (seen.has(`${anchorId}_${kind}`)) return;
        seen.add(`${anchorId}_${kind}`);
        mismatches.push({ anchorId, kind });
      };
      // 1. Archive -> database: the earliest version of every object must equal the database anchor byte for byte.
      const ids = archived.map((x) => x.idFromKey).filter((id) => /^\d{1,18}$/.test(id));
      const dbById = new Map<string, AnchorRow>();
      if (ids.length > 0) {
        const r = await tx.query(
          `SELECT ${ANCHOR_COLUMNS} FROM audit.anchor a WHERE a.organisation_id = $1::uuid AND a.id = ANY($2::bigint[])`,
          [orgId, ids],
        );
        for (const row of r.rows) {
          const a = anchorRowOf(row);
          dbById.set(a.id, a);
        }
      }
      const parsed: AnchorRow[] = [];
      for (const x of archived) {
        const body = parseArchived(x.body);
        if (body !== null) parsed.push(body);
        if (x.versions.length > 1) flag(x.idFromKey, 'archive_extra_version');
        const db = dbById.get(x.idFromKey);
        if (db === undefined) {
          if (body !== null && opts.restorePointAt !== undefined && body.toTs > opts.restorePointAt)
            afterRestorePoint++;
          else flag(x.idFromKey, 'db_differs_from_archive');
        } else if (anchorArchiveKey(db) !== x.key || !canonicalAnchorBody(db).equals(x.body)) {
          flag(x.idFromKey, 'db_differs_from_archive');
        }
      }
      // 3. The archived chain: each hash recomputes from its own fields and links to the archived predecessor.
      parsed.sort((x, y) => (x.toTs < y.toTs ? -1 : x.toTs > y.toTs ? 1 : 0));
      let prev: AnchorRow | undefined;
      for (const a of parsed) {
        const expected = anchorHash({
          prevHash: a.prevHash,
          fromTs: a.fromTs,
          toTs: a.toTs,
          rowCount: BigInt(a.rowCount),
          merkleRoot: a.merkleRoot,
        });
        if (!expected.equals(a.hash)) flag(a.id, 'hash');
        if (prev !== undefined) {
          if (!a.prevHash.equals(prev.hash)) flag(a.id, 'chain_link');
          if (a.fromTs !== prev.toTs) flag(a.id, 'chain_gap');
        }
        prev = a;
      }
      // 2. Database -> archive: every anchor older than the grace needs a receipt that resolves to its object.
      const listed = new Set(
        archived.flatMap((x) => x.versions.map((v) => `${x.key}\n${v.versionId}`)),
      );
      const due = (
        await tx.query(
          `SELECT ${ANCHOR_COLUMNS}, r.archive_key, r.version_id
             FROM audit.anchor a LEFT JOIN audit.anchor_archive_receipt r ON r.anchor_id = a.id
            WHERE a.organisation_id = $1::uuid AND a.created_at < now() - make_interval(mins => $3::int)
              AND ($2::int IS NULL OR a.created_at >= now() - make_interval(days => $2::int))`,
          [orgId, lookback, graceMinutes],
        )
      ).rows;
      for (const row of due) {
        const a = anchorRowOf(row);
        const ok =
          row['archive_key'] === anchorArchiveKey(a) &&
          listed.has(`${String(row['archive_key'])}\n${String(row['version_id'])}`);
        if (!ok) flag(a.id, 'not_archived');
      }
    }
    if (opts.queue !== undefined) {
      for (const m of mismatches) {
        await opts.queue.publish(
          tx,
          'audit.anchor_mismatch',
          { organisationId: orgId, anchorId: Number(m.anchorId), kind: m.kind },
          { jobKey: `${m.anchorId}_${m.kind}` },
        );
      }
    }
    const horizon = (
      await tx.query(
        `SELECT floor(extract(epoch FROM (max((substring(pg_get_expr(c.relpartbound, c.oid) FROM 'TO \\(''([^'']+)''\\)'))::timestamptz) - now())) / 86400)::int AS days
           FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
          WHERE i.inhparent = 'audit.event'::regclass AND pg_get_expr(c.relpartbound, c.oid) LIKE 'FOR VALUES%'`,
      )
    ).rows[0] as { days: number | null };
    return {
      checked: anchors.length,
      mismatches,
      partitionHorizonDays: horizon.days,
      archive,
      archivedChecked: archived.length,
      afterRestorePoint,
    };
  });
}
