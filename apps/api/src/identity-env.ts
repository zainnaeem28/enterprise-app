// Identity and booking configuration of the API process, read from the environment. A bad variable is reported by NAME, never value.
// Credentials (client secret, signing keys) come from the secret store into the environment; nothing here has a default for one, and
// nothing is committed. The IdP is configured by endpoints: staff default to Google's; a CI fixture points the same variables at any
// OIDC provider (for instance the local conformance IdP run as a separate process), so the real composition is the one that runs.
import { ConfigError } from '@ehr/kernel';
import { GOOGLE_ENDPOINTS } from './modules/identity/index.js';
import type { OidcEndpoints } from './modules/identity/index.js';

export interface IdentityEnv {
  readonly orgId: string;
  readonly staffHost: string;
  readonly patientHost: string;
  readonly allowedOrigins: readonly string[];
  readonly oidcStateKey: string;
  readonly csrfKey: string;
  readonly rateKey: string;
  readonly matchKey: string;
  readonly qrKey: string;
  readonly staff: {
    endpoints: OidcEndpoints;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    workspaceDomain: string;
  };
  readonly patient: {
    endpoints: OidcEndpoints;
    clientId: string;
    clientSecret: string | undefined;
    redirectUri: string;
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A bare host name: the request `Host` is compared after its port is stripped (`hostOf`), so a configured port could never match.
const HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

export function loadIdentityEnv(env: Readonly<Record<string, string | undefined>>): IdentityEnv {
  const problems: string[] = [];
  const str = (name: string): string => {
    const v = env[name];
    if (v === undefined || v === '') {
      problems.push(`${name} is required`);
      return '';
    }
    return v;
  };
  const secret = (name: string): string => {
    const v = str(name);
    if (v !== '' && v.length < 32) problems.push(`${name} must be at least 32 characters`);
    return v;
  };
  const url = (name: string, v: string | undefined = env[name]): string => {
    if (v === undefined || v === '') {
      problems.push(`${name} is required`);
      return '';
    }
    try {
      const u = new URL(v);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('scheme');
    } catch {
      problems.push(`${name} must be an http(s) URL`);
    }
    return v;
  };
  const host = (name: string): string => {
    const v = str(name).toLowerCase();
    if (v !== '' && !HOST.test(v)) problems.push(`${name} must be a host name without a port`);
    return v;
  };
  const endpoints = (prefix: string, dflt: OidcEndpoints | undefined): OidcEndpoints => {
    const pick = (suffix: string, d: string | undefined): string =>
      url(`${prefix}_${suffix}`, env[`${prefix}_${suffix}`] ?? d);
    return {
      issuer: pick('ISSUER', dflt?.issuer),
      authorizationEndpoint: pick('AUTHORIZATION_ENDPOINT', dflt?.authorizationEndpoint),
      tokenEndpoint: pick('TOKEN_ENDPOINT', dflt?.tokenEndpoint),
      jwksUri: pick('JWKS_URI', dflt?.jwksUri),
    };
  };

  const orgId = str('EHR_ORGANISATION_ID');
  if (orgId !== '' && !UUID.test(orgId)) problems.push('EHR_ORGANISATION_ID must be a UUID');
  const staffHost = host('EHR_STAFF_HOST');
  const patientHost = host('EHR_PATIENT_HOST');
  const origins = (env['EHR_ALLOWED_ORIGINS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (origins.length === 0) problems.push('EHR_ALLOWED_ORIGINS is required');
  for (const o of origins)
    if (!/^https?:\/\/[^/]+$/.test(o)) problems.push('EHR_ALLOWED_ORIGINS must be origins');

  const cfg: IdentityEnv = {
    orgId,
    staffHost,
    patientHost,
    allowedOrigins: origins,
    oidcStateKey: secret('EHR_OIDC_STATE_KEY'),
    csrfKey: secret('EHR_CSRF_KEY'),
    rateKey: secret('EHR_RATE_KEY'),
    matchKey: secret('EHR_MATCH_CHECK_KEY'),
    qrKey: secret('EHR_CHECKIN_QR_KEY'),
    staff: {
      endpoints: endpoints('EHR_STAFF_OIDC', GOOGLE_ENDPOINTS),
      clientId: str('EHR_STAFF_OIDC_CLIENT_ID'),
      clientSecret: str('EHR_STAFF_OIDC_CLIENT_SECRET'),
      redirectUri: url('EHR_STAFF_OIDC_REDIRECT_URI'),
      workspaceDomain: str('EHR_STAFF_WORKSPACE_DOMAIN'),
    },
    patient: {
      endpoints: endpoints('EHR_PATIENT_OIDC', undefined),
      clientId: str('EHR_PATIENT_OIDC_CLIENT_ID'),
      clientSecret: env['EHR_PATIENT_OIDC_CLIENT_SECRET'] || undefined,
      redirectUri: url('EHR_PATIENT_OIDC_REDIRECT_URI'),
    },
  };
  if (problems.length > 0) throw new ConfigError(problems);
  return cfg;
}
