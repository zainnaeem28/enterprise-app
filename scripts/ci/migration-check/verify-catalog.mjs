#!/usr/bin/env node
// Verifies a catalog-check JSON report: every rule of DEVOPS-PLAN 5.2 must be PRESENT and must pass. A rule that is
// missing from the report (a check deleted or renamed) fails exactly like a violation, so the gate cannot shrink silently.
//   verify-catalog.mjs <catalog.json> [<extra.json>]
import { readFileSync } from 'node:fs';

// DEVOPS-PLAN 5.2 rule -> catalog check ids that enforce it (db/tools/catalog-check.mjs) and extra-checks.mjs ids.
export const REQUIRED = {
  'PostgreSQL 17': ['ENV-pg17'],
  'roles exist': ['R-roles'],
  'no BYPASSRLS, superuser, CREATEROLE; function-owner roles NOLOGIN': [
    'R-attributes',
    'X-bypassrls',
  ],
  'application roles own no table; admin (RDS master user) owns nothing': [
    'R-no-owned-tables',
    'X-admin-owns-nothing',
  ],
  'role memberships are the SET-only grants; no master-user membership': [
    'R-memberships',
    'X-no-superuser-membership',
  ],
  'role-level transaction_timeout on audit-writing roles': ['R-timeouts'],
  'app_owner has no INSERT on audit tables': ['R-app-owner-no-audit-insert'],
  'RLS enabled and FORCEd on every table': ['M-1', 'M-1-kernel'],
  'no policy TO PUBLIC': ['M-2', 'M-3'],
  'views have security_invoker unless on the C0/C1 list': ['M-4-views'],
  'reporting_ro limited to the C0/C1 list': ['M-4-reporting'],
  'merge write guard on patient_id tables': ['M-5-patient-guard'],
  'SECURITY DEFINER inventory, fixed search_path, NOLOGIN owner': ['M-5-definer'],
  'anonymous/public policy sets are exactly the listed ones': [
    'M-5-anonymous',
    'M-5-public',
    'M-5-directory',
  ],
};

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: verify-catalog.mjs <catalog.json> [<extra.json>]');
  process.exit(2);
}
const byId = new Map();
for (const f of files) {
  const j = JSON.parse(readFileSync(f, 'utf8'));
  if (!Array.isArray(j.checks) || j.checks.length === 0) {
    console.error(`::error::${f}: no checks in the report (an empty report fails)`);
    process.exit(1);
  }
  for (const c of j.checks) byId.set(c.id, c);
}
let bad = 0;
for (const [rule, ids] of Object.entries(REQUIRED)) {
  for (const id of ids) {
    const c = byId.get(id);
    if (!c) {
      console.error(`::error::rule "${rule}": check ${id} is missing from the report`);
      bad++;
    } else if (c.status !== 'pass') {
      console.error(
        `::error::rule "${rule}": check ${id} FAILED: ${c.title}\n  ${JSON.stringify(c.violations).slice(0, 600)}`,
      );
      bad++;
    } else console.log(`pass  ${id}  (${rule})`);
  }
}
for (const c of byId.values())
  if (c.status !== 'pass' && !Object.values(REQUIRED).flat().includes(c.id)) {
    console.error(
      `::error::check ${c.id} FAILED: ${c.title}\n  ${JSON.stringify(c.violations).slice(0, 600)}`,
    );
    bad++;
  }
console.log(`catalog verification: ${byId.size} check(s), ${bad} problem(s)`);
process.exit(bad === 0 ? 0 : 1);
