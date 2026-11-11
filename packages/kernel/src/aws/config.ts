// The one place the AWS adapters get their region, endpoint and client (docs/runbooks/AWS-ADAPTERS.md). Credentials are never read here:
// the SDK's default provider chain finds them (task role in AWS; the AWS_ACCESS_KEY_ID pair against an emulator).
import { KMSClient } from '@aws-sdk/client-kms';
import { S3Client } from '@aws-sdk/client-s3';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { Logger } from '../logging/logger.js';

export type Env = Readonly<Record<string, string | undefined>>;

/** Raised at startup for a half-configured adapter. Names variables, never values. */
export class AwsConfigError extends Error {
  constructor(
    readonly adapter: string,
    readonly missing: readonly string[],
    readonly present: readonly string[],
  ) {
    super(
      `${adapter} is partially configured: set ${missing.join(', ')} (or unset ${present.join(', ')} to keep the refusing port)`,
    );
    this.name = 'AwsConfigError';
  }
}

export interface AwsSettings {
  region: string;
  /** Emulator or VPC-endpoint override (EHR_AWS_ENDPOINT_URL); absent against real AWS. */
  endpoint?: string;
  forcePathStyle: boolean;
}

const set = (env: Env, name: string): boolean => (env[name] ?? '').trim() !== '';

/** `AWS_REGION` is required once any AWS adapter is selected. */
export function awsSettings(env: Env, adapter: string): AwsSettings {
  if (!set(env, 'AWS_REGION')) throw new AwsConfigError(adapter, ['AWS_REGION'], []);
  const endpoint = (env['EHR_AWS_ENDPOINT_URL'] ?? '').trim();
  if (endpoint !== '' && !/^https?:\/\/[^\s]+$/.test(endpoint))
    throw new AwsConfigError(`${adapter} (EHR_AWS_ENDPOINT_URL is not an http(s) URL)`, [], []);
  return {
    region: (env['AWS_REGION'] as string).trim(),
    ...(endpoint === '' ? {} : { endpoint }),
    // Emulators (MinIO, LocalStack by IP) need path-style addressing; real S3 never does.
    forcePathStyle: endpoint !== '' || env['EHR_AWS_S3_FORCE_PATH_STYLE'] === 'true',
  };
}

export function createS3Client(s: AwsSettings): S3Client {
  return new S3Client({
    region: s.region,
    forcePathStyle: s.forcePathStyle,
    ...(s.endpoint === undefined ? {} : { endpoint: s.endpoint }),
    // Only send/validate a checksum when an operation requires one: keeps emulators and presigned URLs simple.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

export function createKmsClient(s: AwsSettings): KMSClient {
  return new KMSClient({
    region: s.region,
    ...(s.endpoint === undefined ? {} : { endpoint: s.endpoint }),
  });
}

export function createSecretsManagerClient(s: AwsSettings): SecretsManagerClient {
  return new SecretsManagerClient({
    region: s.region,
    ...(s.endpoint === undefined ? {} : { endpoint: s.endpoint }),
  });
}

/**
 * Picks an adapter by configuration. All of `vars` set -> `build(values)`. None set -> `undefined` and one `not configured` line (the caller
 * keeps its refusing port). Some set -> {@link AwsConfigError}: a half-configured adapter must stop the start, never fall back silently.
 */
export function selectByEnv<T>(opts: {
  adapter: string;
  env: Env;
  vars: readonly string[];
  log: Logger;
  build(values: Record<string, string>): T;
}): T | undefined {
  const present = opts.vars.filter((v) => set(opts.env, v));
  if (present.length === 0) {
    opts.log.info('not configured', { adapter: opts.adapter, vars: opts.vars.join(',') });
    return undefined;
  }
  if (present.length !== opts.vars.length)
    throw new AwsConfigError(
      opts.adapter,
      opts.vars.filter((v) => !present.includes(v)),
      present,
    );
  const values: Record<string, string> = {};
  for (const v of opts.vars) values[v] = (opts.env[v] as string).trim();
  opts.log.info('configured', { adapter: opts.adapter });
  return opts.build(values);
}

export const SECRETS_REPLICA_VARS = [
  'EHR_SECRETS_REPLICA_REGION',
  'EHR_SECRETS_REPLICA_KMS_KEY_ID',
] as const;

/**
 * The recovery-Region replica for runtime integration secrets (HEAAA-860). Both variables or neither: one alone stops the start. The
 * Region must differ from `AWS_REGION`, and the key must be an ARN in the replica Region. Unset (every non-production environment, and
 * tasks run in the recovery Region after a failover) -> `undefined`, the behaviour without a replica. Names variables, never values.
 */
export function secretReplicaFromEnv(
  env: Env,
  adapter: string,
): { region: string; kmsKeyId: string } | undefined {
  const present = SECRETS_REPLICA_VARS.filter((v) => set(env, v));
  if (present.length === 0) return undefined;
  if (present.length !== SECRETS_REPLICA_VARS.length)
    throw new AwsConfigError(
      adapter,
      SECRETS_REPLICA_VARS.filter((v) => !present.includes(v)),
      present,
    );
  const region = (env['EHR_SECRETS_REPLICA_REGION'] as string).trim();
  const kmsKeyId = (env['EHR_SECRETS_REPLICA_KMS_KEY_ID'] as string).trim();
  if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region))
    throw new AwsConfigError(
      `${adapter} (EHR_SECRETS_REPLICA_REGION is not a Region name)`,
      [],
      [],
    );
  if (region === (env['AWS_REGION'] ?? '').trim())
    throw new AwsConfigError(
      `${adapter} (EHR_SECRETS_REPLICA_REGION must differ from AWS_REGION)`,
      [],
      [],
    );
  // arn:<partition>:kms:<region>:<account>:key/<id>
  const m = /^arn:[a-z-]+:kms:([a-z0-9-]+):\d{12}:key\/[A-Za-z0-9-]+$/.exec(kmsKeyId);
  if (m === null || m[1] !== region)
    throw new AwsConfigError(
      `${adapter} (EHR_SECRETS_REPLICA_KMS_KEY_ID must be a key ARN in EHR_SECRETS_REPLICA_REGION)`,
      [],
      [],
    );
  return { region, kmsKeyId };
}
