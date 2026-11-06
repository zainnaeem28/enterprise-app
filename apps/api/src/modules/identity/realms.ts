// Realm adapters: what the sign-in handlers need from an identity provider, behind one interface per realm.
// `google` (staff) and `patient_pool` (patients) both run the same OIDC code flow; the checks that differ are here.
// The patient realm is reached only through `PatientIdentityAdapter`, so the identity service behind it (the managed
// patient user pool of ARCHITECTURE 26.1, or a local conformance IdP in tests) is replaceable without touching sessions.
import { OidcClient } from './oidc.js';
import type { AuthorizationParams, OidcClientConfig } from './oidc.js';

export type SignInRealm = 'google' | 'patient_pool';

/** The result of a verified sign-in at the IdP. Everything in it passed the realm's checks. */
export interface VerifiedIdentity {
  realm: SignInRealm;
  /** The IdP's immutable `sub`. */
  subject: string;
  /** Lower-cased. Always present for `google` (the binding key); optional for patients. */
  email?: string;
  displayName: string;
  /** When the user last authenticated at the IdP (claim, or the callback time when the IdP omits it). */
  authTime: Date;
  amr: string[];
}

export interface RealmAdapter {
  readonly realm: SignInRealm;
  authorizationUrl(p: AuthorizationParams): string;
  /** Exchanges the code and verifies the ID token. Throws on any failure; the message never reaches a client. */
  complete(input: { code: string; codeVerifier: string; nonce: string; maxAgeSeconds?: number }): Promise<VerifiedIdentity>;
}

/** The patient identity service adapter (ARCHITECTURE 26.1, patient_pool). */
export interface PatientIdentityAdapter extends RealmAdapter {
  readonly realm: 'patient_pool';
}

export class RealmCheckError extends Error {
  constructor(readonly reason: string) {
    super('realm check failed');
    this.name = 'RealmCheckError';
  }
}

const isTrue = (v: unknown): boolean => v === true || v === 'true';
const nameOf = (c: { name?: unknown; email?: unknown }, fallback: string): string => {
  const n = typeof c.name === 'string' ? c.name.trim() : '';
  const out = n.length > 0 ? n : fallback;
  return out.slice(0, 200);
};

export interface GoogleRealmConfig extends OidcClientConfig {
  /** The configured Workspace domain (the `hd` claim and the email domain must both equal it). */
  workspaceDomain: string;
}

export const GOOGLE_ENDPOINTS = {
  issuer: 'https://accounts.google.com',
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
} as const;

/**
 * Staff realm. Checks (26.1): signature, issuer, audience, `exp`, nonce (in the client); `email_verified = true`; the `hd`
 * claim equals the configured domain; the email's domain, the part after the last `@`, compared exactly (not `endsWith`),
 * equals it as well. A token without `hd` is refused. The realm comes from the route and configuration, never from a claim.
 */
export class GoogleRealmAdapter implements RealmAdapter {
  readonly realm = 'google' as const;
  private readonly client: OidcClient;
  private readonly domain: string;

  constructor(cfg: GoogleRealmConfig, now: () => number = Date.now) {
    this.domain = cfg.workspaceDomain.toLowerCase();
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(this.domain)) throw new Error('workspace domain is not a domain');
    this.client = new OidcClient({ extraIssuers: ['accounts.google.com'], ...cfg, now });
    this.now = now;
  }
  private readonly now: () => number;

  authorizationUrl(p: AuthorizationParams): string {
    const base = new URL(this.client.authorizationUrl(p));
    base.searchParams.set('hd', this.domain); // a hint only; the checks below are the control
    return base.toString();
  }

  async complete(input: { code: string; codeVerifier: string; nonce: string; maxAgeSeconds?: number }): Promise<VerifiedIdentity> {
    const idToken = await this.client.exchangeCode(input.code, input.codeVerifier);
    const c = await this.client.verifyIdToken(idToken, {
      nonce: input.nonce,
      ...(input.maxAgeSeconds === undefined ? {} : { maxAgeSeconds: input.maxAgeSeconds }),
    });
    if (!isTrue(c.email_verified)) throw new RealmCheckError('email_not_verified');
    if (typeof c.hd !== 'string' || c.hd.toLowerCase() !== this.domain) throw new RealmCheckError('hd');
    if (typeof c.email !== 'string' || c.email.length > 320) throw new RealmCheckError('email');
    const email = c.email.toLowerCase();
    const at = email.lastIndexOf('@');
    if (at < 1 || email.slice(at + 1) !== this.domain) throw new RealmCheckError('email_domain');
    return {
      realm: 'google',
      subject: c.sub,
      email,
      displayName: nameOf(c, email.slice(0, at)),
      authTime: typeof c.auth_time === 'number' ? new Date(c.auth_time * 1000) : new Date(this.now()),
      amr: Array.isArray(c.amr) ? c.amr.filter((x): x is string => typeof x === 'string').slice(0, 8) : [],
    };
  }
}

/** Patient realm over a standard OIDC provider (the managed patient user pool). No Workspace checks apply. */
export class OidcPatientAdapter implements PatientIdentityAdapter {
  readonly realm = 'patient_pool' as const;
  private readonly client: OidcClient;
  private readonly now: () => number;

  constructor(cfg: OidcClientConfig, now: () => number = Date.now) {
    this.client = new OidcClient({ ...cfg, now });
    this.now = now;
  }

  authorizationUrl(p: AuthorizationParams): string {
    return this.client.authorizationUrl(p);
  }

  async complete(input: { code: string; codeVerifier: string; nonce: string; maxAgeSeconds?: number }): Promise<VerifiedIdentity> {
    const idToken = await this.client.exchangeCode(input.code, input.codeVerifier);
    const c = await this.client.verifyIdToken(idToken, {
      nonce: input.nonce,
      ...(input.maxAgeSeconds === undefined ? {} : { maxAgeSeconds: input.maxAgeSeconds }),
    });
    const email = typeof c.email === 'string' && isTrue(c.email_verified) ? c.email.toLowerCase().slice(0, 320) : undefined;
    return {
      realm: 'patient_pool',
      subject: c.sub,
      ...(email === undefined ? {} : { email }),
      displayName: nameOf(c, 'Patient'),
      authTime: typeof c.auth_time === 'number' ? new Date(c.auth_time * 1000) : new Date(this.now()),
      amr: Array.isArray(c.amr) ? c.amr.filter((x): x is string => typeof x === 'string').slice(0, 8) : [],
    };
  }
}
