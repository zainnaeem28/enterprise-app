// `sync-task-types`: the one-shot deploy-pipeline step (ARCHITECTURE 21.8), run as app_worker before the API rollout.
// Upsert only. Prints the count, never a connection string.
import { ConfigError, createLogger, loadConfig, syncTaskTypes } from '@ehr/kernel';
import { buildWorkerRegistry } from './job-registry.js';
import { createPool } from './runner.js';

async function main(): Promise<void> {
  const log = createLogger({ sink: (l) => process.stdout.write(`${l}\n`) });
  let cfg;
  try {
    cfg = loadConfig({ ...process.env, EHR_DEPLOYABLE: 'worker' });
  } catch (e) {
    if (e instanceof ConfigError) {
      for (const p of e.problems) log.error(`invalid configuration: ${p}`);
      process.exit(1);
    }
    throw e;
  }
  const pool = await createPool(cfg);
  try {
    const n = await syncTaskTypes(pool, buildWorkerRegistry());
    log.info('task types synced', { count: n });
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`sync-task-types failed: ${e instanceof Error ? e.name : 'error'}\n`);
  process.exit(1);
});
