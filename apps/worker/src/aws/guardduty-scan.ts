// GuardDuty Malware Protection for S3 as the worker's malware scanner (AWS-BE-4). GuardDuty scans an uploaded object and writes the tag
// `GuardDutyMalwareScanStatus` on it. This adapter only READS that tag (s3:GetObjectTagging on the quarantine bucket) and maps it:
//   NO_THREATS_FOUND -> clean;  THREATS_FOUND -> infected;  no tag yet -> pending;
//   UNSUPPORTED / ACCESS_DENIED / FAILED / any other value -> error.
// A missing result is `pending`, never `clean`; an unreadable one throws (the job treats that as `error`). Nothing here scans.
import { GetObjectTaggingCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import { awsSettings, createS3Client, AwsConfigError, type Env, type Logger } from '@ehr/kernel';
import { TagScannerAdapter, scannerCaller } from '../jobs/documents/adapters.js';
import type { ScanTagClient, TagMapping } from '../jobs/documents/adapters.js';
import type { Bucket, ScanCaller } from '../jobs/documents/ports.js';

export const GUARDDUTY_TAG = 'GuardDutyMalwareScanStatus';
export const GUARDDUTY_MAPPING: TagMapping = {
  clean: ['NO_THREATS_FOUND'],
  infected: ['THREATS_FOUND'],
  pending: [],
};
export const SCAN_SWITCH = 'EHR_MALWARE_SCAN';

export class S3TagScanClient implements ScanTagClient {
  constructor(
    private readonly s3: Pick<S3Client, 'send'>,
    private readonly buckets: Readonly<Record<Bucket, string>>,
  ) {}

  async readScanTag(req: {
    bucket: Bucket;
    key: string;
    signal: AbortSignal;
  }): Promise<{ value: string | null }> {
    const r = await this.s3.send(
      new GetObjectTaggingCommand({ Bucket: this.buckets[req.bucket], Key: req.key }),
      { abortSignal: req.signal },
    );
    const t = r.TagSet?.find((x) => x.Key === GUARDDUTY_TAG);
    return { value: t?.Value ?? null };
  }

  async health(req: { signal: AbortSignal }): Promise<{ ok: boolean }> {
    await this.s3.send(new HeadBucketCommand({ Bucket: this.buckets.quarantine }), {
      abortSignal: req.signal,
    });
    return { ok: true };
  }
}

/** The scan job's `ScanCaller` over a tag client. The tag adapter ignores connection and credentials, so inert ones are passed. */
export function guardDutyScanCaller(client: ScanTagClient): ScanCaller {
  let n = 0;
  return scannerCaller(
    new TagScannerAdapter(client, GUARDDUTY_MAPPING),
    { id: 'guardduty', kind: 'malware_scan', vendor: 'guardduty', settings: {} },
    { get: () => Promise.reject(new Error('the scan adapter holds no credential')) },
    () => `scan-${++n}`,
  );
}

/** `EHR_MALWARE_SCAN=guardduty` selects it; the two document buckets are then required. Any other value stops the start. */
export function selectGuardDutyScanner(env: Env, log: Logger): ScanCaller | undefined {
  const v = (env[SCAN_SWITCH] ?? '').trim();
  if (v === '') {
    log.info('not configured', { adapter: 'malware scan (GuardDuty)', vars: SCAN_SWITCH });
    return undefined;
  }
  if (v !== 'guardduty')
    throw new AwsConfigError(`malware scan (${SCAN_SWITCH} must be "guardduty")`, [], []);
  const quarantine = (env['EHR_S3_DOCS_QUARANTINE_BUCKET'] ?? '').trim();
  const clean = (env['EHR_S3_DOCS_CLEAN_BUCKET'] ?? '').trim();
  const missing = [
    ...(quarantine === '' ? ['EHR_S3_DOCS_QUARANTINE_BUCKET'] : []),
    ...(clean === '' ? ['EHR_S3_DOCS_CLEAN_BUCKET'] : []),
  ];
  if (missing.length > 0)
    throw new AwsConfigError('malware scan (GuardDuty)', missing, [SCAN_SWITCH]);
  log.info('configured', { adapter: 'malware scan (GuardDuty)' });
  return guardDutyScanCaller(
    new S3TagScanClient(createS3Client(awsSettings(env, 'malware scan (GuardDuty)')), {
      quarantine,
      clean,
    }),
  );
}
