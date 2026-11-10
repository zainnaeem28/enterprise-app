// Worker process entry. A bad variable stops the start with its NAME (never its value).
import { ConfigError, createLogger, describeDatabase, loadConfig } from '@ehr/kernel';
import { notifyAdapters, selectNotifyWorkerInfra } from './aws/notify-adapters.js';
import { selectPushAdapter } from './aws/web-push.js';
import { selectChimeVideoAdapter } from './aws/chime-video.js';
import { selectGuardDutyScanner } from './aws/guardduty-scan.js';
import { selectTextractAdapter } from './aws/textract-ocr.js';
import { selectS3WorkerInfra } from './aws/s3-adapters.js';
import { selectSecretsWorkerInfra } from './aws/secrets-kms.js';
import { composeWorker } from './compose.js';
import { WORKER_CRONTAB } from './job-registry.js';
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
  const env = process.env;
  const notify = selectNotifyWorkerInfra(env, log);
  const push = await selectPushAdapter(env, log);
  const video = selectChimeVideoAdapter(env, log);
  const ocr = selectTextractAdapter(env, log);
  const scanner = selectGuardDutyScanner(env, log);
  const channelAdapters = [
    ...notifyAdapters(notify.providers),
    ...(push === undefined ? [] : [push]),
    ...(video === undefined ? [] : [video]),
    ...(ocr === undefined ? [] : [ocr]),
  ];
  const { tasks, registry } = await composeWorker({
    cfg,
    pool,
    log,
    // A half-configured S3 adapter stops the start; an absent one leaves the refusing port.
    infra: {
      ...selectS3WorkerInfra(env, log),
      ...selectSecretsWorkerInfra(env, log),
      ...(scanner === undefined ? {} : { scanner }),
      ...(notify.securityNotice === undefined ? {} : { securityNotice: notify.securityNotice }),
      channelAdapters,
    },
    ...(env['EHR_PATIENT_HOST'] ? { patientHost: env['EHR_PATIENT_HOST'] } : {}),
    ...(env['EHR_CHECKIN_QR_KEY'] ? { qrKey: env['EHR_CHECKIN_QR_KEY'] } : {}),
    ...(env['EHR_CALENDAR_WEBHOOK_URL']
      ? { calendarWebhookUrl: env['EHR_CALENDAR_WEBHOOK_URL'] }
      : {}),
  });
  const worker = await startWorker({ cfg, pool, log, registry, tasks, crontab: WORKER_CRONTAB });
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
