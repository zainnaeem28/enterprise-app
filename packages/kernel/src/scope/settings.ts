import type { Queryable } from '../db.js';

export type Audience = 'anonymous' | 'patient' | 'staff' | 'partner' | 'system' | 'public';
export type Realm = 'patient_pool' | 'google' | 'admin_pool' | 'partner_pool' | 'worker' | 'none';

/** SHARED-BOUNDARIES 6.1 and ARCHITECTURE 21.3. Every field is optional: a missing setting fails closed. */
export interface ScopeSettings {
  audience: Audience;
  orgId?: string;
  realm?: Realm;
  principalId?: string;
  personId?: string;
  patientIds?: readonly string[];
  proxyPatientIds?: readonly string[];
  locationIds?: readonly string[];
  pharmacyOrgId?: string;
  btgPatientIds?: readonly string[];
  phiAccess?: 'full' | 'limited' | 'off';
  complianceScopes?: readonly string[];
  jobScope?: 'patients' | 'org';
  jobPatientIds?: readonly string[];
  sessionTokenHash?: string;
  webauthnChallengeId?: string;
}

/** Set only by the sign-in handlers after verification (21.3): see {@link SignInTx}. */
export interface AuthIdentity {
  realm: Realm;
  subject: string;
  email?: string;
}

type Kind = 'uuid' | 'uuids' | 'text' | 'texts' | 'hex';

interface Spec {
  setting: string;
  key: keyof ScopeSettings;
  kind: Kind;
}

const SPECS: readonly Spec[] = [
  { setting: 'app.audience', key: 'audience', kind: 'text' },
  { setting: 'app.org_id', key: 'orgId', kind: 'uuid' },
  { setting: 'app.realm', key: 'realm', kind: 'text' },
  { setting: 'app.principal_id', key: 'principalId', kind: 'uuid' },
  { setting: 'app.person_id', key: 'personId', kind: 'uuid' },
  { setting: 'app.patient_ids', key: 'patientIds', kind: 'uuids' },
  { setting: 'app.proxy_patient_ids', key: 'proxyPatientIds', kind: 'uuids' },
  { setting: 'app.location_ids', key: 'locationIds', kind: 'uuids' },
  { setting: 'app.pharmacy_org_id', key: 'pharmacyOrgId', kind: 'uuid' },
  { setting: 'app.btg_patient_ids', key: 'btgPatientIds', kind: 'uuids' },
  { setting: 'app.phi_access', key: 'phiAccess', kind: 'text' },
  { setting: 'app.compliance_scopes', key: 'complianceScopes', kind: 'texts' },
  { setting: 'app.job_scope', key: 'jobScope', kind: 'text' },
  { setting: 'app.job_patient_ids', key: 'jobPatientIds', kind: 'uuids' },
  { setting: 'app.session_token_hash', key: 'sessionTokenHash', kind: 'hex' },
  { setting: 'app.webauthn_challenge_id', key: 'webauthnChallengeId', kind: 'uuid' },
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLICE = /^[a-z_]{1,40}$/;
const WORD = /^[a-z_]{1,40}$/;
const HEX = /^[0-9a-f]{64}$/;

export class ScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopeError';
  }
}

function encode(spec: Spec, v: unknown): string {
  if (v === undefined) return '';
  switch (spec.kind) {
    case 'uuid':
      if (typeof v !== 'string' || !UUID.test(v))
        throw new ScopeError(`${spec.setting}: not a UUID`);
      return v.toLowerCase();
    case 'uuids': {
      if (!Array.isArray(v)) throw new ScopeError(`${spec.setting}: not an array`);
      for (const x of v)
        if (typeof x !== 'string' || !UUID.test(x))
          throw new ScopeError(`${spec.setting}: not a UUID`);
      return [...v].map((x) => (x as string).toLowerCase()).join(',');
    }
    case 'texts': {
      if (!Array.isArray(v)) throw new ScopeError(`${spec.setting}: not an array`);
      for (const x of v)
        if (typeof x !== 'string' || !SLICE.test(x))
          throw new ScopeError(`${spec.setting}: bad value`);
      return v.join(',');
    }
    case 'hex':
      if (typeof v !== 'string' || !HEX.test(v))
        throw new ScopeError(`${spec.setting}: not a SHA-256 hex digest`);
      return v;
    case 'text':
      if (typeof v !== 'string' || !WORD.test(v))
        throw new ScopeError(`${spec.setting}: bad value`);
      return v;
  }
}

/**
 * The single statement of 21.3: every setting through `set_config(name, value, true)` (transaction-local), one round
 * trip. Settings the caller did not give are set to '' so none can be inherited; the helper functions treat '' as
 * missing and the policies fail closed.
 */
export function buildScopeStatement(settings: ScopeSettings): { sql: string; params: string[] } {
  const params: string[] = [];
  const parts = SPECS.map((spec) => {
    params.push(encode(spec, settings[spec.key]));
    return `set_config('${spec.setting}', $${params.length}, true)`;
  });
  return { sql: `SELECT ${parts.join(', ')}`, params };
}

export async function applyScope(db: Queryable, settings: ScopeSettings): Promise<void> {
  if (settings.audience === undefined) throw new ScopeError('audience is required');
  const { sql, params } = buildScopeStatement(settings);
  await db.query(sql, params);
}

/** Pre-verification and post-verification sign-in settings (21.3). Callers are limited by the call-site check. */
export async function applyAuthIdentity(db: Queryable, id: AuthIdentity): Promise<void> {
  if (!WORD.test(id.realm)) throw new ScopeError('app.auth_realm: bad value');
  if (id.subject.length === 0 || id.subject.length > 255)
    throw new ScopeError('app.auth_subject: bad length');
  const email = id.email === undefined ? '' : id.email.toLowerCase();
  await db.query(
    `SELECT set_config('app.auth_realm', $1, true), set_config('app.auth_subject', $2, true), set_config('app.auth_email', $3, true)`,
    [id.realm, id.subject, email],
  );
}

export const SETTING_NAMES: readonly string[] = SPECS.map((s) => s.setting);
