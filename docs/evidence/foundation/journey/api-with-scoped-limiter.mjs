// F-07 evidence harness (NOT product code, NOT shipped in an image). Runs INSIDE the built API image, mounted read-only
// at /app/journey. It composes the same compiled modules as apps/api/src/main.ts, with ONE difference: the rate limiter
// is PgRateLimiter, so every /api request writes kernel.rate_counter through KernelDb.withScope (the scope setter) under
// the app_api role with row-level security. main.ts does not wire PgRateLimiter yet (no organisation exists before the
// identity module); this harness is the only way to put the scope setter and RLS on the browser's path in R1 foundation.
import { createServer } from 'node:http';
import pg from 'pg';
import { KernelDb, createLogger, loadConfig } from '@ehr/kernel';
import { createApp } from '/app/dist/src/platform/app.js';
import { loadPlatformConfig } from '/app/dist/src/platform/config.js';
import { pgReadiness } from '/app/dist/src/platform/pg-readiness.js';
import { PgRateLimiter } from '/app/dist/src/platform/rate-limit.js';

const ORG = process.env.JOURNEY_ORG_ID; // synthetic organisation id, not a real tenant
const kernelCfg = loadConfig({ ...process.env, EHR_DEPLOYABLE: 'api' });
const platformCfg = loadPlatformConfig(process.env);
const logger = createLogger({ sink: (l) => process.stdout.write(`${l}\n`), level: 'info' });
const readiness = await pgReadiness(kernelCfg);
const pool = new pg.Pool({ connectionString: kernelCfg.databaseUrl, max: 4, application_name: 'api-journey' });
pool.on('error', () => undefined);
const limiter = new PgRateLimiter(new KernelDb(pool), ORG, 'journey-evidence-secret-not-a-credential');
const app = await createApp({ config: platformCfg, logger, readiness: readiness.probe, limiter });
await app.init();
const server = createServer(app.getHttpAdapter().getInstance());
await new Promise((r) => server.listen(platformCfg.port, r));
logger.info('journey api listening', { port: platformCfg.port });
process.once('SIGTERM', () => server.close(() => process.exit(0)));
