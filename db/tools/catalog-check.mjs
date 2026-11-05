#!/usr/bin/env node
// Catalog checks M-1..M-5 (SHARED-BOUNDARIES 6.2) and the role checks of DEVOPS-PLAN 5.2 / ARCHITECTURE 21.2,
// run against a freshly migrated database. Reads the catalog only. Prints a JSON report; exit 1 on any violation.
//   EHR_DB_ADMIN_URL=postgres://... node db/tools/catalog-check.mjs
import * as L from './catalog-lists.mjs';
import { connect, requireEnv } from './pg.mjs';

const q = (list) => `ARRAY[${list.map((x) => `'${x}'`).join(',')}]::text[]`;
const modSchemas = `(SELECT n.oid FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND n.nspname <> ALL (${q(L.skippedSchemas)}))`;

/** id -> { title, sql }: every row the SQL returns is one violation. */
export const checks = {
  'ENV-pg17': {
    title: 'server is PostgreSQL 17 or later',
    sql: `SELECT current_setting('server_version') AS version WHERE current_setting('server_version_num')::int < 170000`,
  },
  'R-roles': {
    title: 'every role of ARCHITECTURE 21.2 exists',
    sql: `SELECT r AS missing FROM unnest(${q([...L.loginRoles, ...L.noLoginRoles])}) r WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r)`,
  },
  'R-attributes': {
    title:
      'no role is superuser/BYPASSRLS/CREATEROLE/CREATEDB/REPLICATION; function-owner, signin and directory roles are NOLOGIN, the others LOGIN',
    sql: `SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolcanlogin FROM pg_roles
          WHERE rolname = ANY (${q([...L.loginRoles, ...L.noLoginRoles])})
            AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication
                 OR (rolname = ANY (${q(L.noLoginRoles)}) AND rolcanlogin)
                 OR (rolname = ANY (${q(L.loginRoles)}) AND NOT rolcanlogin))`,
  },
  'R-no-owned-tables': {
    title: 'no application role owns a table, view, sequence or schema',
    sql: `SELECT c.oid::regclass::text AS object, pg_get_userbyid(c.relowner) AS owner FROM pg_class c
          WHERE c.relkind IN ('r','p','v','m','f','S') AND pg_get_userbyid(c.relowner) = ANY (${q(L.appRoles)})
          UNION ALL
          SELECT n.nspname, pg_get_userbyid(n.nspowner) FROM pg_namespace n WHERE pg_get_userbyid(n.nspowner) = ANY (${q(L.appRoles)})`,
  },
  'R-memberships': {
    title:
      'role memberships are exactly the SET-only grants of ARCHITECTURE 21.2 (no INHERIT, no ADMIN, nothing else)',
    sql: `WITH expected(member, role) AS (VALUES ${Object.entries(L.expectedMemberships)
      .flatMap(([m, rs]) => rs.map((r) => `('${m}','${r}')`))
      .join(',')}),
          actual AS (
            SELECT m.rolname AS member, r.rolname AS role, am.set_option, am.inherit_option, am.admin_option
            FROM pg_auth_members am JOIN pg_roles m ON m.oid = am.member JOIN pg_roles r ON r.oid = am.roleid
            WHERE (m.rolname = ANY (${q([...L.loginRoles, ...L.noLoginRoles])}) OR r.rolname = ANY (${q([...L.loginRoles, ...L.noLoginRoles])}))
              AND m.rolname <> session_user AND r.rolname !~ '^pg_')
          SELECT 'unexpected-or-wrong-options' AS problem, member, role FROM actual a
            WHERE NOT EXISTS (SELECT 1 FROM expected e WHERE e.member = a.member AND e.role = a.role)
               OR NOT a.set_option OR a.inherit_option OR a.admin_option
          UNION ALL
          SELECT 'missing', member, role FROM expected e
            WHERE NOT EXISTS (SELECT 1 FROM actual a WHERE e.member = a.member AND e.role = a.role)`,
  },
  'R-timeouts': {
    title: 'every audit-writing role has a role-level transaction_timeout of 1..60 s (SAR-10)',
    sql: `SELECT r AS role FROM unnest(${q(L.auditWritingRoles)}) r
          WHERE NOT EXISTS (
            SELECT 1 FROM pg_roles ro, unnest(ro.rolconfig) c
            WHERE ro.rolname = r AND c LIKE 'transaction_timeout=%'
              AND substring(c FROM 'transaction_timeout=(.*)') ~ '^(60s|60000ms|1min|[1-5]?[0-9]s|[1-5]?[0-9]000ms)$')`,
  },
  'R-app-owner-no-audit-insert': {
    title: 'app_owner has no INSERT on any audit table',
    sql: `SELECT c.oid::regclass::text AS object FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'audit' AND c.relkind IN ('r','p') AND has_table_privilege('app_owner', c.oid, 'INSERT')`,
  },
  'M-1': {
    title: 'every module/kernel table has ENABLE and FORCE ROW LEVEL SECURITY',
    sql: `SELECT c.oid::regclass::text AS object, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced FROM pg_class c
          WHERE c.relnamespace IN ${modSchemas} AND c.relkind IN ('r','p') AND NOT c.relispartition
            AND NOT (c.relrowsecurity AND c.relforcerowsecurity)`,
  },
  'M-1-kernel': {
    title: 'the four kernel tables of ARCHITECTURE 22.1 exist',
    sql: `SELECT t AS missing FROM unnest(ARRAY['idempotency_key','setting','reference_data_version','rate_counter']) t
          WHERE NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace = 'kernel'::regnamespace AND c.relname = t AND c.relkind = 'r')`,
  },
  'M-2': {
    title: 'no policy is TO PUBLIC; every policy names its roles',
    sql: `SELECT schemaname || '.' || tablename AS "table", policyname FROM pg_policies
          WHERE schemaname NOT LIKE 'pg\\_%' AND (roles = '{public}' OR roles = '{}' OR 'public' = ANY (roles))`,
  },
  'M-3': {
    title:
      'policies target only known roles; identity_signin_ro and directory_ro hold no table-level SELECT (column grants only)',
    sql: `SELECT schemaname || '.' || tablename AS "table", policyname, r AS role FROM pg_policies, unnest(roles) r
          WHERE schemaname NOT LIKE 'pg\\_%' AND NOT (r = ANY (${q(L.policyRoles)}))
          UNION ALL
          SELECT c.oid::regclass::text, 'table-level SELECT', r.rolname FROM pg_class c, pg_roles r
          WHERE c.relnamespace IN ${modSchemas} AND c.relkind IN ('r','p','v','m')
            AND r.rolname IN ('identity_signin_ro','directory_ro') AND has_table_privilege(r.oid, c.oid, 'SELECT')`,
  },
  'M-4-views': {
    title: 'every view not on the C0/C1 owner-rights list has security_invoker = true',
    sql: `SELECT c.oid::regclass::text AS view FROM pg_class c
          WHERE c.relnamespace IN ${modSchemas} AND c.relkind IN ('v','m')
            AND NOT coalesce('security_invoker=true' = ANY (c.reloptions), false)
            AND NOT (c.oid::regclass::text = ANY (${q(L.ownerRightsViews)}))`,
  },
  'M-4-reporting': {
    title:
      'reporting_ro holds a privilege on nothing outside the C0/C1 list (tables, views, columns)',
    sql: `SELECT c.oid::regclass::text AS object FROM pg_class c
          WHERE c.relnamespace IN ${modSchemas} AND c.relkind IN ('r','p','v','m','S','f')
            AND NOT (c.oid::regclass::text = ANY (${q(L.reportingViews)}))
            AND (has_table_privilege('reporting_ro', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                 OR EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0
                            AND has_column_privilege('reporting_ro', c.oid, a.attnum, 'SELECT,INSERT,UPDATE,REFERENCES')))`,
  },
  'M-5-patient-guard': {
    title: 'every table with a patient_id column has the merge write guard or is exempt',
    sql: `SELECT c.oid::regclass::text AS "table" FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'patient_id' AND NOT a.attisdropped
          WHERE c.relnamespace IN ${modSchemas} AND c.relkind IN ('r','p') AND NOT c.relispartition
            AND NOT (c.oid::regclass::text = ANY (${q(L.patientGuardExempt)}))
            AND NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
                            WHERE t.tgrelid = c.oid AND NOT t.tgisinternal AND p.proname = 'guard_open_patient')`,
  },
  'M-5-definer': {
    title:
      'every SECURITY DEFINER function is in the inventory, has a fixed search_path and a NOLOGIN owner',
    sql: `SELECT p.oid::regprocedure::text AS function,
                 (p.oid::regproc::text = ANY (${q(L.definerInventory)})) AS in_inventory,
                 (SELECT bool_or(c LIKE 'search_path=%') FROM unnest(p.proconfig) c) AS fixed_search_path,
                 pg_get_userbyid(p.proowner) AS owner
          FROM pg_proc p WHERE p.prosecdef AND p.pronamespace IN ${modSchemas}
            AND (NOT (p.oid::regproc::text = ANY (${q(L.definerInventory)}))
                 OR NOT coalesce((SELECT bool_or(c LIKE 'search_path=%') FROM unnest(p.proconfig) c), false)
                 OR (SELECT rolcanlogin FROM pg_roles WHERE oid = p.proowner))`,
  },
  'M-5-anonymous': {
    title: 'the policies that can match audience anonymous are exactly the ARCHITECTURE 21.3 list',
    sql: policySetSql('anonymous', L.anonymousPolicies),
  },
  'M-5-public': {
    title:
      'the policies that can match audience public are exactly the T-DIRECTORY policies (plus recorded exceptions)',
    sql: policySetSql('public', L.publicPolicies),
  },
  'M-5-directory': {
    title: 'every object owned by directory_ro is a view on the C0 list',
    sql: `SELECT c.oid::regclass::text AS object FROM pg_class c WHERE pg_get_userbyid(c.relowner) = 'directory_ro'
            AND NOT (c.relkind = 'v' AND c.oid::regclass::text = ANY (${q(L.ownerRightsViews)}))`,
  },
};

