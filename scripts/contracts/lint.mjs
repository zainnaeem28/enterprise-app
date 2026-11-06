// OpenAPI lint with Redocly's openapi-core (the engine of Redocly CLI): the root index with every
// cross-file $ref resolved, and each module file and common.yaml on its own. Redocly's recommended
// ruleset applies, plus the route-inventory rules of TICKETS section 3 (every operation declares a
// permission, the idempotency and If-Match flags, and its error codes per status). Raw reports go to
// packages/contracts/dist/contract-reports/. Exit status is non-zero on any error or warning.
import { mkdirSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { YAML, contractsDir, openapiDir, outDir, importFromContracts } from './deps.mjs';

const { bundle, lint, createConfig } = await importFromContracts('@redocly/openapi-core');
const coreVersion = JSON.parse(
  readFileSync(join(contractsDir, 'node_modules/@redocly/openapi-core/package.json'), 'utf8'),
).version;
mkdirSync(outDir, { recursive: true });

const rules = {
  // No licence is designated for the product in the design documents; none is invented here.
  'info-license': 'off',
  // Redirect-only routes (sign-in, callback, re-authentication) answer 302 by design (29.1).
  'operation-2xx-response': 'off',
  'operation-4xx-response': 'error',
  'rule/operation-has-x-access': {
    subject: { type: 'Operation', property: 'x-access' },
    assertions: { defined: true, nonEmpty: true },
    message:
      'Every operation declares x-access (host, permission, resolver, idempotency, If-Match).',
    severity: 'error',
  },
  'rule/operation-has-x-error-codes': {
    subject: { type: 'Operation', property: 'x-error-codes' },
    assertions: { defined: true, nonEmpty: true },
    message: 'Every operation records its section 30 error codes per status.',
    severity: 'error',
  },
  'rule/operation-has-tag': {
    subject: { type: 'Operation', property: 'tags' },
    assertions: { defined: true, nonEmpty: true },
    severity: 'error',
  },
};
const rootConfig = await createConfig({ extends: ['recommended'], rules });
// On their own, module files and common.yaml hold components that only the bundle references.
const fileConfig = await createConfig({
  extends: ['recommended'],
  rules: { ...rules, 'no-unused-components': 'off', 'no-empty-servers': 'off' },
});

let failed = false;
const reports = {};
const summarise = (name, problems) => {
  const rows = problems.map((p) => ({
    ruleId: p.ruleId,
    severity: p.severity,
    message: p.message,
    location: (p.location ?? []).map(
      (l) => `${l.source?.absoluteRef?.split('/openapi/').pop()}${l.pointer ?? ''}`,
    ),
  }));
  reports[name] = rows;
  console.log(`redocly lint ${name}: ${rows.length} problem(s)`);
  if (rows.length) {
    failed = true;
    for (const r of rows.slice(0, 20))
      console.error(`  ${r.severity} ${r.ruleId} ${r.message} @ ${r.location.join(' ')}`);
  }
};

// 1. bundle: resolves every cross-file $ref; an unresolved or malformed reference is a problem
const bundled = await bundle({
  ref: join(openapiDir, 'openapi.yaml'),
  config: rootConfig,
  dereference: false,
});
summarise('bundle(openapi.yaml)', bundled.problems);
writeFileSync(
  join(outDir, 'openapi.bundled.yaml'),
  YAML.stringify(bundled.bundle.parsed, { lineWidth: 0 }),
);

// 2. lint the root index (all files reached from it), then each file alone
summarise(
  'openapi.yaml',
  await lint({ ref: join(openapiDir, 'openapi.yaml'), config: rootConfig }),
);
for (const f of readdirSync(openapiDir).filter(
  (x) => x.endsWith('.yaml') && x !== 'openapi.yaml',
)) {
  summarise(f, await lint({ ref: join(openapiDir, f), config: fileConfig }));
}
writeFileSync(
  join(outDir, 'lint-report.json'),
  JSON.stringify(
    {
      tool: '@redocly/openapi-core',
      version: coreVersion,
      ruleset: 'recommended + route-inventory assertions',
      reports,
    },
    null,
    2,
  ) + '\n',
);
console.log(
  `@redocly/openapi-core ${coreVersion}; ruleset: recommended + route-inventory assertions (scripts/contracts/lint.mjs)`,
);
console.log(failed ? 'LINT FAIL' : 'LINT PASS');
process.exit(failed ? 1 : 0);
