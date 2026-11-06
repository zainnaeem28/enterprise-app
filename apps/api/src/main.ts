// API process entry. Configuration comes from the environment; a bad variable stops the start with its NAME.
import { createServer } from 'node:http';
import { ConfigError, createLogger, describeDatabase, loadConfig } from '@ehr/kernel';
import { createApp } from './platform/app.js';
import { loadPlatformConfig } from './platform/config.js';
import { Lifecycle } from './platform/health.js';
import { MAX_HEADER_BYTES } from './platform/limits.js';
import { pgReadiness } from './platform/pg-readiness.js';
import { StreamRegistry } from './platform/stream.js';

async function main(): Promise<void> {
  const logger = createLogger({ sink: (l) => process.stdout.write(`${l}\n`), level: 'info' });
  let kernelCfg, platformCfg;
  try {
    kernelCfg = loadConfig({ ...process.env, EHR_DEPLOYABLE: 'api' });
    platformCfg = loadPlatformConfig(process.env);
  } catch (e) {
    if (e instanceof ConfigError) {
      for (const p of e.problems) logger.error(`invalid configuration: ${p}`);
      process.exit(1);
    }
    throw e;
  }
  const readiness = await pgReadiness(kernelCfg);
  const app = await createApp({ config: platformCfg, logger, readiness: readiness.probe });
  await app.init();
  // 16 KB header limit (31.2); a larger header is refused by Node with 431 before any application code runs.
  const server = createServer(
    { maxHeaderSize: MAX_HEADER_BYTES, requestTimeout: platformCfg.requestTimeoutMs + 5_000 },
    app.getHttpAdapter().getInstance(),
  );
  await new Promise<void>((resolve) => server.listen(platformCfg.port, resolve));
  logger.info('api listening', { port: platformCfg.port, database: describeDatabase(kernelCfg) });

  const stop = (): void => {
    app.get(Lifecycle).draining = true; // /readyz answers 503 at once (DEVOPS-PLAN 5)
    app.get(StreamRegistry).drain();
    server.close(() => {
      void readiness.close().finally(() => process.exit(0));
    });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

void main();
