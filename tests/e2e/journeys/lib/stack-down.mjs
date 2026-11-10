// Stops the QA-04 stack processes and drops its throwaway database. usage: node stack-down.mjs <repoRoot> <stateFile>
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const root = resolve(process.argv[2]);
const s = JSON.parse(readFileSync(resolve(process.argv[3]), 'utf8'));
for (const [name, pid] of Object.entries(s.pids)) {
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`stopped ${name} (${pid})`);
  } catch {
    console.log(`${name} (${pid}) was not running`);
  }
}
await new Promise((r) => setTimeout(r, 1500));
const pg = createRequire(root + '/package.json')('pg');
const c = new pg.Client({ connectionString: process.env.EHR_TEST_ADMIN_URL });
await c.connect();
await c.query(`DROP DATABASE IF EXISTS ${s.db} WITH (FORCE)`);
await c.end();
console.log(`dropped ${s.db}`);
