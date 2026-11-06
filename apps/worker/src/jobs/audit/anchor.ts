// audit.anchor (every minute, key = to_ts). Takes the rows older than the safe watermark (now - 2 min; the longest a
// transaction can run before commit is the 60 s transaction_timeout, so no older row can still commit), builds a Merkle
// root over them in (occurred_at, event_id) order and writes one anchor chained to the previous one.
import type { KernelDb } from '@ehr/kernel';
import { anchorHash, GENESIS_HASH, merkleRoot } from './merkle.js';
import { ISO_US, systemScope } from './scope.js';

export interface AnchorOptions {
  /** Safe watermark in seconds behind the database clock. Production: 120 (SAR-10). Tests may lower it. */
  watermarkSeconds?: number;
  /** Longest range one anchor covers, so a worker that was down catches up in steps inside the transaction bound. */
  maxRangeSeconds?: number;
  pageSize?: number;
}

export type AnchorResult =
  | { status: 'skipped'; reason: 'locked' | 'up_to_date' | 'no_events' }
  | { status: 'anchored'; anchorId: string; rowCount: number; lateRows: number; toTs: string };

const STEP = (n: number): number => Math.max(1, Math.floor(n));

export async function runAnchor(
  db: KernelDb,
  orgId: string,
  opts: AnchorOptions = {},
): Promise<AnchorResult> {
  // A negative watermark is a test hook (closes the current minute); no production path sets it.
  const watermark = Math.floor(opts.watermarkSeconds ?? 120);
  const maxRange = STEP(opts.maxRangeSeconds ?? 3600);
  const page = STEP(opts.pageSize ?? 5000);
  return db.withScope(systemScope(orgId), async (tx) => {
    // One anchor writer at a time per organisation: a second worker skips instead of forking the chain.
    const lock = await tx.query(
      `SELECT pg_try_advisory_xact_lock(hashtextextended('audit.anchor:' || $1::text, 0)) AS ok`,
      [orgId],
    );
    if (lock.rows[0]?.ok !== true) return { status: 'skipped', reason: 'locked' } as const;

    const last = (
      await tx.query(
        `SELECT id, hash, row_count, to_char(from_ts AT TIME ZONE 'UTC', ${ISO_US}) AS from_text,
                to_char(to_ts AT TIME ZONE 'UTC', ${ISO_US}) AS to_text, from_ts, to_ts
           FROM audit.anchor WHERE organisation_id = $1::uuid ORDER BY to_ts DESC LIMIT 1`,
        [orgId],
      )
    ).rows[0];
    let fromText: string;
    if (last !== undefined) {
      fromText = last.to_text as string;
    } else {
      const first = (
        await tx.query(
          `SELECT to_char(date_trunc('minute', min(occurred_at)) AT TIME ZONE 'UTC', ${ISO_US}) AS t
             FROM audit.event WHERE organisation_id = $1::uuid`,
          [orgId],
        )
      ).rows[0];
      if (first?.t === null || first?.t === undefined)
        return { status: 'skipped', reason: 'no_events' } as const;
      fromText = first.t as string;
    }
    const bounds = (
      await tx.query(
        `WITH w AS (SELECT date_trunc('minute', clock_timestamp() - make_interval(secs => $2::int)) AS wm,
                           $1::timestamptz AS f)
         SELECT to_char(least(wm, f + make_interval(secs => $3::int)) AT TIME ZONE 'UTC', ${ISO_US}) AS to_text,
                (least(wm, f + make_interval(secs => $3::int)) > f) AS ok
           FROM w`,
        [fromText.replace('Z', '+00'), watermark, maxRange],
      )
    ).rows[0] as { to_text: string; ok: boolean };
    if (!bounds.ok) return { status: 'skipped', reason: 'up_to_date' } as const;
    const toText = bounds.to_text;

    // Rows of [from, to) in a fixed order, a page at a time (keyset), leaves = audit.row_digest.
    const leaves: Buffer[] = [];
    let cursor: { at: string; id: string } | undefined;
    for (;;) {
      const params: unknown[] = [
        orgId,
        fromText.replace('Z', '+00'),
        toText.replace('Z', '+00'),
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

    // A row that committed behind the watermark despite the limits shows up as growth of the previous window; it is
    // counted and flagged on this anchor (the verification job reports the previous anchor as mismatching).
    let lateRows = 0;
    if (last !== undefined) {
      const c = (
        await tx.query(
          `SELECT count(*)::bigint AS n FROM audit.event
            WHERE organisation_id = $1::uuid AND occurred_at >= $2::timestamptz AND occurred_at < $3::timestamptz`,
          [orgId, last.from_ts, last.to_ts],
        )
      ).rows[0] as { n: string };
      lateRows = Math.max(0, Number(c.n) - Number(last.row_count));
    }

    const root = merkleRoot(leaves);
    const prevHash = last === undefined ? GENESIS_HASH : (last.hash as Buffer);
    const hash = anchorHash({
      prevHash,
      fromTs: fromText,
      toTs: toText,
      rowCount: BigInt(leaves.length),
      merkleRoot: root,
    });
    const ins = await tx.query(
      `INSERT INTO audit.anchor (organisation_id, from_ts, to_ts, row_count, merkle_root, prev_hash, hash, late_rows)
       VALUES ($1, $2::timestamptz, $3::timestamptz, $4, $5, $6, $7, $8) RETURNING id`,
      [
        orgId,
        fromText.replace('Z', '+00'),
        toText.replace('Z', '+00'),
        leaves.length,
        root,
        prevHash,
        hash,
        lateRows,
      ],
    );
    return {
      status: 'anchored',
      anchorId: String(ins.rows[0]?.id),
      rowCount: leaves.length,
      lateRows,
      toTs: toText,
    } as const;
  });
}
