// Route-count and catalogue-conformance check.
//
// Reads docs/ARCHITECTURE.md (sections 29.1-29.5 and 30) and packages/contracts/openapi/*.yaml and
// fails if the YAML differs from the document: a route missing, a route that is not in the
// document, a permission, resolver, idempotency or If-Match requirement that differs, an error
// code that is not in the registry or is dropped from a route, or a module file that holds a route
// the root index does not point at.
//
// Usage: node scripts/contracts/check-routes.mjs [--report <file>]
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { YAML, repoRoot as root, openapiDir } from './deps.mjs';
import { parseCatalogue, flattenRoutes, reservedRoutes, normalisePath } from './catalogue.mjs';

const archPath = join(root, 'docs/ARCHITECTURE.md');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const failures = [];
const fail = (msg) => failures.push(msg);
const METHODS = ['get', 'put', 'post', 'delete', 'patch'];
const PORTAL_PREFIX = /^\/(api\/v1|public|webhooks|partner)\//;
const withPrefix = (p) => (PORTAL_PREFIX.test(p) ? p : `/api/v1${p}`);

// ---- document side
const arch = readFileSync(archPath, 'utf8');
const rows = parseCatalogue(arch);
const docRoutes = flattenRoutes(rows);
const reserved = reservedRoutes(rows);
const docKeys = new Map(
  docRoutes.map((r) => [`${r.host} ${r.method} ${normalisePath(withPrefix(r.path))}`, r]),
);
if (docKeys.size !== docRoutes.length)
  fail('document expansion produced duplicate (host, method, path) routes');

// error registry, section 30
const lines = arch.split('\n');
const s30 = lines.findIndex((l) => l.startsWith('## 30.'));
const s31 = lines.findIndex((l) => l.startsWith('## 31.'));
const registry = new Map(); // code -> [http]
for (const l of lines.slice(s30, s31)) {
  if (!l.startsWith('| `')) continue;
  const cells = l.split(' | ');
  const http = cells[1].split('/').map(Number);
  for (const m of cells[0].matchAll(/`([a-z_]+\.[a-z_]+)`/g)) registry.set(m[1], http);
}

// ---- YAML side
const load = (f) => YAML.parse(readFileSync(join(openapiDir, f), 'utf8'));
const files = readdirSync(openapiDir).filter((f) => f.endsWith('.yaml'));
const indexDoc = load('openapi.yaml');
const common = load('common.yaml');
const moduleFiles = files.filter((f) => !['openapi.yaml', 'common.yaml'].includes(f));
const yamlOps = []; // {file, path, method, op}
for (const f of moduleFiles) {
  const d = load(f);
  for (const [path, item] of Object.entries(d.paths ?? {})) {
    for (const m of METHODS)
      if (item[m]) yamlOps.push({ file: f, path, method: m.toUpperCase(), op: item[m] });
  }
}
const yamlKeys = new Map();
for (const y of yamlOps) {
  if (!y.op['x-access']) fail(`${y.method} ${y.path}: no x-access (host, permission, resolver)`);
  for (const [host, access] of Object.entries(y.op['x-access'] ?? {})) {
    const key = `${host} ${y.method} ${normalisePath(access.pathAs ?? y.path)}`;
    if (yamlKeys.has(key)) fail(`duplicate route in YAML: ${key}`);
    yamlKeys.set(key, { ...y, host, access });
    if (normalisePath(access.pathAs) !== normalisePath(y.path))
      fail(`${key}: pathAs differs from the path key ${y.path}`);
  }
}

// 1. route set equality
for (const k of docKeys.keys())
  if (!yamlKeys.has(k)) fail(`in the document, missing from the YAML: ${k}`);
for (const k of yamlKeys.keys())
  if (!docKeys.has(k)) fail(`in the YAML, not in the document (draft 8.1): ${k}`);

