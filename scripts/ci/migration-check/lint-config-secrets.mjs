#!/usr/bin/env node
// Secret-reference lint (DEVOPS-PLAN 5.2, DPR-13, M-1): the RDS master user must not appear in any application
// connection string, task definition or secret reference. Scans tracked configuration files only.
//   lint-config-secrets.mjs [repoRoot]
// Flags, in a tracked configuration file (yml, yaml, json, tf, tfvars, env, toml, properties, Dockerfile*, infra/**):
//   - a postgres URL whose user is a master/admin name (postgres, rdsadmin, master, admin, root, superuser);
//   - DB user settings (…_USER, …_USERNAME) set to such a name;
//   - a secret reference (valueFrom, secretsmanager ARN, secret_id) naming a master secret ("rds!", "master").
// Allowed: the loopback CI administrator in EHR_TEST_ADMIN_URL / EHR_DB_ADMIN_URL (throwaway container, synthetic data),
// the compose file of that container, and files under tests/ and docs/.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? join(import.meta.dirname, '../../..'));
const files = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
const configLike = (f) =>
  /\.(ya?ml|json|tf|tfvars|env|toml|properties)$/.test(f) ||
  /(^|\/)Dockerfile[^/]*$/.test(f) ||
  /(^|\/)\.env/.test(f) ||
  f.startsWith('infra/');
const skip = (f) =>
  f.startsWith('docs/') ||
  f.startsWith('tests/') ||
  f.startsWith('scripts/ci/migration-check/') ||
  f === 'docker/compose.ci.yml' ||
  /(^|\/)(pnpm-lock\.yaml|package\.json|tsconfig[^/]*\.json)$/.test(f) ||
  f.startsWith('packages/contracts/');
const MASTER = '(?:postgres|rdsadmin|master|admin|root|superuser)';
const ALLOWED_KEY = /\b(EHR_TEST_ADMIN_URL|EHR_DB_ADMIN_URL)\b/;
const rules = [
  [
    new RegExp(`postgres(?:ql)?://${MASTER}(?::[^@\\s]*)?@`, 'i'),
    'connection string uses the master/admin user',
  ],
  [
    new RegExp(
      `\\b[A-Z0-9_]*(?:DB|DATABASE|PG|POSTGRES)[A-Z0-9_]*USER(?:NAME)?\\b\\s*["']?\\s*[:=]\\s*["']?${MASTER}\\b`,
      'i',
    ),
    'database user setting is the master/admin user',
  ],
  [
    /\b(valueFrom|secret_id|secretsmanager)\b.*(rds!|master)/i,
    'secret reference names the RDS master secret',
  ],
];
const problems = [];
let scanned = 0;
for (const f of files) {
  if (!configLike(f) || skip(f) || !existsSync(join(root, f))) continue;
  scanned++;
  readFileSync(join(root, f), 'utf8')
    .split('\n')
    .forEach((line, i) => {
      for (const [re, msg] of rules) {
        if (!re.test(line)) continue;
        if (ALLOWED_KEY.test(line)) continue;
        problems.push(`${f}:${i + 1}: ${msg}`);
      }
    });
}
if (scanned === 0) {
  console.error('::error::the secret-reference lint scanned no file (an empty scan fails)');
  process.exit(1);
}
for (const p of problems) console.error(`::error::${p}`);
console.log(
  `secret-reference lint: ${scanned} configuration file(s), ${problems.length} problem(s)`,
);
process.exit(problems.length === 0 ? 0 : 1);
