// Prints the catalog state and the answers of the two definers on a database migrated from empty (2203/2204 applied), as psql-style raw output.
//   EHR_TEST_ADMIN_URL=postgres://postgres@127.0.0.1:55432/postgres node transcript.mjs <database>
import pg from 'pg';
const admin = new URL(process.env.EHR_TEST_ADMIN_URL);
admin.pathname = `/${process.argv[2]}`;
const c = new pg.Client({ connectionString: admin.toString() });
await c.connect();
const show = async (title, sql, params = []) => {
  console.log(`\n-- ${title}\n${sql.trim().replace(/\s+/g, ' ')}`);
  try {
    const r = await c.query(sql, params);
    console.table(r.rows.length ? r.rows : [{ '(rows)': 0 }]);
  } catch (e) {
    console.log(`ERROR ${e.code}: ${e.message}`);
  }
};
console.log((await c.query('select version() v')).rows[0].v);
await show('functions in schema messaging', `SELECT p.oid::regprocedure::text AS fn, pg_get_userbyid(proowner) AS owner, prosecdef, provolatile, proconfig, proacl FROM pg_proc p WHERE pronamespace = 'messaging'::regnamespace AND (prosecdef OR proname LIKE 'is_%') ORDER BY 1`);
await show('is_creator anywhere', `SELECT count(*) AS n FROM pg_proc WHERE proname = 'is_creator'`);
await show('policies for patient_scope_owner', `SELECT tablename, policyname, cmd, qual FROM pg_policies WHERE schemaname='messaging' AND 'patient_scope_owner' = ANY(roles)`);
await show('table privileges of patient_scope_owner in messaging', `SELECT c.oid::regclass::text AS tbl, p AS priv FROM pg_class c CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p WHERE c.relnamespace='messaging'::regnamespace AND c.relkind='r' AND has_table_privilege('patient_scope_owner', c.oid, p)`);
await show('column SELECT privilege of patient_scope_owner', `SELECT c.oid::regclass::text AS tbl, a.attname::text AS col FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped WHERE c.relnamespace='messaging'::regnamespace AND c.relkind='r' AND has_column_privilege('patient_scope_owner', c.oid, a.attnum, 'SELECT') ORDER BY 1,2`);
await show('GRANT OPTION held by patient_scope_owner in messaging', `SELECT count(*) AS n FROM (SELECT (aclexplode(relacl)).* FROM pg_class WHERE relnamespace='messaging'::regnamespace) x WHERE is_grantable AND grantee='patient_scope_owner'::regrole`);
await show('patient_scope_owner role', `SELECT rolname, rolsuper, rolbypassrls, rolcanlogin, rolcreaterole FROM pg_roles WHERE rolname='patient_scope_owner'`);
await show('policies that mention the invoker EXISTS replacing is_creator', `SELECT policyname, cmd, with_check, qual FROM pg_policies WHERE schemaname='messaging' AND policyname LIKE 'participant_owner_%'`);
await show('migration tracker 2200-2204', `SELECT version, name FROM migration.schema_migration WHERE version BETWEEN 2200 AND 2204 ORDER BY 1`).catch(() => {});
await c.end();
