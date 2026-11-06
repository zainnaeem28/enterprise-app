import type { KernelConfig } from '@ehr/kernel';
import type { ReadinessProbe } from './health.js';

// `pg` has no type declarations in this workspace (@types/pg is not a declared dependency); same device as kernel.
const PG: string = 'pg';

/** The oldest schema this build supports, as the relations it reads or writes (DPR-04 `schema_min`). */
export const REQUIRED_RELATIONS: readonly string[] = [
  'kernel.idempotency_key',
  'kernel.setting',
  'kernel.rate_counter',
];

/** Pool for the readiness probe and the rate limiter; the application name tells operators which deployable it is. */
export async function pgReadiness(
  cfg: KernelConfig,
): Promise<{ probe: ReadinessProbe; pool: unknown; close(): Promise<void> }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pg: any = (await import(PG)).default;
  const pool = new pg.Pool({
    connectionString: cfg.databaseUrl,
    max: cfg.poolMax,
    application_name: 'api',
    connectionTimeoutMillis: 2_000,
    statement_timeout: 3_000,
  });
  pool.on('error', () => undefined); // an idle-client error must not crash the process; readiness reports it
  return {
    pool,
    probe: {
      async missingRelations(): Promise<string[]> {
        const r = await pool.query(
          'SELECT n FROM unnest($1::text[]) AS n WHERE to_regclass(n) IS NULL',
          [REQUIRED_RELATIONS],
        );
        return r.rows.map((x: { n: string }) => x.n);
      },
    },
    close: () => pool.end(),
  };
}
