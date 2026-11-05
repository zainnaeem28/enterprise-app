// Installs the queue library's tables into schema `queue` and applies the FORCE policies (21.8, SBR-17).
// Run as queue_owner, after db/migrations/0100 has created the schema. UNEXECUTED until a PostgreSQL 17 is available.
const PG: string = 'pg';
import { readFileSync } from 'node:fs';
import { runMigrations } from 'graphile-worker';

export async function installQueue(queueOwnerUrl: string): Promise<void> {
  await runMigrations({ connectionString: queueOwnerUrl, schema: 'queue' });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pg: any = (await import(PG)).default;
  const c = new pg.Client({ connectionString: queueOwnerUrl, application_name: 'queue-harden' });
  await c.connect();
  try {
    await c.query(readFileSync(new URL('../../src/queue/harden.sql', import.meta.url), 'utf8'));
  } finally {
    await c.end();
  }
}
