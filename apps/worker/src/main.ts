// Worker process entry. A bad variable stops the start with its NAME (never its value).
import { ConfigError, createLogger, describeDatabase, loadConfig } from '@ehr/kernel';
import { createPool, startWorker } from './runner.js';

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
  const worker = await startWorker({ cfg, pool, log });
  log.info('worker booted', { database: describeDatabase(cfg) });
  const stop = (): void => {
    void worker.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

main().catch((e: unknown) => {
  process.stderr.write(`worker failed to start: ${e instanceof Error ? e.name : 'error'}\n`);
  process.exit(1);
});
