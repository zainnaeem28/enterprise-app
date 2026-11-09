// Orchestration of the in-VPC restore check (DEVOPS-PLAN 10.3). All I/O is injected so the order, the failure handling and
// the PHI-free shape are tested without AWS or a database. The task:
//   1. finds its target by tag (exactly one purpose=restore-test instance; there are no RunTask overrides),
//   2. resets the master and every login role to fresh random passwords and turns IAM database authentication off,
//      BEFORE any check, because the restored instance carries the production credentials,
//   3. runs the checks, builds the result document, validates it, and writes it. Passwords live only in this process.
import { randomBytes } from 'node:crypto';
import { SCHEMA, validateResult, CHECK_IDS } from '../lib/result.mjs';
import * as C from './checks.mjs';

const newPassword = () => randomBytes(32).toString('base64url');
const seconds = (ms) => Math.round(ms / 1000);

export async function runRestoreCheck(deps) {
  const t0 = deps.now();
  const target = await deps.findTarget();
  const tags = target.tags;
  const ageSeconds = Number(tags['restore-age-seconds']);
  const requested = Number(tags['restore-requested-epoch']);
  const restoreSeconds = Math.max(0, Math.round(t0 / 1000) - requested);
  const results = new Map();
  const record = async (id, fn) => {
    const s = deps.now();
    let r;
    try {
      r = await fn();
    } catch (e) {
      // Only the error class is logged; a database or SDK message can echo a value.
      deps.log(`check ${id} errored (${e?.code ?? e?.name ?? 'Error'})`);
      r = { status: 'fail', reason: 'check_error', violations: 1 };
    }
    results.set(id, { id, duration_ms: deps.now() - s, ...r });
  };

  // 2. credentials
  const cs = deps.now();
  const master = newPassword();
  const passwords = new Map();
  let admin;
  await record('credentials-reset', async () => {
    await deps.rds.resetMaster(target.id, master);
    admin = await deps.connect(target, target.masterUsername, master);
    const roles = (
      await admin.query(
        'SELECT rolname FROM pg_roles WHERE rolcanlogin AND rolname !~ $1 AND rolname <> $2',
        ['^(rds|pg_)', target.masterUsername],
      )
    ).rows;
    for (const { rolname } of roles) {
      const p = newPassword();
      await admin.query(`ALTER ROLE ${C.ident(rolname)} PASSWORD '${p}'`);
      passwords.set(rolname, p);
    }
    const iam = await admin.query(
      "SELECT count(*)::int AS n FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid WHERE r.rolname = 'rds_iam'",
    );
    if (iam.rows[0].n > 0) {
      const members = await admin.query(
        "SELECT m2.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid JOIN pg_roles m2 ON m2.oid = m.member WHERE r.rolname = 'rds_iam'",
      );
      for (const { rolname } of members.rows)
        await admin.query(`REVOKE rds_iam FROM ${C.ident(rolname)}`);
    }
    const left = await admin.query(
      "SELECT count(*)::int AS n FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid WHERE r.rolname = 'rds_iam'",
    );
    const iamEnabled = await deps.rds.iamAuthEnabled(target.id);
    const ok = left.rows[0].n === 0 && iamEnabled === false;
    return ok
      ? {
          status: 'pass',
          reason: 'none',
          violations: 0,
          counts: { roles_reset: roles.length, iam_members_left: 0 },
        }
      : {
          status: 'fail',
          reason: 'credentials_not_reset',
          violations: 1,
          counts: { roles_reset: roles.length, iam_members_left: left.rows[0].n },
        };
  });
  const credsOk = results.get('credentials-reset').status === 'pass';
  const credentialSeconds = seconds(deps.now() - cs);

  // 3. checks (not attempted when the credentials were not reset: the instance would still accept production passwords)
  const ks = deps.now();
  const baseline = credsOk ? await deps.baseline() : null;
  const skipped = { status: 'fail', reason: 'credentials_not_reset', violations: 1 };
  const guarded = async (id, fn) =>
    credsOk ? record(id, fn) : void results.set(id, { id, duration_ms: 0, ...skipped });
  await guarded('schema-version', () => C.schemaVersion(admin.query, baseline));
  await guarded('catalogue-rls', () => C.catalogue(deps.runCatalogChecks, admin));
  await guarded('row-counts', async () => {
    const r = await C.rowsAndChecksums(admin.query, deps.tables, baseline);
    results.set('checksums', {
      id: 'checksums',
      duration_ms: 0,
      status: r.status,
      reason: r.reason,
      hashes: r.hashes,
    });
    const { hashes, ...rest } = r;
    return rest;
  });
  if (!results.has('checksums'))
    results.set('checksums', {
      id: 'checksums',
      duration_ms: 0,
      status: 'fail',
      reason: credsOk ? 'check_error' : 'credentials_not_reset',
    });
  await guarded('audit-anchor-chain', () => C.auditAnchorChain(admin.query, deps.auditVerifier));
  await guarded('app-smoke-readonly', async () => {
    const app = await deps.connect(target, 'app_api', passwords.get('app_api'));
    try {
      return await C.appSmoke(app.query);
    } finally {
      await app.end();
    }
  });
  if (admin) await admin.end();

  const checks = CHECK_IDS.map((id) => results.get(id));
  const overall = checks.some((c) => c.status === 'fail')
    ? 'fail'
    : checks.some((c) => c.status === 'partial')
      ? 'partial'
      : 'pass';
  const doc = {
    schema: SCHEMA,
    run_id: tags['restore-run'],
    mode: tags['restore-mode'],
    image_digest: deps.imageDigest,
    overall,
    restore_point_age_seconds: ageSeconds,
    timings_seconds: {
      restore: restoreSeconds,
      credentials_reset: credentialSeconds,
      checks: seconds(deps.now() - ks),
      total: seconds(deps.now() - t0) + restoreSeconds,
    },
    checks,
  };
  const errs = validateResult(doc);
  if (errs.length) throw new Error(`refusing to write an invalid result: ${errs.join('; ')}`);
  await deps.putResult(doc);
  deps.log(`result written: ${overall}`);
  return doc;
}
