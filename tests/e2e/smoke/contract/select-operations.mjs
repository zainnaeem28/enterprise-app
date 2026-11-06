#!/usr/bin/env node
// Builds the OpenAPI document Schemathesis runs against (F-09 `contract` job, DEVOPS-PLAN 5.1 AL-07, TC-API-09).
//   select-operations.mjs <inventory.json> <out-dir>
// Inputs: the API's own route inventory (apps/api/dist/src/platform/inventory-cli.js --report) and the bundled R1 OpenAPI
// (packages/contracts/openapi). Output: <out-dir>/openapi.implemented.json holding ONLY the documented operations the API
// implements today, and <out-dir>/selection.json (what was selected, what is still unimplemented).
// Fails when: an implemented route is neither documented nor on the infrastructure list (an undocumented route); or no
// operation is selected (an empty suite fails). Documented operations the API has not built yet are listed, not tested:
// they appear in selection.json so a reader sees how much of the contract this run covered.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../../../..');
const [inventoryFile, outDir] = process.argv.slice(2);
if (!inventoryFile || !outDir) {
  console.error('usage: select-operations.mjs <inventory.json> <out-dir>');
  process.exit(2);
}
// Infrastructure probes outside the generated catalogue (ARCHITECTURE 28.6: exempt from the release check).
const INFRASTRUCTURE = new Set(['GET /healthz', 'GET /readyz']);

const req = createRequire(join(root, 'packages/contracts/package.json'));
const { bundle, createConfig } = await import(
  pathToFileURL(req.resolve('@redocly/openapi-core')).href
);
const bundled = await bundle({
  ref: join(root, 'packages/contracts/openapi/openapi.yaml'),
  config: await createConfig({ extends: ['minimal'] }),
  dereference: false,
});
const spec = bundled.bundle.parsed;

const inv = JSON.parse(readFileSync(inventoryFile, 'utf8'));
const implemented = (inv.routes ?? []).map((r) => ({
  method: r.method.toLowerCase(),
  path: r.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}'),
}));
const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const documented = new Set();
for (const [p, item] of Object.entries(spec.paths ?? {}))
  for (const m of METHODS) if (item?.[m]) documented.add(`${m} ${p}`);

const problems = [];
const selected = [];
for (const r of implemented) {
  const key = `${r.method} ${r.path}`;
  if (documented.has(key)) selected.push(key);
  else if (!INFRASTRUCTURE.has(`${r.method.toUpperCase()} ${r.path}`))
    problems.push(
      `implemented route ${r.method.toUpperCase()} ${r.path} is not in the OpenAPI document`,
    );
}
if (selected.length === 0)
  problems.push('no documented operation is implemented: nothing to test (an empty suite fails)');

const filtered = { ...spec, paths: {} };
for (const key of selected) {
  const [m, ...rest] = key.split(' ');
  const p = rest.join(' ');
  filtered.paths[p] = { ...(filtered.paths[p] ?? {}), [m]: spec.paths[p][m] };
  if (spec.paths[p].parameters) filtered.paths[p].parameters = spec.paths[p].parameters;
}
// Schemathesis needs a reachable server entry; --url overrides it, and the placeholder hosts are not callable.
filtered.servers = [{ url: 'http://127.0.0.1:3000' }];
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'openapi.implemented.json'), JSON.stringify(filtered, null, 2));
const unimplemented = [...documented].filter((k) => !selected.includes(k));
writeFileSync(
  join(outDir, 'selection.json'),
  JSON.stringify(
    {
      documentedOperations: documented.size,
      selectedOperations: selected,
      notYetImplemented: unimplemented.length,
      infrastructureRoutes: implemented
        .filter((r) => INFRASTRUCTURE.has(`${r.method.toUpperCase()} ${r.path}`))
        .map((r) => `${r.method.toUpperCase()} ${r.path}`),
      problems,
    },
    null,
    2,
  ) + '\n',
);
console.log(
  `contract selection: ${selected.length} of ${documented.size} documented operation(s) are implemented and will be tested`,
);
for (const s of selected) console.log(`  ${s}`);
for (const p of problems) console.error(`::error::${p}`);
process.exit(problems.length === 0 ? 0 : 1);
