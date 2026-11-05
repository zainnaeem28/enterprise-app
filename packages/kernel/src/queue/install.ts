// Installs the queue library's tables into schema `queue` and applies the FORCE policies (21.8, SBR-17).
// Run once per deployment as app_owner (queue_owner cannot log in; harden.sql hands ownership to it), after db/migrations/0100 has created the schema.
const PG: string = 'pg';
import { readFileSync } from 'node:fs';
import { runMigrations } from 'graphile-worker';

export async function installQueue(migratorUrl: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pg: any = (await import(PG)).default;
  const opts = { connectionString: migratorUrl, application_name: 'queue-install' };
  const pool = new pg.Pool(opts);
  try {
    await runMigrations({ pgPool: pool, schema: 'queue' });
    await pool.query(readFileSync(new URL('../../src/queue/harden.sql', import.meta.url), 'utf8'));
  } finally {
    await pool.end();
  }
}
