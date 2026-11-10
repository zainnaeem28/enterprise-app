// Direct database access under a NAMED role and explicit scope settings (TEST-CASES 6: "a test that only exercises the API cannot
// show that row-level security works"). ENV-INT/ci: the throwaway database with the real migrations and the real roles.
import { asRole, sql, state, ORG } from '../../identity/lib/ctx.mjs';
import { createRequire } from 'node:module';

const root = new URL('../../../../', import.meta.url).pathname;
const pg = createRequire(root + 'package.json')('pg');

/** One attempt in a savepoint: {ok, rows, rowCount} or {ok:false, code, message}. The attempt never leaves a change behind. */
export async function attempt(c, text, params = []) {
  await c.query('SAVEPOINT qa03');
  try {
    const r = await c.query(text, params);
    return { ok: true, rows: r.rows, rowCount: r.rowCount };
  } catch (e) {
    return { ok: false, code: e.code, message: e.message };
  } finally {
    await c.query('ROLLBACK TO SAVEPOINT qa03');
  }
}

const KEYS = ['app.org_id', 'app.principal_id', 'app.person_id', 'app.audience', 'app.realm', 'app.location_ids', 'app.patient_ids', 'app.proxy_patient_ids', 'app.btg_patient_ids', 'app.compliance_scopes', 'app.phi_access'];

/** Runs fn(c) as login role `role` inside one transaction with the given app.* settings, then rolls back. */
export function asScope(role, settings, fn) {
  return asRole(role, async (c) => {
    await c.query('BEGIN');
    try {
      for (const k of KEYS) await c.query('SELECT set_config($1,$2,true)', [k, settings[k] ?? '']);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
    }
  });
}

/** As the database administrator, switch to a NOLOGIN function-owner role (SET ROLE) with settings, then roll back. */
export async function asOwner(roleName, settings, fn) {
  const u = new URL(process.env.EHR_TEST_ADMIN_URL);
  u.pathname = '/' + state().db;
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  try {
    await c.query('BEGIN');
    for (const k of KEYS) await c.query('SELECT set_config($1,$2,true)', [k, settings[k] ?? '']);
    await c.query(`SET LOCAL ROLE ${roleName}`);
    return await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    await c.end();
  }
}

/** Every ordinary/partitioned table, view and materialized view outside the system schemas (partitions are covered by their parent). */
export async function relations() {
  const r = await sql(`SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced, c.reloptions AS options, obj_description(c.oid) AS comment, pg_get_userbyid(c.relowner) AS owner
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r','p','v','m') AND NOT c.relispartition AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
     ORDER BY 1, 2`);
  return r.rows;
}
export { ORG };

/** Relations that can hold personal or clinical data: C2/C3 tables (the table comment carries the data class) and every view outside the C0 directory views. */
export const isPhi = (r) => (r.kind === 'v' || r.kind === 'm' ? r.owner !== 'directory_ro' : /C[23]/.test(r.comment ?? 'C3'));
