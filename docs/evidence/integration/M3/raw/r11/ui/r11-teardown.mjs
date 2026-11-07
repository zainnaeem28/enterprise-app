// read-only notification summary, then drop the throwaway database. usage: node r11-teardown.mjs <repoRoot>
import { createRequire } from 'node:module';
const pg = createRequire(process.argv[2] + '/package.json')('pg');
const u = new URL(process.env.EHR_TEST_ADMIN_URL); u.pathname = '/ehr_int02_r11_ui';
const c = new pg.Client({ connectionString: u.toString() }); await c.connect();
await c.query('BEGIN'); await c.query("SELECT set_config('app.org_id','00000000-0000-7000-8000-0000000000a1',true), set_config('app.audience','system',true)");
for (const q of [`SELECT template_key, channel, status, count(*)::int FROM notifications.notification GROUP BY 1,2,3 ORDER BY 1,2,3`, `SELECT count(*)::int AS failed_or_error_jobs FROM queue._private_jobs WHERE last_error IS NOT NULL`])
  { try { console.log(q.slice(0,40), JSON.stringify((await c.query(q)).rows)); } catch (e) { console.log('query failed', e.message.split('\n')[0]); await c.query('ROLLBACK'); await c.query('BEGIN'); } }
await c.query('ROLLBACK'); await c.end();
