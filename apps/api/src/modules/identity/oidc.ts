// OpenID Connect authorisation-code flow with PKCE (ARCHITECTURE 26.1), built on node:crypto only: no OIDC library is
// added to the dependency list. The ID token is verified here, in the API, never trusted from the browser:
// signature against the issuer's JWKS (RS256 or ES256; `none` and symmetric algorithms are refused), issuer, audience
// (and `azp` when there are several), expiry, issued-at, nonce and, when a maximum authentication age was asked for,
// `auth_time` (BQ-8). Network access goes through an injected fetch, so the local conformance IdP of the tests and the
// real IdPs use the same code.
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto';
import type { JsonWebKey } from 'node:crypto';

export interface OidcEndpoints {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
}

export interface OidcClientConfig {
  endpoints: OidcEndpoints;
  clientId: string;
  /** Held in the secret store, passed in at start; never logged. Public clients omit it. */
  clientSecret?: string;
  redirectUri: string;
  scopes?: readonly string[];
  /** Accepted extra issuer spellings (Google also issues `accounts.google.com`). */
  extraIssuers?: readonly string[];
  fetchImpl?: typeof fetch;
  /** Allowed clock skew, seconds. */
  skewSeconds?: number;
  /** Test hook. */
  now?: () => number;
}

export class OidcVerificationError extends Error {
  constructor(readonly reason: string) {
    super('oidc verification failed');
    this.name = 'OidcVerificationError';
  }
}

export interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat?: number;
  nonce?: string;
  azp?: string;
  email?: string;
  email_verified?: boolean | string;
  hd?: string;
  name?: string;
  auth_time?: number;
  amr?: string[];
  phone_number_verified?: boolean | string;
  [k: string]: unknown;
}

export interface AuthorizationParams {
  state: string;
  nonce: string;
  codeChallenge: string;
  /** `login` forces re-authentication (BQ-8). */
  prompt?: 'login';
  maxAgeSeconds?: number;
  loginHint?: string;
}

export function newPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export const randomUrlToken = (bytes = 24): string => randomBytes(bytes).toString('base64url');

interface Jwk extends JsonWebKey {
  kid?: string;
  alg?: string;
  use?: string;
}
const b64json = (s: string): unknown => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

export class OidcClient {
  private jwks: { keys: Jwk[]; fetchedAt: number } | undefined;
  private readonly f: typeof fetch;
  private readonly skew: number;
  private readonly now: () => number;

  constructor(readonly cfg: OidcClientConfig) {
    this.f = cfg.fetchImpl ?? fetch;
    this.skew = cfg.skewSeconds ?? 60;
    this.now = cfg.now ?? Date.now;
  }

