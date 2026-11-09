// The pre-authentication cookie `__Host-oidc` (ARCHITECTURE 26.1, SEC01-F-11): OIDC state, nonce, PKCE verifier and
// returnTo, sealed with AES-256-GCM under the application key `<env>/app/oidc-state-key` (current and previous version).
// It is Lax so that the top-level redirect back from the IdP carries it; the session cookie stays Strict.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export interface OidcState {
  realm: 'google' | 'patient_pool';
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  /** Set by `POST /auth/reauth`: the callback then insists on a fresh `auth_time` (BQ-8). */
  maxAgeSeconds?: number;
}

export interface OidcStateKeys {
  /** Key material of the current version; at least 32 characters of secret. */
  current: string;
  /** The previous version, accepted for opening only (rotation). */
  previous?: string;
}

const AAD = Buffer.from('ehr-oidc-state-v1');
const derive = (secret: string): Buffer =>
  createHash('sha256').update(`ehr-oidc-state:${secret}`).digest();

function checkKeys(keys: OidcStateKeys): void {
  if (keys.current.length < 32) throw new Error('oidc state key too short');
  if (keys.previous !== undefined && keys.previous.length < 32)
    throw new Error('oidc state key too short');
}

export function sealOidcState(s: OidcState, keys: OidcStateKeys): string {
  checkKeys(keys);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', derive(keys.current), iv, { authTagLength: 16 });
  c.setAAD(AAD);
  const ct = Buffer.concat([c.update(JSON.stringify(s), 'utf8'), c.final()]);
  return Buffer.concat([Buffer.from([1]), iv, c.getAuthTag(), ct]).toString('base64url');
}

/** Returns undefined for anything that does not authenticate or has expired. Never throws on bad input. */
export function openOidcState(
  sealed: string | undefined,
  keys: OidcStateKeys,
  now: number = Date.now(),
): OidcState | undefined {
  if (sealed === undefined || sealed.length === 0 || sealed.length > 2048) return undefined;
  checkKeys(keys);
  let buf: Buffer;
  try {
    buf = Buffer.from(sealed, 'base64url');
  } catch {
    return undefined;
  }
  if (buf.length < 1 + 12 + 16 + 2 || buf[0] !== 1) return undefined;
  const iv = buf.subarray(1, 13);
  const tag = buf.subarray(13, 29);
  const ct = buf.subarray(29);
  for (const secret of [keys.current, keys.previous]) {
    if (secret === undefined) continue;
    try {
      const d = createDecipheriv('aes-256-gcm', derive(secret), iv, { authTagLength: 16 });
      d.setAAD(AAD);
      d.setAuthTag(tag);
      const json = Buffer.concat([d.update(ct), d.final()]).toString('utf8');
      const v = JSON.parse(json) as Partial<OidcState>;
      if (
        (v.realm !== 'google' && v.realm !== 'patient_pool') ||
        typeof v.state !== 'string' ||
        typeof v.nonce !== 'string' ||
        typeof v.verifier !== 'string' ||
        typeof v.returnTo !== 'string' ||
        typeof v.expiresAt !== 'number'
      )
        return undefined;
      if (v.expiresAt <= now) return undefined;
      return v as OidcState;
    } catch {
      continue;
    }
  }
  return undefined;
}
