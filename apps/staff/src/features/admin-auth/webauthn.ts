// The browser half of the API-run WebAuthn ceremony (ARCH 26.1, B2). The server builds the options and verifies the answer; this
// file only converts between the JSON the API speaks (base64url strings) and the binary the browser API wants, and reports one of
// four outcomes. It never reads or stores a credential, a challenge or an assertion beyond the single call.

const B64URL = /^[A-Za-z0-9_-]*$/;

export function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  if (!B64URL.test(s)) throw new Error('not base64url');
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64url(b: ArrayBuffer | Uint8Array): string {
  const bytes = b instanceof Uint8Array ? b : new Uint8Array(b);
  let bin = '';
  for (const x of bytes) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** `PublicKeyCredentialRequestOptionsJSON` as the API returns it (the part this client reads). */
export interface RequestOptionsJson {
  challenge: string;
  timeout?: number;
  rpId?: string;
  userVerification?: 'required' | 'preferred' | 'discouraged';
  allowCredentials?: { id: string; type?: string; transports?: string[] }[];
}

/** The answer sent to `…/verify` as `assertion` (the shape `parseAssertion` in the API accepts). */
export interface AssertionJson {
  id: string;
  rawId: string;
  type: 'public-key';
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string | null;
  };
}

export type KeyOutcome =
  | { kind: 'ok'; assertion: AssertionJson }
  | { kind: 'cancelled' }
  | { kind: 'unsupported' }
  | { kind: 'error' };

/** Port over `navigator.credentials.get`, replaced in tests. Physical-key behaviour is checked by a human (Pending-human). */
export interface SecurityKey {
  get(options: RequestOptionsJson, signal?: AbortSignal): Promise<KeyOutcome>;
}

/** Narrow a server body to the options this client can use; anything else is refused rather than guessed at. */
export function parseRequestOptions(v: unknown): RequestOptionsJson | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o['challenge'] !== 'string' || !B64URL.test(o['challenge']) || o['challenge'] === '')
    return undefined;
  const allow = o['allowCredentials'];
  if (allow !== undefined) {
    if (!Array.isArray(allow)) return undefined;
    for (const c of allow) {
      const id = (c as { id?: unknown } | null)?.id;
      if (typeof id !== 'string' || !B64URL.test(id)) return undefined;
    }
  }
  return o as unknown as RequestOptionsJson;
}

function toPublicKey(o: RequestOptionsJson): PublicKeyCredentialRequestOptions {
  return {
    challenge: b64urlToBytes(o.challenge),
    // Ceremony parameters are the server's (userVerification required, RP ID = the exact staff host, ARCH 26.1 B2-2).
    userVerification: o.userVerification ?? 'required',
    ...(o.timeout === undefined ? {} : { timeout: o.timeout }),
    ...(o.rpId === undefined ? {} : { rpId: o.rpId }),
    allowCredentials: (o.allowCredentials ?? []).map((c) => ({
      type: 'public-key' as const,
      id: b64urlToBytes(c.id),
      ...(c.transports === undefined
        ? {}
        : { transports: c.transports as AuthenticatorTransport[] }),
    })),
  };
}

export const browserSecurityKey: SecurityKey = {
  async get(options, signal) {
    if (typeof navigator === 'undefined' || navigator.credentials?.get === undefined)
      return { kind: 'unsupported' };
    try {
      const cred = await navigator.credentials.get({
        publicKey: toPublicKey(options),
        ...(signal === undefined ? {} : { signal }),
      });
      if (cred === null || cred.type !== 'public-key') return { kind: 'error' };
      const pk = cred as PublicKeyCredential;
      const r = pk.response as AuthenticatorAssertionResponse;
      return {
        kind: 'ok',
        assertion: {
          id: pk.id,
          rawId: bytesToB64url(pk.rawId),
          type: 'public-key',
          response: {
            clientDataJSON: bytesToB64url(r.clientDataJSON),
            authenticatorData: bytesToB64url(r.authenticatorData),
            signature: bytesToB64url(r.signature),
            ...(r.userHandle === null ? {} : { userHandle: bytesToB64url(r.userHandle) }),
          },
        },
      };
    } catch (e) {
      const name = (e as { name?: string } | null)?.name;
      // The user dismissed the prompt, the prompt timed out, or our own abort: all "cancelled", never a failure to explain.
      if (name === 'NotAllowedError' || name === 'AbortError') return { kind: 'cancelled' };
      if (name === 'NotSupportedError' || name === 'SecurityError') return { kind: 'unsupported' };
      return { kind: 'error' };
    }
  },
};
