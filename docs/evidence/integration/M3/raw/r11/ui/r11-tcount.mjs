// prints the number of notification template rows (read-only, superuser). usage: node r11-tcount.mjs <repoRoot> <label>
import { createRequire } from 'node:module';
const pg = createRequire(process.argv[2] + '/package.json')('pg');
const u = new URL(process.env.EHR_TEST_ADMIN_URL); u.pathname = '/ehr_int02_r11_ui';
const c = new pg.Client({ connectionString: u.toString() }); await c.connect();
await c.query('BEGIN'); await c.query("SELECT set_config('app.org_id','00000000-0000-7000-8000-0000000000a1',true), set_config('app.audience','system',true)");
const r = await c.query(`SELECT count(*)::int AS rows, count(*) FILTER (WHERE status='published')::int AS published, count(DISTINCT key)::int AS keys FROM notifications.template`);
console.log(process.argv[3] + ': ' + JSON.stringify(r.rows[0]));
await c.query('ROLLBACK'); await c.end();
