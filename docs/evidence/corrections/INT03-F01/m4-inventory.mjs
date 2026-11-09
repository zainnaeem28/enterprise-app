// Boot-time route and job inventory of the production composition (INT03-F01): `loadIdentityEnv` -> `buildComposition`, the calls
// main.ts makes, then the mounted routes of the M4 modules compared with the OpenAPI operations of clinical, messaging, privacy and
// reporting. Needs apps/api built. Usage: node docs/evidence/corrections/INT03-F01/m4-inventory.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { YAML } from '../../../../scripts/contracts/deps.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const api = (p) => import(`${root}apps/api/dist/src/${p}`);
const { buildComposition } = await api('composition.js');
const { inventory } = await api('platform/inventory.js');
const { loadIdentityEnv } = await api('identity-env.js');
const K = 'k'.repeat(40);
const env = loadIdentityEnv({
  EHR_ORGANISATION_ID: '00000000-0000-7000-8000-0000000000a1',
  EHR_STAFF_HOST: 'staff.example.test',
  EHR_PATIENT_HOST: 'my.example.test',
  EHR_ALLOWED_ORIGINS: 'https://staff.example.test,https://my.example.test',
  EHR_OIDC_STATE_KEY: K,
  EHR_CSRF_KEY: K,
  EHR_RATE_KEY: K,
  EHR_MATCH_CHECK_KEY: K,
  EHR_CHECKIN_QR_KEY: K,
  EHR_STAFF_OIDC_CLIENT_ID: 's',
  EHR_STAFF_OIDC_CLIENT_SECRET: K,
  EHR_STAFF_OIDC_REDIRECT_URI: 'https://staff.example.test/cb',
  EHR_STAFF_WORKSPACE_DOMAIN: 'example.com',
  EHR_PATIENT_OIDC_ISSUER: 'https://idp.example.test',
  EHR_PATIENT_OIDC_AUTHORIZATION_ENDPOINT: 'https://idp.example.test/a',
  EHR_PATIENT_OIDC_TOKEN_ENDPOINT: 'https://idp.example.test/t',
  EHR_PATIENT_OIDC_JWKS_URI: 'https://idp.example.test/j',
  EHR_PATIENT_OIDC_CLIENT_ID: 'c',
  EHR_PATIENT_OIDC_REDIRECT_URI: 'https://my.example.test/cb',
});
const logger = { info() {}, warn() {}, error() {}, child() { return this; } };
const c = buildComposition({ db: {}, logger, identity: env });
const norm = (p) => p.replace(/\{([^}]+)\}/g, ':$1').replace(/:[A-Za-z]+/g, ':p');
const mounted = new Map(inventory(c.controllers).routes.map((r) => [`${r.method} ${norm(r.path)}`, r]));

const specs = ['clinical', 'messaging', 'privacy', 'reporting'];
const spec = new Map();
for (const f of specs) {
  const d = YAML.parse(readFileSync(`${root}packages/contracts/openapi/${f}.yaml`, 'utf8'));
  for (const [path, item] of Object.entries(d.paths ?? {}))
    for (const m of ['get', 'put', 'post', 'delete', 'patch'])
      if (item[m]) spec.set(`${m.toUpperCase()} ${norm(path)}`, f);
}
console.log(`mounted routes (all modules): ${mounted.size}`);
console.log(`OpenAPI operations (clinical, messaging, privacy, reporting): ${spec.size}`);
console.log('\n== OpenAPI M4 operations: mounted? ==');
let missing = 0;
for (const [k, f] of [...spec].sort()) {
  const m = mounted.get(k);
  if (!m) missing++;
  console.log(`${m ? 'MOUNTED ' : 'MISSING '} ${k.padEnd(70)} ${f}${m ? `  ${m.controller}  ${m.declaration?.permission}` : ''}`);
}
console.log(`\nOpenAPI M4 operations not mounted: ${missing}`);
console.log('\n== M4 routes mounted that are in no M4 OpenAPI file (other modules or undocumented) ==');
const m4 = /Chart|Vital|Frontdoor|Encounter|Notes|Note|Messaging|Privacy|Reporting/;
for (const [k, r] of mounted) if (m4.test(r.controller) && !spec.has(k)) console.log(`${k}  ${r.controller}`);
console.log('\n== job types defined in the API-path registry ==');
console.log(c.registry.list().map((j) => j.name).join('\n'));
