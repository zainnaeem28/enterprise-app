// Runtime configuration for the CMS (ARCHITECTURE 3.1 `cms`, 7 CMS row). The CMS runs in the marketing account (TB8):
// it holds no PHI and has no path or credential to the production database. Both rules are checked here at start-up,
// so a mis-wired environment fails closed instead of connecting.

export interface CmsEnv {
  databaseUrl: string;
  payloadSecret: string;
  publicUrl: string;
  sitePreviewUrl: string;
  previewSecret: string;
  previewTtlSeconds: number;
  google: { clientId: string; clientSecret: string; hostedDomain: string };
  allowedEmails: ReadonlySet<string>;
  sessionTtlSeconds: number;
}

// Variables that carry production-database access in the other deployables. The CMS process must not receive them.
export const FORBIDDEN_PRODUCTION_VARS = [
  'DATABASE_URL',
  'PRODUCTION_DATABASE_URL',
  'APP_DATABASE_URL',
  'PGHOST',
  'PGPASSWORD',
  'PGUSER',
  'PGDATABASE',
  'PGSERVICEFILE',
  'PGPASSFILE',
] as const;

export class CmsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CmsConfigError';
  }
}

type Env = Readonly<Record<string, string | undefined>>;

const required = (env: Env, name: string): string => {
  const v = env[name]?.trim();
  if (!v) throw new CmsConfigError(`${name} is required`);
  return v;
};

const httpsUrl = (name: string, value: string, allowLocalhostHttp: boolean): string => {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new CmsConfigError(`${name} is not a valid URL`);
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(allowLocalhostHttp && local && u.protocol === 'http:')) {
    throw new CmsConfigError(`${name} must be https`);
  }
  return u.origin;
};

export function assertNoProductionDatabaseAccess(env: Env): void {
  const present = FORBIDDEN_PRODUCTION_VARS.filter((n) => (env[n] ?? '') !== '');
  if (present.length > 0) {
    throw new CmsConfigError(
      `refusing to start: production database variables are present in the CMS environment (${present.join(', ')}). ` +
        'The CMS uses only CMS_DATABASE_URL, its own instance and credentials (ARCHITECTURE 3.1, TB8).',
    );
  }
}

export function parseCmsDatabaseUrl(value: string): string {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new CmsConfigError('CMS_DATABASE_URL is not a valid URL');
  }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
    throw new CmsConfigError('CMS_DATABASE_URL must be a postgres:// URL');
  }
  if (!u.username || !u.hostname || u.pathname.length <= 1) {
    throw new CmsConfigError('CMS_DATABASE_URL needs user, host and database name');
  }
  // The database role is named for the CMS so that a production role cannot be reused by mistake.
  if (!/^cms[_-]|[_-]cms$|^cms$/.test(decodeURIComponent(u.username))) {
    throw new CmsConfigError(
      'CMS_DATABASE_URL must use a dedicated CMS database role (name starts or ends with "cms")',
    );
  }
  return value;
}

export function parseAllowedEmails(raw: string): ReadonlySet<string> {
  const list = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (list.length === 0)
    throw new CmsConfigError('CMS_ALLOWED_EMAILS must list at least one marketing user');
  return new Set(list);
}

export function loadCmsEnv(env: Env, opts: { allowLocalhostHttp?: boolean } = {}): CmsEnv {
  const local = opts.allowLocalhostHttp ?? env['NODE_ENV'] !== 'production';
  assertNoProductionDatabaseAccess(env);
  const payloadSecret = required(env, 'PAYLOAD_SECRET');
  const previewSecret = required(env, 'CMS_PREVIEW_SECRET');
  if (payloadSecret.length < 32 || previewSecret.length < 32) {
    throw new CmsConfigError(
      'PAYLOAD_SECRET and CMS_PREVIEW_SECRET must be at least 32 characters',
    );
  }
  if (payloadSecret === previewSecret)
    throw new CmsConfigError('PAYLOAD_SECRET and CMS_PREVIEW_SECRET must differ');
  const ttl = Number(env['CMS_PREVIEW_TTL_SECONDS'] ?? '900');
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 3600) {
    throw new CmsConfigError('CMS_PREVIEW_TTL_SECONDS must be an integer from 60 to 3600');
  }
  const session = Number(env['CMS_SESSION_TTL_SECONDS'] ?? '28800');
  if (!Number.isInteger(session) || session < 900 || session > 86400) {
    throw new CmsConfigError('CMS_SESSION_TTL_SECONDS must be an integer from 900 to 86400');
  }
  return {
    databaseUrl: parseCmsDatabaseUrl(required(env, 'CMS_DATABASE_URL')),
    payloadSecret,
    publicUrl: httpsUrl('CMS_PUBLIC_URL', required(env, 'CMS_PUBLIC_URL'), local),
    sitePreviewUrl: httpsUrl('CMS_SITE_PREVIEW_URL', required(env, 'CMS_SITE_PREVIEW_URL'), local),
    previewSecret,
    previewTtlSeconds: ttl,
    google: {
      clientId: required(env, 'CMS_GOOGLE_CLIENT_ID'),
      clientSecret: required(env, 'CMS_GOOGLE_CLIENT_SECRET'),
      hostedDomain: required(env, 'CMS_GOOGLE_HOSTED_DOMAIN').toLowerCase(),
    },
    allowedEmails: parseAllowedEmails(required(env, 'CMS_ALLOWED_EMAILS')),
    sessionTtlSeconds: session,
  };
}
