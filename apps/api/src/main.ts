// API process entry. Configuration comes from the environment; a bad variable stops the start with its NAME.
import { createServer } from 'node:http';
import { ConfigError, createLogger, describeDatabase, KernelDb, loadConfig } from '@ehr/kernel';
import type { PoolLike } from '@ehr/kernel';
import { buildComposition, registerAllParticipants } from './composition.js';
import { selectS3Presigners } from './platform/aws/s3-presigners.js';
import { selectChimeVideoVendor } from './platform/aws/chime-video.js';
import { selectApiSecretPorts } from './platform/aws/secrets-kms.js';
import { provisionR1Templates } from './modules/notifications/index.js';
import { loadAdminEnv } from './admin-env.js';
import { loadReceiptEnv } from './receipt-env.js';
import { loadIdentityEnv } from './identity-env.js';
import { createApp } from './platform/app.js';
import { loadPlatformConfig } from './platform/config.js';
import { Lifecycle } from './platform/health.js';
import { MAX_HEADER_BYTES } from './platform/limits.js';
import { pgReadiness } from './platform/pg-readiness.js';
import { StreamRegistry } from './platform/stream.js';

async function main(): Promise<void> {
  const logger = createLogger({ sink: (l) => process.stdout.write(`${l}\n`), level: 'info' });
  let kernelCfg, platformCfg, identityEnv, adminEnv, receiptEnv;
  try {
    kernelCfg = loadConfig({ ...process.env, EHR_DEPLOYABLE: 'api' });
    platformCfg = loadPlatformConfig(process.env);
    identityEnv = loadIdentityEnv(process.env);
    // Fail closed (SEC02-F01): no attestation roots, AAGUIDs or decoy key means no start, never a test value.
    adminEnv = loadAdminEnv(process.env, identityEnv);
    receiptEnv = loadReceiptEnv(process.env);
  } catch (e) {
    if (e instanceof ConfigError) {
      for (const p of e.problems) logger.error(`invalid configuration: ${p}`);
      process.exit(1);
    }
    throw e;
  }
  registerAllParticipants();
  const readiness = await pgReadiness(kernelCfg);
  const db = new KernelDb(readiness.pool as PoolLike);
  // Idempotent: publishes any R1 template key that has no published version (INT02-R10-B1); never overwrites an existing one.
  const provisioned = await provisionR1Templates(
    db,
    identityEnv.orgId,
    (process.env['EHR_TEMPLATE_LANGUAGES'] ?? 'en')
      .split(',')
      .map((l) => l.trim())
      .filter(Boolean),
  );
  logger.info('notification templates provisioned', {
    provisioned: provisioned.provisioned.length,
    present: provisioned.present.length,
  });
  // pg has no declared types here (same device as pg-readiness); the hub's LISTEN needs its own connection, never a pooled one.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pg: any = (await import('pg' as string)).default;
  // A half-configured S3 adapter stops the start here; an absent one leaves the refusing port in place.
  const s3 = selectS3Presigners(process.env, logger);
  const secrets = selectApiSecretPorts(process.env, logger);
  const videoVendor = selectChimeVideoVendor(process.env, logger);
  const composition = buildComposition({
    db,
    logger,
    identity: identityEnv,
    ...s3,
    ...(videoVendor === undefined ? {} : { videoVendor }),
    adminPorts: {
      ...(secrets.secretStore === undefined ? {} : { secretStore: secrets.secretStore }),
      ...(secrets.sealer === undefined ? {} : { sealer: secrets.sealer }),
    },
    calendarPorts: {
      ...(secrets.secretStore === undefined ? {} : { store: secrets.secretStore }),
      ...(secrets.sealer === undefined ? {} : { sealer: secrets.sealer }),
      ...(secrets.inboundKeys === undefined ? {} : { channelKeys: secrets.inboundKeys }),
    },
    admin: adminEnv,
    ...(receiptEnv === undefined ? {} : { receiptPorts: receiptEnv }),
    listen: () =>
      new pg.Client({ connectionString: kernelCfg.databaseUrl, application_name: 'api-listen' }),
  });
  const app = await createApp({
    config: platformCfg,
    logger,
    readiness: readiness.probe,
    policy: composition.policy,
    controllers: composition.controllers,
    replaceAlertStream: composition.alertStreamHub !== undefined,
  });
  await app.init();
  await composition.alertStreamHub?.start();
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
    void composition.alertStreamHub?.stop();
    server.close(() => {
      void readiness.close().finally(() => process.exit(0));
    });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

void main();
