// The one place the AWS adapters get their region, endpoint and client (docs/runbooks/AWS-ADAPTERS.md). Credentials are never read here:
// the SDK's default provider chain finds them (task role in AWS; the AWS_ACCESS_KEY_ID pair against an emulator).
import { S3Client } from '@aws-sdk/client-s3';
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