// 2. root index <-> module files
const indexPaths = indexDoc.paths ?? {};
const pointer = (p) => p.replace(/~/g, '~0').replace(/\//g, '~1');
for (const y of yamlOps) {
  const entry = indexPaths[y.path];
  if (!entry) fail(`root index lacks ${y.path} (${y.file})`);
  else if (entry.$ref !== `./${y.file}#/paths/${pointer(y.path)}`)
    fail(`root index entry for ${y.path} points at ${entry.$ref}`);
}
const modulePaths = new Set(yamlOps.map((y) => y.path));
for (const p of Object.keys(indexPaths))
  if (!modulePaths.has(p)) fail(`root index path ${p} has no module file entry`);
const seenPathMethod = new Set();
for (const y of yamlOps) {
  const k = `${y.method} ${y.path}`;
  if (seenPathMethod.has(k)) fail(`${k} defined in more than one module file`);
  seenPathMethod.add(k);
}
const reservedYaml = indexDoc['x-reserved-routes'] ?? [];
if (reservedYaml.length !== reserved.length)
  fail(`reserved routes: document ${reserved.length}, YAML ${reservedYaml.length}`);

// 3. per-route attributes
const idOf = (r) => `${r.host} ${r.method} ${r.path}`;
for (const row of rows) {
  const routeKeys = row.routes
    .filter((r) => !r.path.includes('*'))
    .flatMap((r) => r.hosts.map((host) => ({ host, r })));
  const entries = routeKeys
    .map(({ host, r }) => ({
      host,
      r,
      y: yamlKeys.get(`${host} ${r.method} ${normalisePath(withPrefix(r.path))}`),
    }))
    .filter((e) => e.y);
  for (const { host, r, y } of entries) {
    const a = y.access;
    const where = `${idOf({ host, method: r.method, path: r.path })} (row ${row.section}#${row.rowNo})`;
    if (a.catalogueRow !== `${row.section}#${row.rowNo}`)
      fail(`${where}: catalogueRow ${a.catalogueRow}`);
    if (a.pathAs !== withPrefix(r.path)) fail(`${where}: pathAs ${a.pathAs}`);
    const c = row.columns;
    const expectPerm = c.perm ?? c.who ?? c.caller;
    const actualPerm = a.permission ?? a.who ?? a.caller;
    if (actualPerm !== expectPerm)
      fail(`${where}: permission "${actualPerm}" differs from the document "${expectPerm}"`);
    if (c.scope !== undefined && a.resolver !== c.scope)
      fail(`${where}: resolver "${a.resolver}" differs from the document "${c.scope}"`);
    if (c.authentication !== undefined && a.authentication !== c.authentication)
      fail(`${where}: authentication differs`);
    if (Boolean(a.elevationRequired) !== Boolean(r.elevation))
      fail(`${where}: elevation ${a.elevationRequired} vs document ${r.elevation}`);
    const idemExpected = Boolean(row.flags?.idem);
    if (a.idempotencyKey && r.method !== 'POST') fail(`${where}: Idempotency-Key on a non-POST`);
    if (a.idempotencyKey && !idemExpected)
      fail(`${where}: idempotency required but the row is not marked Idem`);
    if (idemExpected && r.method === 'POST' && !a.idempotencyKey)
      fail(`${where}: row is marked Idem, POST lacks Idempotency-Key`);
    const ifm = row.flags?.ifMatch;
    if (a.ifMatch && !ifm) fail(`${where}: If-Match required but the row does not say so`);
    if (
      ifm &&
      ['PATCH', 'PUT', 'DELETE'].includes(r.method) &&
      !a.ifMatch &&
      (!ifm.onMethod || ifm.onMethod === r.method)
    )
      fail(`${where}: row requires If-Match, ${r.method} lacks it`);
    if (a.ifMatch && r.method === 'GET') fail(`${where}: If-Match on a GET`);
    if (ifm?.onMethod && a.ifMatch && r.method !== ifm.onMethod)
      fail(`${where}: If-Match only on ${ifm.onMethod} per the row`);
    // parameters declared on the operation match the access flags (all hosts considered)
    const params = (y.op.parameters ?? []).map((p) => p.$ref ?? p.name);
    const accessAll = Object.values(y.op['x-access']);
    const anyIdem = accessAll.some((x) => x.idempotencyKey);
    const anyIf = accessAll.some((x) => x.ifMatch);
    if (anyIdem !== params.some((p) => /parameters\/IdempotencyKey/.test(p)))
      fail(`${where}: Idempotency-Key parameter does not match x-access`);
    if (anyIf !== params.some((p) => /parameters\/IfMatch/.test(p)))
      fail(`${where}: If-Match parameter does not match x-access`);
  }
  if (row.flags?.idem && !entries.some((e) => e.r.method === 'POST'))
    fail(`row ${row.section}#${row.rowNo} says Idem but has no POST route`);
}

// 4. provisional marking
for (const y of yamlOps) {
  const provisional = /^\/api\/v1\/(admin\/)?auth\//.test(y.path);
  if (provisional !== Boolean(y.op['x-provisional']))
    fail(`${y.method} ${y.path}: x-provisional ${y.op['x-provisional']} (expected ${provisional})`);
}

// 5. headers on portal operations
for (const y of yamlOps) {
  const hosts = Object.keys(y.op['x-access']);
  const portal = hosts.some((h) => h !== 'integrations');
  const exempt = [
    'GET /api/v1/auth/sign-in',
    'GET /api/v1/auth/callback',
    'GET /api/v1/calendar-link/callback',
    'GET /api/v1/appointments/{reservationId}/calendar.ics',
  ].includes(`${y.method} ${y.path}`);
  const refs = (y.op.parameters ?? []).map((p) => p.$ref ?? `${p.in}:${p.name}`);
  const hasHeader = refs.includes('common.yaml#/components/parameters/ClientRelease');
  const hasQuery = refs.includes('query:clientRelease');
  const stream = y.path === '/api/v1/alerts/stream';
  if (portal && !exempt && !stream && !hasHeader)
    fail(`${y.method} ${y.path}: X-Client-Release header parameter missing`);
  if (stream && !hasQuery) fail(`${y.method} ${y.path}: clientRelease query parameter missing`);
  if ((!portal || exempt) && hasHeader)
    fail(`${y.method} ${y.path}: X-Client-Release must not be required here (28.6 exempt list)`);
}

// 6. error codes: registry, enums, routes
const enumCodes = new Set();
const collectEnums = (doc, file) => {
  for (const [name, s] of Object.entries(doc.components?.schemas ?? {})) {
    if (!/ErrorCode$/.test(name)) continue;
    for (const code of s.enum ?? []) {
      if (!registry.has(code))
        fail(`${file}: ${name} lists ${code}, which is not in ARCHITECTURE section 30`);
      enumCodes.add(code);
    }
  }
};
collectEnums(common, 'common.yaml');
for (const f of moduleFiles) collectEnums(load(f), f);
for (const code of registry.keys())
  if (!enumCodes.has(code)) fail(`registry code ${code} is in no ErrorCode enum`);
for (const y of yamlOps) {
  const byStatus = y.op['x-error-codes'] ?? {};
  for (const [status, codes] of Object.entries(byStatus)) {
    if (!y.op.responses?.[status])
      fail(`${y.method} ${y.path}: x-error-codes has ${status} but no such response`);
    for (const code of codes) {
      if (!registry.has(code)) fail(`${y.method} ${y.path}: ${code} is not in the registry`);
      else if (!registry.get(code).includes(Number(status)))
        fail(
          `${y.method} ${y.path}: ${code} listed under ${status}, registry says ${registry.get(code).join('/')}`,
        );
    }
  }
}
// every code named in a row's notes is on the route, under the status the note states when it states one
for (const row of rows) {
  const notes = row.columns.notes ?? '';
  const tokens = [
    ...notes.matchAll(/(\b[2-5]\d{2}\b)|`([a-z_]+\.[a-z_]+)`|(?<![`\w.])([a-z_]+\.[a-z_]+)(?!\w)/g),
  ];
  let current = null;
  const named = [];
  for (const t of tokens) {
    if (t[1]) current = Number(t[1]);
    else {
      const code = t[2] ?? t[3];
      if (registry.has(code)) named.push({ code, status: current });
    }
  }
  for (const route of row.routes.filter((r) => !r.path.includes('*'))) {
    for (const host of route.hosts) {
      const y = yamlKeys.get(`${host} ${route.method} ${normalisePath(withPrefix(route.path))}`);
      if (!y) continue;
      const all = new Set(Object.values(y.op['x-error-codes'] ?? {}).flat());
      for (const { code, status } of named) {
        if (!all.has(code))
          fail(`${host} ${route.method} ${route.path}: note names ${code}, route does not list it`);
        else if (
          status &&
          registry.get(code).includes(status) &&
          !(y.op['x-error-codes'][String(status)] ?? []).includes(code)
        )
          fail(`${host} ${route.method} ${route.path}: ${code} should be under ${status}`);
      }
    }
  }
}

// 7. common.yaml carries the shared parts
const need = (cond, msg) => cond || fail(msg);
const cp = common.components ?? {};
need(
  cp.parameters?.ClientRelease?.name === 'X-Client-Release' &&
    cp.parameters.ClientRelease.in === 'header',
  'common.yaml: X-Client-Release',
);
need(cp.parameters?.IdempotencyKey?.name === 'Idempotency-Key', 'common.yaml: Idempotency-Key');
need(cp.parameters?.IfMatch?.name === 'If-Match', 'common.yaml: If-Match');
need(cp.headers?.XRequestId, 'common.yaml: X-Request-Id');
need(cp.schemas?.Problem?.required?.includes('code'), 'common.yaml: error envelope (Problem)');
need(cp.parameters?.Limit && cp.parameters?.Cursor, 'common.yaml: pagination parameters');

// ---- report
const perSection = {};
for (const r of docRoutes) perSection[r.section] = (perSection[r.section] ?? 0) + 1;
const summary = {
  document: {
    file: 'docs/ARCHITECTURE.md',
    rows: rows.length,
    routeRows: rows.filter((r) => r.routes.length).length,
    routesByHostMethodPath: docRoutes.length,
    reservedWildcards: reserved.length,
    bySection: perSection,
  },
  yaml: {
    moduleFiles: moduleFiles.length,
    operations: yamlOps.length,
    routesByHostMethodPath: yamlKeys.size,
    reservedWildcards: reservedYaml.length,
  },
  errorCodes: { registry: registry.size, inEnums: enumCodes.size },
  failures,
  result: failures.length === 0 && docRoutes.length === yamlKeys.size ? 'PASS' : 'FAIL',
};
console.log(JSON.stringify({ ...summary, failures: failures.length }, null, 2));
if (failures.length) console.error(failures.map((f) => `FAIL ${f}`).join('\n'));
const report = arg('--report');
if (report) {
  mkdirSync(dirname(resolve(report)), { recursive: true });
  writeFileSync(report, JSON.stringify(summary, null, 2) + '\n');
}
process.exit(summary.result === 'PASS' ? 0 : 1);
