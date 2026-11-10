// Google Workspace sign-in for CMS admins (ARCHITECTURE 7 CMS row): a SEPARATE OAuth client, limited to the marketing
// group, 2SV enforced by the Workspace. Authorization-code flow with PKCE, state and nonce. The ID token is verified
// here (signature, issuer, audience, expiry, nonce, hosted domain, verified e-mail) and the e-mail must be on the
// marketing allow-list. Marketing identities get no role in the PHI portals: this client id is never used by them.
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
export const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

export interface OAuthTransaction {
  state: string;
  nonce: string;
  verifier: string;
}

const b64url = (b: Buffer): string => b.toString('base64url');

export function newTransaction(): OAuthTransaction {
  return {
    state: b64url(randomBytes(24)),
    nonce: b64url(randomBytes(24)),
    verifier: b64url(randomBytes(48)),
  };
}

export const challengeFor = (verifier: string): string =>
  b64url(createHash('sha256').update(verifier).digest());

export function buildAuthorizationUrl(args: {
  clientId: string;
  redirectUri: string;
  hostedDomain: string;
  tx: OAuthTransaction;
}): string {
  const u = new URL(GOOGLE_AUTH_ENDPOINT);
  u.search = new URLSearchParams({
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    response_type: 'code',
    scope: 'openid email',
    state: args.tx.state,
    nonce: args.tx.nonce,
    code_challenge: challengeFor(args.tx.verifier),
    code_challenge_method: 'S256',
    hd: args.hostedDomain,
    prompt: 'select_account',
    access_type: 'online',
  }).toString();
  return u.toString();
}

export const statesMatch = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
};

export type SignInDenial =
  | 'invalid_token'
  | 'nonce_mismatch'
  | 'email_unverified'
  | 'wrong_domain'
  | 'not_in_marketing_group';

export class SignInDenied extends Error {
  constructor(readonly reason: SignInDenial) {
    super(reason);
    this.name = 'SignInDenied';
  }
}

export interface VerifiedIdentity {
  sub: string;
  email: string;
}

export const googleKeys = (): JWTVerifyGetKey => createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));

export async function verifyGoogleIdToken(args: {
  idToken: string;
  clientId: string;
  hostedDomain: string;
  nonce: string;
  allowedEmails: ReadonlySet<string>;
  keys: JWTVerifyGetKey;
  now?: Date;
}): Promise<VerifiedIdentity> {
  let payload;
  try {
    ({ payload } = await jwtVerify(args.idToken, args.keys, {
      issuer: GOOGLE_ISSUERS,
      audience: args.clientId,
      algorithms: ['RS256'],
      currentDate: args.now,
      clockTolerance: 30,
    }));
  } catch {
    throw new SignInDenied('invalid_token');
  }
  if (typeof payload['nonce'] !== 'string' || !statesMatch(payload['nonce'], args.nonce)) {
    throw new SignInDenied('nonce_mismatch');
  }
  const email = typeof payload['email'] === 'string' ? payload['email'].toLowerCase() : '';
  if (!email || payload['email_verified'] !== true || typeof payload.sub !== 'string') {
    throw new SignInDenied('email_unverified');
  }
  // `hd` is set by Google only for Workspace accounts; both it and the e-mail domain must match.
  if (
    String(payload['hd'] ?? '').toLowerCase() !== args.hostedDomain ||
    !email.endsWith(`@${args.hostedDomain}`)
  ) {
    throw new SignInDenied('wrong_domain');
  }
  if (!args.allowedEmails.has(email)) throw new SignInDenied('not_in_marketing_group');
  return { sub: payload.sub, email };
}

export async function exchangeCode(args: {
  code: string;
  verifier: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const res = await (args.fetchImpl ?? fetch)(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: args.code,
      client_id: args.clientId,
      client_secret: args.clientSecret,
      redirect_uri: args.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: args.verifier,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new SignInDenied('invalid_token');
  const json = (await res.json()) as { id_token?: unknown };
  if (typeof json.id_token !== 'string') throw new SignInDenied('invalid_token');
  return json.id_token;
}
