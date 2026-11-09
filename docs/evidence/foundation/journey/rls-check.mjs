// F-07 evidence: the database half of the journey, run inside the API image as app_api (the API's own login role).
// Prints one JSON line per assertion; exits 1 on any failure.
import pg from 'pg';
import { KernelDb } from '@ehr/kernel';

const ORG = process.env.JOURNEY_ORG_ID;
const OTHER = '00000000-0000-7000-8000-0000000000a2';
const pool = new pg.Pool({ connectionString: process.env.EHR_DATABASE_URL, max: 2 });
const db = new KernelDb(pool);
const results = [];
const check = async (name, fn) => {
  try {
    const detail = await fn();
    results.push({ name, pass: true, detail });
  } catch (e) {
    results.push({ name, pass: false, detail: String(e?.message ?? e) });
  }
};
await check('scoped read sees only its own organisation counters (>=1 row written by the journey)', async () => {
  const rows = await db.withScope({ audience: 'anonymous', orgId: ORG }, async (tx) => (await tx.query('SELECT organisation_id, count FROM kernel.rate_counter')).rows);
  if (rows.length < 1) throw new Error('no counter row written by the journey');
  if (rows.some((r) => r.organisation_id !== ORG)) throw new Error('row of another organisation visible');
  return { rows: rows.length, totalHits: rows.reduce((a, r) => a + Number(r.count), 0) };
});
await check('another organisation scope sees none of those rows (RLS)', async () => {
  const rows = await db.withScope({ audience: 'anonymous', orgId: OTHER }, async (tx) => (await tx.query('SELECT 1 FROM kernel.rate_counter')).rows);
  if (rows.length !== 0) throw new Error(`${rows.length} rows visible`);
  return { rows: 0 };
});
await check('writing another organisation counters is refused with 42501 (RLS WITH CHECK)', async () => {
  try {
    await db.withScope({ audience: 'anonymous', orgId: ORG }, (tx) => tx.query(`INSERT INTO kernel.rate_counter (organisation_id, key, window_start, count) VALUES ('${OTHER}', 'x', now(), 1)`));
  } catch (e) {
    if (e.code === '42501') return { sqlstate: '42501' };
    throw e;
  }
  throw new Error('insert was accepted');
});
await check('no scope set: app_api sees no counter rows', async () => {
  const r = await pool.query('SELECT count(*)::int AS n FROM kernel.rate_counter');
  if (r.rows[0].n !== 0) throw new Error(`${r.rows[0].n} rows visible without scope`);
  return { rows: 0 };
});
await pool.end();
for (const r of results) console.log(JSON.stringify(r));
process.exit(results.every((r) => r.pass) ? 0 : 1);
