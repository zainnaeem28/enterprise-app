// audit.verify_anchors (daily, key = date). Recomputes every anchor (or the optional lookback window) from the stored rows and checks the chain. A
// changed, removed or added row in an anchored range, a broken link or a gap raises `audit.anchor_mismatch` (the
// notifications handler turns it into the `audit_anchor_mismatch` staff alert, 22.13).
import type { KernelDb, Queue } from '@ehr/kernel';
import { anchorHash, GENESIS_HASH, merkleRoot } from './merkle.js';
import { ISO_US, systemScope } from './scope.js';

export type MismatchKind = 'row_count' | 'root' | 'hash' | 'chain_link' | 'chain_gap';

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
}

export interface VerifyResult {
  checked: number;
  mismatches: Mismatch[];
  /** Days of partitions left after the newest partition bound; null when no partition has a bound. */
  partitionHorizonDays: number | null;
}

export async function runVerify(
  db: KernelDb,
  orgId: string,
  opts: VerifyOptions = {},
): Promise<VerifyResult> {
  const lookback =
    opts.lookbackDays === undefined ? null : Math.max(1, Math.floor(opts.lookbackDays));
  const page = Math.max(1, Math.floor(opts.pageSize ?? 5000));
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
    return { checked: anchors.length, mismatches, partitionHorizonDays: horizon.days };
  });
}
