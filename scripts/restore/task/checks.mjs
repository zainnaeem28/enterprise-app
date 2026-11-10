// The checks the in-VPC task runs against the restored instance (DEVOPS-PLAN 10.3 step 3). Each takes an injected
// `query(sql, params)` and returns { status, reason, violations?, counts?, hashes? } built from numbers, digests and
// closed-list codes only. Error messages are never copied into a result: a database error can echo a value.
import { createHash } from 'node:crypto';

const IDENT = /^[a-z_][a-z0-9_]*$/;
const sha = (s) => createHash('sha256').update(s).digest('hex');

/** "schema.table" -> quoted identifier; anything but plain lowercase identifiers is refused (the list is code, but be strict). */
export function qualified(name) {
  const parts = name.split('.');
  if (parts.length !== 2 || !parts.every((p) => IDENT.test(p)))
    throw new Error('table name is not schema.table');
  return parts.map((p) => `"${p}"`).join('.');
}
/** A role name from the catalogue, quoted; plain identifiers only (a base64url password contains no quote). */
export function ident(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name))
    throw new Error('role name is not a plain identifier');
  return `"${name}"`;
}
const col = (c) => {
  if (!IDENT.test(c)) throw new Error('column name is not a plain identifier');
  return `"${c}"`;
};
const key = (name) => name.replace('.', '_');

export async function schemaVersion(query, baseline) {
  const { rows } = await query(
    'SELECT version::text AS v, sha256 AS h FROM migration.schema_migration ORDER BY version',
  );
  const digest = sha(rows.map((r) => `${r.v}:${r.h}`).join('\n'));
  const out = { counts: { migrations: rows.length }, hashes: { migration_set: digest } };
  if (!baseline?.schema) return { status: 'partial', reason: 'baseline_unavailable', ...out };
  const same =
    baseline.schema.migration_set === digest && baseline.schema.migrations === rows.length;
  return same
    ? { status: 'pass', reason: 'none', ...out }
    : { status: 'fail', reason: 'schema_hash_mismatch', ...out };
}

/** Catalogue and role checks of 5.2 against the restored instance. `runChecks` is db/tools/catalog-check.mjs's. */
export async function catalogue(runChecks, db) {
  const report = await runChecks(db);
  const bad = report.filter((c) => c.status !== 'pass');
  const counts = Object.fromEntries(
    report.map((c) => [c.id.toLowerCase().replaceAll('-', '_'), c.violations.length]),
  );
  return bad.length
    ? {
        status: 'fail',
        reason: 'catalogue_violation',
        violations: bad.reduce((n, c) => n + c.violations.length, 0),
        counts,
      }
    : { status: 'pass', reason: 'none', violations: 0, counts };
}

async function tableDigest(query, t, modulus, watermark) {
  const tbl = qualified(t.name);
  const where = [];
  const params = [];
  if (watermark && t.ts) {
    params.push(watermark);
    where.push(`${col(t.ts)} <= $${params.length}`);
  }
  if (t.pk) where.push(`mod(abs(hashtextextended(${col(t.pk)}::text, 0)), ${Number(modulus)}) = 0`);
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const exists = await query('SELECT to_regclass($1) IS NOT NULL AS ok', [t.name]);
  if (!exists.rows[0].ok) return null;
  const total = await query(
    `SELECT count(*)::bigint AS n FROM ${tbl} ${watermark && t.ts ? `WHERE ${col(t.ts)} <= $1` : ''}`,
    watermark && t.ts ? [watermark] : [],
  );
  const sample = await query(
    `SELECT count(*)::bigint AS n, coalesce(sum(hashtextextended(x::text, 0)::numeric), 0)::text AS s FROM ${tbl} x ${w}`,
    params,
  );
  return {
    count: Number(total.rows[0].n),
    sampleCount: Number(sample.rows[0].n),
    digest: sha(`${t.name}:${sample.rows[0].s}`),
  };
}

