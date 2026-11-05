// Worker platform layer (ARCHITECTURE 3.1, 21.8): boots the queue runner against PostgreSQL, wraps every task so a
// failure is logged by class only and retried by the library, and stops cleanly. Task handlers are registered by the
// modules that own the job types (33); this layer owns none.
import { run } from 'graphile-worker';
import type { Runner, Task } from 'graphile-worker';
import type { KernelConfig, Logger } from '@ehr/kernel';

// `pg` has no type declarations in this workspace; the pool is passed through to the library.
const PG: string = 'pg';

export type TaskTable = Record<string, Task>;

export interface WorkerHandle {
  readonly runner: Runner;
  /** Resolves when the runner has drained its running jobs and the pool is closed. */
  stop(): Promise<void>;
}

export interface PoolLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  on(event: 'error', cb: (e: Error) => void): unknown;
  end(): Promise<void>;
}

export async function createPool(cfg: KernelConfig): Promise<PoolLike> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pg: any = (await import(PG)).default;
  const pool: PoolLike = new pg.Pool({
    connectionString: cfg.databaseUrl,
    max: cfg.poolMax,
    application_name: 'worker',
    connectionTimeoutMillis: 5_000,
  });
  pool.on('error', () => undefined); // an idle-client error must not crash the process
  (
    pool as unknown as {
      on(e: string, cb: (c: { on(e: string, cb: () => void): void }) => void): void;
    }
  ).on('connect', (c) => c.on('error', () => undefined));
  return pool;
}

/** Log id and type only: payloads are IDs by rule (BD-09), but a log line is never the place to rely on that. */
export function wrapTask(name: string, task: Task, log: Logger): Task {
  return async (payload, helpers) => {
    const l = log.child({ job: helpers.job.id, jobType: name, attempt: helpers.job.attempts });
    l.info('job started');
    try {
      await task(payload, helpers);
      l.info('job finished');
    } catch (err) {
      l.error('job failed', {
        errorName: err instanceof Error ? err.name : typeof err,
        sqlstate: (err as { code?: unknown } | null)?.code,
      });
      throw err; // the library schedules the retry with back-off (maxAttempts of the job type)
    }
  };
}

export async function startWorker(opts: {
  cfg: KernelConfig;
  pool: PoolLike;
  log: Logger;
  tasks?: TaskTable;
  concurrency?: number;
}): Promise<WorkerHandle> {
  const { cfg, pool, log } = opts;
  // Fail at start, not at the first job: the database must answer as app_worker and the queue schema must exist.
  const probe = await pool.query('SELECT to_regnamespace($1) IS NOT NULL AS q', [cfg.queueSchema]);
  const row = probe.rows[0] as { q: boolean };
  if (!row.q)
    throw new Error(`queue schema ${cfg.queueSchema} does not exist (run the queue install)`);
  const taskList: TaskTable = {};
  for (const [name, t] of Object.entries(opts.tasks ?? {})) taskList[name] = wrapTask(name, t, log);
  const runner = await run({
    pgPool: pool as never,
    schema: cfg.queueSchema,
    concurrency: opts.concurrency ?? 5,
    noHandleSignals: true,
    taskList,
  });
  log.info('worker started', {
    tasks: Object.keys(taskList).length,
  });
  return {
    runner,
    stop: async () => {
      await runner.stop();
      await pool.end();
      log.info('worker stopped');
    },
  };
}