/**
 * A policy "can match" an audience when its USING/WITH CHECK text does not mention app.audience at all
 * (no restriction), or mentions the audience literal. This reads the policy text, so it is a conservative
 * over-approximation; a false positive is fixed by writing the audience condition into the policy.
 */
function policySetSql(audience, expected) {
  return `WITH p AS (
      SELECT schemaname || '.' || tablename || '.' || policyname AS id,
             coalesce(qual, '') || ' ' || coalesce(with_check, '') AS body
      FROM pg_policies WHERE schemaname NOT LIKE 'pg\\_%' AND schemaname <> ALL (${q(L.skippedSchemas)})),
    matching AS (SELECT id FROM p WHERE body NOT LIKE '%app.audience%' OR body LIKE '%''${audience}''%')
    SELECT 'unexpected' AS problem, id FROM matching WHERE NOT (id = ANY (${q(expected)}))
    UNION ALL
    SELECT 'missing', e FROM unnest(${q(expected)}) e WHERE NOT EXISTS (SELECT 1 FROM matching WHERE id = e)`;
}

export async function runChecks(db) {
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
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = await connect(requireEnv('EHR_DB_ADMIN_URL'), 'catalog-check');
  try {
    const report = await runChecks(db);
    const version = (await db.query('SELECT version() AS v')).rows[0].v;
    console.log(JSON.stringify({ server: version, checks: report }, null, 2));
    process.exitCode = report.every((c) => c.status === 'pass') ? 0 : 1;
  } finally {
    await db.end();
  }
}
