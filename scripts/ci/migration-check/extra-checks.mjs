#!/usr/bin/env node
// Checks of DEVOPS-PLAN 5.2 (DPR-13, M-1) that db/tools/catalog-check.mjs does not run. Same report shape
// ({server, checks:[{id,title,status,violations}]}), so verify-catalog.mjs reads both. Catalog reads only.
//   EHR_DB_ADMIN_URL=postgres://... node extra-checks.mjs
import pg from 'pg';

const url = process.env.EHR_DB_ADMIN_URL;
if (!url) {
  console.error('EHR_DB_ADMIN_URL is not set');
  process.exit(2);
}
const userSchemas = `(SELECT oid FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema')`;
// HEAAA-594 (INT05-F06): a trusted extension created by app_owner has its member objects owned by the bootstrap
// superuser (OID 10), not by app_owner and not by anything the administrator created. Only such members of these
// extensions, whose own owner is app_owner, are exempt from X-admin-owns-nothing. Changed only by a reviewed
// Solution Architect decision; X-extensions-allowlisted fails on any other extension.
const EXTENSION_ALLOWLIST = [
  ['btree_gist', 'scheduling', 'app_owner'],
  ['pg_trgm', 'clinical', 'app_owner'],
];
const extensionMember = (alias, ownerCol, catalog) => `(${alias}.${ownerCol} = 10 AND EXISTS (
            SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid = d.refobjid
            WHERE d.classid = '${catalog}'::regclass AND d.objid = ${alias}.oid
              AND d.refclassid = 'pg_extension'::regclass AND d.deptype = 'e'
              AND e.extname = ANY (ARRAY[${EXTENSION_ALLOWLIST.map(([n]) => `'${n}'`).join(',')}])
              AND e.extowner = 'app_owner'::regrole))`;
const checks = {
  'X-bypassrls': {
    title:
      'no role other than a superuser has BYPASSRLS (application roles never bypass row security)',
    sql: `SELECT rolname FROM pg_roles WHERE rolbypassrls AND NOT rolsuper AND rolname !~ '^pg_'`,
  },
  'X-admin-owns-nothing': {
    title:
      'the administrator that ran db/roles (stands in for the RDS master user) owns no object in a user schema (M-1); members of allow-listed extensions created by app_owner, which PostgreSQL assigns to the bootstrap superuser, are not counted',
    sql: `SELECT c.oid::regclass::text AS object FROM pg_class c WHERE c.relnamespace IN ${userSchemas} AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = session_user)
            AND NOT ${extensionMember('c', 'relowner', 'pg_class')}
          UNION ALL
          SELECT p.oid::regprocedure::text FROM pg_proc p WHERE p.pronamespace IN ${userSchemas} AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = session_user)
            AND NOT ${extensionMember('p', 'proowner', 'pg_proc')}
          UNION ALL
          SELECT n.nspname FROM pg_namespace n WHERE n.oid IN ${userSchemas} AND n.nspowner = (SELECT oid FROM pg_roles WHERE rolname = session_user)`,
  },
  'X-extensions-allowlisted': {
    title:
      'installed extensions are exactly the allow-list (name, schema, owner app_owner) of decision HEAAA-594',
    sql: `SELECT e.extname, e.extnamespace::regnamespace::text AS schema, pg_get_userbyid(e.extowner) AS owner
          FROM pg_extension e
          WHERE e.extname <> 'plpgsql'
            AND (e.extname, e.extnamespace::regnamespace::text, pg_get_userbyid(e.extowner))
                NOT IN (${EXTENSION_ALLOWLIST.map(([n, s, o]) => `('${n}','${s}','${o}')`).join(', ')})`,
  },
  'X-no-superuser-membership': {
    title: 'no application or function-owner role is a member of a superuser or rds_superuser role',
    sql: `SELECT m.rolname AS member, r.rolname AS role FROM pg_auth_members am
          JOIN pg_roles m ON m.oid = am.member JOIN pg_roles r ON r.oid = am.roleid
          WHERE (r.rolsuper OR r.rolname IN ('rds_superuser','rdsadmin'))
            AND m.rolname = ANY (ARRAY['app_owner','app_api','app_worker','reporting_ro','audit_archiver',
              'scheduling_booking_owner','patient_scope_owner','patient_match_owner','integration_receiver_owner',
              'queue_owner','identity_signin_ro','directory_ro','app_bootstrap','identity_bootstrap_owner'])`,
  },
};
const db = new pg.Client({ connectionString: url, application_name: 'extra-checks' });
await db.connect();
try {
  const report = [];
  for (const [id, c] of Object.entries(checks)) {
    const r = await db.query(c.sql);
    report.push({
      id,
      title: c.title,
      status: r.rows.length === 0 ? 'pass' : 'fail',
      violations: r.rows,
    });
  }
  const server = (await db.query('SELECT version() AS v')).rows[0].v;
  console.log(JSON.stringify({ server, checks: report }, null, 2));
  process.exitCode = report.every((c) => c.status === 'pass') ? 0 : 1;
} finally {
  await db.end();
}