  authorizationUrl(p: AuthorizationParams): string {
    const u = new URL(this.cfg.endpoints.authorizationEndpoint);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', this.cfg.clientId);
    u.searchParams.set('redirect_uri', this.cfg.redirectUri);
    u.searchParams.set('scope', (this.cfg.scopes ?? ['openid', 'email', 'profile']).join(' '));
    u.searchParams.set('state', p.state);
    u.searchParams.set('nonce', p.nonce);
    u.searchParams.set('code_challenge', p.codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    if (p.prompt !== undefined) u.searchParams.set('prompt', p.prompt);
    if (p.maxAgeSeconds !== undefined) u.searchParams.set('max_age', String(p.maxAgeSeconds));
    if (p.loginHint !== undefined) u.searchParams.set('login_hint', p.loginHint);
    return u.toString();
  }

  /** Exchanges the code at the token endpoint and returns the raw ID token. The IdP's error text is never surfaced. */
  async exchangeCode(code: string, codeVerifier: string): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.cfg.redirectUri,
      client_id: this.cfg.clientId,
      code_verifier: codeVerifier,
    });
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    if (this.cfg.clientSecret !== undefined) {
      headers['authorization'] = `Basic ${Buffer.from(`${encodeURIComponent(this.cfg.clientId)}:${encodeURIComponent(this.cfg.clientSecret)}`).toString('base64')}`;
    }
    let res: Response;
    try {
      res = await this.f(this.cfg.endpoints.tokenEndpoint, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(5000) });
    } catch {
      throw new OidcVerificationError('token_endpoint_unreachable');
    }
    if (!res.ok) throw new OidcVerificationError('token_endpoint_refused');
    let json: { id_token?: unknown };
    try {
      json = (await res.json()) as { id_token?: unknown };
    } catch {
      throw new OidcVerificationError('token_response_malformed');
    }
    if (typeof json.id_token !== 'string' || json.id_token.length > 16_384)
      throw new OidcVerificationError('no_id_token');
    return json.id_token;
  }

  private async keys(refresh: boolean): Promise<Jwk[]> {
    const t = this.now();
    // A cached set is reused for 10 minutes; an unknown `kid` forces one refetch, at most once a minute.
    if (this.jwks !== undefined && !refresh && t - this.jwks.fetchedAt < 600_000) return this.jwks.keys;
    if (this.jwks !== undefined && refresh && t - this.jwks.fetchedAt < 60_000) return this.jwks.keys;
    let res: Response;
    try {
      res = await this.f(this.cfg.endpoints.jwksUri, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(5000) });
    } catch {
      throw new OidcVerificationError('jwks_unreachable');
    }
    if (!res.ok) throw new OidcVerificationError('jwks_refused');
    const j = (await res.json().catch(() => undefined)) as { keys?: unknown } | undefined;
    if (j === undefined || !Array.isArray(j.keys)) throw new OidcVerificationError('jwks_malformed');
    this.jwks = { keys: j.keys as Jwk[], fetchedAt: t };
    return this.jwks.keys;
  }

  async verifyIdToken(
    idToken: string,
    expect: { nonce: string; maxAgeSeconds?: number },
  ): Promise<IdTokenClaims> {
    const parts = idToken.split('.');
    if (parts.length !== 3) throw new OidcVerificationError('malformed');
    const [h, p, s] = parts as [string, string, string];
    let header: { alg?: unknown; kid?: unknown; typ?: unknown };
    let claims: IdTokenClaims;
    try {
      header = b64json(h) as typeof header;
      claims = b64json(p) as IdTokenClaims;
    } catch {
      throw new OidcVerificationError('malformed');
    }
    const alg = header.alg;
    if (alg !== 'RS256' && alg !== 'ES256') throw new OidcVerificationError('alg');
    const kid = typeof header.kid === 'string' ? header.kid : undefined;
    const pick = (keys: Jwk[]): Jwk | undefined =>
      keys.find((k) => (kid === undefined || k.kid === kid) && (k.use === undefined || k.use === 'sig') && (k.alg === undefined || k.alg === alg) && k.kty === (alg === 'RS256' ? 'RSA' : 'EC'));
    let jwk = pick(await this.keys(false));
    if (jwk === undefined) jwk = pick(await this.keys(true));
    if (jwk === undefined) throw new OidcVerificationError('unknown_key');
    let ok = false;
    try {
      const key = createPublicKey({ key: jwk, format: 'jwk' });
      const data = Buffer.from(`${h}.${p}`);
      const sig = Buffer.from(s, 'base64url');
      ok =
        alg === 'RS256'
          ? verify('RSA-SHA256', data, key, sig)
          : verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig);
    } catch {
      ok = false;
    }
    if (!ok) throw new OidcVerificationError('signature');

    const issuers = [this.cfg.endpoints.issuer, ...(this.cfg.extraIssuers ?? [])];
    if (typeof claims.iss !== 'string' || !issuers.includes(claims.iss)) throw new OidcVerificationError('iss');
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(this.cfg.clientId)) throw new OidcVerificationError('aud');
    if (aud.length > 1 && claims.azp !== this.cfg.clientId) throw new OidcVerificationError('azp');
    if (claims.azp !== undefined && claims.azp !== this.cfg.clientId) throw new OidcVerificationError('azp');
    const nowS = Math.floor(this.now() / 1000);
    if (typeof claims.exp !== 'number' || claims.exp + this.skew <= nowS) throw new OidcVerificationError('exp');
    if (claims.iat !== undefined && (typeof claims.iat !== 'number' || claims.iat - this.skew > nowS)) throw new OidcVerificationError('iat');
    if (typeof claims.nonce !== 'string') throw new OidcVerificationError('nonce');
    const a = Buffer.from(claims.nonce);
    const b = Buffer.from(expect.nonce);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new OidcVerificationError('nonce');
    if (typeof claims.sub !== 'string' || claims.sub.length === 0 || claims.sub.length > 255) throw new OidcVerificationError('sub');
    // BQ-8: when a maximum age was asked for, a stale `auth_time` is refused. A token without `auth_time` is accepted,
    // because the request carried `prompt=login` and the IdP re-authenticated the user (Google may omit the claim,
    // Part I C1 note); the session then records the time of this callback.
    if (expect.maxAgeSeconds !== undefined && claims.auth_time !== undefined) {
      if (typeof claims.auth_time !== 'number' || nowS - claims.auth_time > expect.maxAgeSeconds + this.skew)
        throw new OidcVerificationError('auth_time_stale');
    }
    return claims;
  }
}