/** Row counts and sampled checksums. Immutable tables compare exactly up to the watermark; mutable ones allow bounded drift. */
export async function rowsAndChecksums(query, { tables, sample_modulus }, baseline) {
  const counts = {};
  const hashes = {};
  let missing = 0;
  let immutableBad = 0;
  let driftBad = 0;
  let noBaseline = 0;
  const watermark = baseline?.watermark ?? null;
  for (const t of tables) {
    const d = await tableDigest(
      query,
      t,
      sample_modulus,
      t.class === 'immutable' ? watermark : null,
    );
    if (!d) {
      missing += 1;
      continue;
    }
    counts[key(t.name)] = d.count;
    hashes[key(t.name)] = d.digest;
    const b = baseline?.tables?.[t.name];
    if (!b) {
      noBaseline += 1;
    } else if (t.class === 'immutable') {
      if (b.count !== d.count || b.digest !== d.digest) immutableBad += 1;
    } else if (Math.abs(d.count - b.count) > Math.max(1, b.count) * (t.max_drift_ratio ?? 0)) {
      driftBad += 1;
    }
  }
  const violations = missing + immutableBad + driftBad;
  const shape = { violations, counts, hashes };
  if (missing || immutableBad) return { status: 'fail', reason: 'immutable_mismatch', ...shape };
  if (driftBad) return { status: 'fail', reason: 'mutable_drift_exceeded', ...shape };
  if (noBaseline) return { status: 'partial', reason: 'baseline_unavailable', ...shape };
  return { status: 'pass', reason: 'none', ...shape };
}

/**
 * Audit anchor chain to the restore point (ARCHITECTURE 6). Structural checks that need no knowledge of the hash formula:
 * ids ascending, each anchor's prev_hash is the previous anchor's hash, ranges do not go backwards, and row_count equals the
 * rows that carry the anchor id. Recomputing the Merkle root is the audit module's verifier (`verifyChain`), loaded when
 * the image has it; without it the check is `partial`, never `pass`.
 */
export async function auditAnchorChain(query, verifier) {
  const exists = await query(
    "SELECT to_regclass('audit.anchor') IS NOT NULL AND to_regclass('audit.event') IS NOT NULL AS ok",
  );
  if (!exists.rows[0].ok) return { status: 'fail', reason: 'audit_schema_missing', violations: 1 };
  const { rows } = await query(
    `SELECT a.id::text AS id, encode(a.prev_hash, 'hex') AS prev, encode(a.hash, 'hex') AS h, a.row_count::bigint AS n,
            a.from_ts, a.to_ts, (SELECT count(*) FROM audit.event e WHERE e.anchor_id = a.id)::bigint AS actual
       FROM audit.anchor a ORDER BY a.id`,
  );
  let violations = 0;
  rows.forEach((r, i) => {
    const prev = rows[i - 1];
    if (prev && r.prev !== prev.h) violations += 1;
    if (prev && new Date(r.from_ts) < new Date(prev.to_ts)) violations += 1;
    if (Number(r.n) !== Number(r.actual)) violations += 1;
  });
  const counts = { anchors: rows.length };
  const hashes = rows.length ? { last_anchor: sha(rows[rows.length - 1].h) } : undefined;
  if (violations)
    return { status: 'fail', reason: 'immutable_mismatch', violations, counts, hashes };
  if (!verifier)
    return {
      status: 'partial',
      reason: 'merkle_recompute_unavailable',
      violations: 0,
      counts,
      hashes,
    };
  const v = await verifier.verifyChain(query);
  return v === true
    ? { status: 'pass', reason: 'none', violations: 0, counts, hashes }
    : { status: 'fail', reason: 'immutable_mismatch', violations: 1, counts, hashes };
}

/** Read-only smoke as the application role: the same client path, a read-only transaction, nothing written. */
export async function appSmoke(query) {
  await query('SET default_transaction_read_only = on');
  const r = await query('SELECT count(*)::bigint AS n FROM migration.schema_migration');
  return Number(r.rows[0].n) > 0
    ? { status: 'pass', reason: 'none', counts: { migrations_visible: Number(r.rows[0].n) } }
    : { status: 'fail', reason: 'smoke_failed', violations: 1 };
}
