// Typed configuration from the environment. Fails at start-up with the NAMES of the bad variables, never their
// values (they may be secrets). Secrets come from the secret store into the environment; nothing here has a default
// for a credential.

export interface KernelConfig {
  readonly environment: 'ci' | 'dev' | 'staging' | 'production';
  /** App role connection string (`app_api` or `app_worker`). */
  readonly databaseUrl: string;
  /** `api` or `worker`: sets `application_name` (21.2). */
  readonly deployable: 'api' | 'worker';
  /** Worker/webhook deployment configuration for `app.org_id` (21.3). */
  readonly organisationId: string | undefined;
  readonly queueSchema: string;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
  readonly poolMax: number;
}

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`invalid configuration: ${problems.join('; ')}`);
    this.name = 'ConfigError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

export function loadConfig(env: Readonly<Record<string, string | undefined>>): KernelConfig {
  const problems: string[] = [];
  const oneOf = <T extends string>(name: string, allowed: readonly T[], dflt?: T): T => {
    const v = env[name] ?? dflt;
    if (v === undefined) {
      problems.push(`${name} is required`);
      return allowed[0] as T;
    }
    if (!(allowed as readonly string[]).includes(v)) {
      problems.push(`${name} must be one of ${allowed.join(', ')}`);
      return allowed[0] as T;
    }
    return v as T;
  };

  const environment = oneOf('EHR_ENV', ['ci', 'dev', 'staging', 'production']);
  const deployable = oneOf('EHR_DEPLOYABLE', ['api', 'worker']);
  const logLevel = oneOf('EHR_LOG_LEVEL', ['debug', 'info', 'warn', 'error'], 'info');

  const databaseUrl = env['EHR_DATABASE_URL'] ?? '';
  if (!/^postgres(ql)?:\/\//.test(databaseUrl))
    problems.push('EHR_DATABASE_URL must be a postgres:// URL');

  const organisationId = env['EHR_ORGANISATION_ID'];
  if (organisationId !== undefined && !UUID.test(organisationId))
    problems.push('EHR_ORGANISATION_ID must be a UUID');
  if (deployable === 'worker' && organisationId === undefined) {
    problems.push('EHR_ORGANISATION_ID is required for the worker (dequeue scope, 21.3)');
  }

  const queueSchema = env['EHR_QUEUE_SCHEMA'] ?? 'queue';
  if (!IDENT.test(queueSchema)) problems.push('EHR_QUEUE_SCHEMA must be a lower-case identifier');

  const poolRaw = env['EHR_POOL_MAX'] ?? '10';
  const poolMax = Number(poolRaw);
  if (!Number.isInteger(poolMax) || poolMax < 1 || poolMax > 200)
    problems.push('EHR_POOL_MAX must be an integer 1..200');

  if (problems.length > 0) throw new ConfigError(problems);
  return { environment, databaseUrl, deployable, organisationId, queueSchema, logLevel, poolMax };
}

/** The connection string without credentials, safe to log. */
export function describeDatabase(cfg: KernelConfig): string {
  try {
    const u = new URL(cfg.databaseUrl);
    return `${u.protocol}//${u.hostname}:${u.port || '5432'}${u.pathname}`;
  } catch {
    return '[unparseable]';
  }
}
