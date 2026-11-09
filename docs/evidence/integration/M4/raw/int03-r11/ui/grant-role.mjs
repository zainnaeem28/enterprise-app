// r10 fixture (disclosed): give the second staff principal one more seeded role. usage: node grant-role.mjs <root> <role key>
import { createRequire } from 'node:module'; import { randomUUID } from 'node:crypto';
const [root, key] = process.argv.slice(2);
const pg = createRequire(root + '/package.json')('pg');
const ORG = '00000000-0000-7000-8000-0000000000a1', LOC = '00000000-0000-7000-8000-000000000101', STAFF2 = '00000000-0000-7000-8000-000000000521';
const u = new URL(process.env.EHR_TEST_ADMIN_URL); u.pathname = '/ehr_int03_r11_ui';
const c = new pg.Client({ connectionString: u.toString() }); await c.connect();
await c.query('BEGIN');
await c.query("SELECT set_config('app.org_id', $1, true), set_config('app.audience', 'system', true)", [ORG]);
const r = await c.query('SELECT id FROM identity.role WHERE key = $1', [key]); if (!r.rows.length) throw new Error('no such role ' + key);
await c.query('INSERT INTO identity.role_assignment (id, organisation_id, principal_id, role_id, location_id, granted_via_request_id) VALUES ($1,$2,$3,$4,$5,$6)', [randomUUID(), ORG, STAFF2, r.rows[0].id, LOC, randomUUID()]);
await c.query('COMMIT'); await c.end(); console.log('granted', key);
