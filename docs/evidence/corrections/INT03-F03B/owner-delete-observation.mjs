// Observation O-1 (pre-existing, not changed by 2203/2204): can an owner remove ANOTHER principal's participant row through app_api?
// Usage: EHR_TEST_ADMIN_URL=... node owner-delete-observation.mjs <database>   (run it on a database migrated to 2202, then to 2204)
import pg from 'pg';
const u = new URL(process.env.EHR_TEST_ADMIN_URL);
u.pathname = `/${process.argv[2]}`;
const a = new pg.Client({ connectionString: u.toString() });
await a.connect();
const id = (n) => `00000000-0000-7000-8000-0000000b0${String(n).padStart(3, '0')}`;
const [ORG, OWN, MEM, TH] = [id(1), id(2), id(3), id(4)];
await a.query('BEGIN');
await a.query('SET LOCAL session_replication_role = replica');
for (const p of [OWN, MEM]) {
  await a.query(`INSERT INTO identity.person (id, organisation_id, display_name) VALUES ($1, $2, 'x')`, [p, ORG]);
  await a.query(`INSERT INTO identity.principal (id, organisation_id, person_id, realm, subject) VALUES ($1, $2, $1, 'google', $3)`, [p, ORG, `o1-${p}`]);
}
await a.query(`INSERT INTO messaging.thread (id, organisation_id, kind, subject, created_by) VALUES ($1, $2, 'staff', 's', $3)`, [TH, ORG, OWN]);
for (const [p, r] of [[OWN, 'owner'], [MEM, 'member']])
  await a.query(`INSERT INTO messaging.thread_participant (thread_id, principal_id, organisation_id, role, added_by) VALUES ($1, $2, $3, $4, $5)`, [TH, p, ORG, r, OWN]);
const settings = { 'app.org_id': ORG, 'app.principal_id': OWN, 'app.audience': 'staff', 'app.realm': 'google' };
await a.query('SET LOCAL ROLE app_api');
for (const [k, v] of Object.entries(settings)) await a.query('SELECT set_config($1,$2,true)', [k, v]);
console.log('owner sees participant rows:', (await a.query('SELECT principal_id FROM messaging.thread_participant')).rows.map((r) => (r.principal_id === OWN ? 'self' : 'other')));
const d = await a.query('DELETE FROM messaging.thread_participant WHERE thread_id = $1 AND principal_id = $2', [TH, MEM]);
console.log('owner DELETE of the member row: rowCount =', d.rowCount);
await a.query('ROLLBACK');
await a.end();
