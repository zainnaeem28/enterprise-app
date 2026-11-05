// Installs the queue library's tables into schema `queue` and applies the FORCE policies (21.8, SBR-17).
// First install runs as app_owner (queue_owner cannot log in; harden.sql hands ownership to it), after db/migrations/0100
// has created the schema. Every later run (library upgrade, recovery after a partial install) finds queue_owner as the
// schema owner and runs the same steps as queue_owner via a session role, so install is safe to repeat.
const PG: string = 'pg';
import { readFileSync } from 'node:fs';
import { runMigrations } from 'graphile-worker';

export async function installQueue(migratorUrl: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pg: any = (await import(PG)).default;
  const base = { connectionString: migratorUrl, application_name: 'queue-install' };
  const probe = new pg.Pool(base);
  let handedOver: boolean;
  try {
    const r = await probe.query(
      `SELECT pg_get_userbyid(nspowner) = 'queue_owner' AS owned FROM pg_namespace WHERE nspname = 'queue'`,
    );
    if (r.rowCount === 0)
      throw new Error('schema queue is missing: apply db/migrations/0100 first');
    handedOver = r.rows[0].owned === true;
  } finally {
    await probe.end();
  }
  const pool = new pg.Pool(handedOver ? { ...base, options: '-c role=queue_owner' } : base);
  try {
    await runMigrations({ pgPool: pool, schema: 'queue' });
    await pool.query(readFileSync(new URL('../../src/queue/harden.sql', import.meta.url), 'utf8'));
  } finally {
    await pool.end();
  }
}
