// A local OpenID Connect provider for tests ("local OIDC conformance IdP"): authorisation, token and JWKS endpoints on an
// ephemeral loopback port, RS256 signing with a key generated per instance, PKCE (S256) enforced at the token endpoint,
// single-use authorisation codes. Every claim and every defect (wrong nonce, wrong audience, expired, tampered signature,
// `alg: none`, ...) is scriptable per login, so the verifier is exercised against exactly the failures ARCHITECTURE 26.1 lists.
import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Defect =
  | 'wrong_nonce'
  | 'wrong_aud'
  | 'wrong_iss'
  | 'expired'
  | 'bad_signature'
  | 'alg_none'
  | 'alg_hs256'
  | 'unknown_kid'
  | 'wrong_azp'
  | 'no_nonce'
  | 'future_iat'
  | 'token_error';

export interface Login {
  sub: string;
  email?: string;
  email_verified?: boolean | string;
  hd?: string;
  name?: string;
  auth_time?: number;
  amr?: string[];
  defect?: Defect;
  /** Extra claims merged last. */
  extra?: Record<string, unknown>;
}

interface Pending {
  login: Login;
  nonce: string;
  challenge: string;
  clientId: string;
  redirectUri: string;
}

export class LocalIdp {
  private server!: Server;
  private readonly pending = new Map<string, Pending>();
  private readonly key = generateKeyPairSync('rsa', { modulusLength: 2048 });
  readonly kid = 'k1';
  clientId = 'test-client';
  nextLogin: Login = {
    sub: 'sub-default',
    email: 'user@example.com',
    email_verified: true,
    hd: 'example.com',
  };
  /** Parameters of the last authorisation request (prompt, max_age, hd, ...). */
  lastAuthorize: URLSearchParams = new URLSearchParams();
  tokenCalls = 0;
  jwksCalls = 0;
  base = '';

  get endpoints(): {
    issuer: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    jwksUri: string;
  } {
    return {
      issuer: this.base,
      authorizationEndpoint: `${this.base}/authorize`,
      tokenEndpoint: `${this.base}/token`,
      jwksUri: `${this.base}/jwks`,
    };
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/authorize') return this.authorize(url, res);
      if (url.pathname === '/jwks') return this.jwks(res);
      if (url.pathname === '/token' && req.method === 'POST') return void this.token(req, res);
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  /** What a browser does after the user signs in at the IdP: the redirect target the IdP would send it to. */
  authorizeUrl(authorizationUrl: string): string {
    return authorizationUrl;
  }

  private authorize(url: URL, res: import('node:http').ServerResponse): void {
    this.lastAuthorize = url.searchParams;
    const code = randomBytes(16).toString('hex');
    const p = url.searchParams;
    this.pending.set(code, {
      login: this.nextLogin,
      nonce: p.get('nonce') ?? '',
      challenge: p.get('code_challenge') ?? '',
      clientId: p.get('client_id') ?? '',
      redirectUri: p.get('redirect_uri') ?? '',
    });
    const back = new URL(p.get('redirect_uri') ?? '');
    back.searchParams.set('code', code);
    back.searchParams.set('state', p.get('state') ?? '');
    res.statusCode = 302;
    res.setHeader('Location', back.toString());
    res.end();
  }

  private jwks(res: import('node:http').ServerResponse): void {
    this.jwksCalls++;
    const jwk = this.key.publicKey.export({ format: 'jwk' });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ keys: [{ ...jwk, kid: this.kid, alg: 'RS256', use: 'sig' }] }));
  }

  private async token(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ): Promise<void> {
    this.tokenCalls++;
    let body = '';
    for await (const c of req) body += c;
    const f = new URLSearchParams(body);
    const pend = this.pending.get(f.get('code') ?? '');
    this.pending.delete(f.get('code') ?? ''); // single use
    const verifier = f.get('code_verifier') ?? '';
    const pkceOk =
      pend !== undefined &&
      createHash('sha256').update(verifier).digest('base64url') === pend.challenge;
    if (
      pend === undefined ||
      !pkceOk ||
      f.get('redirect_uri') !== pend.redirectUri ||
      pend.login.defect === 'token_error'
    ) {
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'SECRET-IDP-TEXT' }));
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        access_token: 'unused',
        token_type: 'Bearer',
        id_token: this.idToken(pend),
      }),
    );
  }

  idToken(p: Pending): string {
    const l = p.login;
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      iss: l.defect === 'wrong_iss' ? 'https://evil.example' : this.base,
      aud: l.defect === 'wrong_aud' ? 'someone-else' : this.clientId,
      sub: l.sub,
      iat: l.defect === 'future_iat' ? now + 3600 : now,
      exp: l.defect === 'expired' ? now - 3600 : now + 600,
      nonce: l.defect === 'wrong_nonce' ? 'not-the-nonce' : p.nonce,
      ...(l.email === undefined ? {} : { email: l.email }),
      ...(l.email_verified === undefined ? {} : { email_verified: l.email_verified }),
      ...(l.hd === undefined ? {} : { hd: l.hd }),
      ...(l.name === undefined ? {} : { name: l.name }),
      ...(l.auth_time === undefined ? {} : { auth_time: l.auth_time }),
      ...(l.amr === undefined ? {} : { amr: l.amr }),
      ...(l.defect === 'wrong_azp'
        ? { azp: 'other-client', aud: [this.clientId, 'other-client'] }
        : {}),
      ...l.extra,
    };
    if (l.defect === 'no_nonce') delete claims['nonce'];
    const alg = l.defect === 'alg_none' ? 'none' : l.defect === 'alg_hs256' ? 'HS256' : 'RS256';
    const header = { alg, typ: 'JWT', kid: l.defect === 'unknown_kid' ? 'nope' : this.kid };
    const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
    const signingInput = `${b64(header)}.${b64(claims)}`;
    if (alg === 'none') return `${signingInput}.`;
    if (alg === 'HS256') return `${signingInput}.${randomBytes(32).toString('base64url')}`;
    const sig = createSign('RSA-SHA256').update(signingInput).sign(this.key.privateKey);
    const out =
      l.defect === 'bad_signature'
        ? Buffer.concat([
            sig.subarray(0, sig.length - 1),
            Buffer.from([(sig[sig.length - 1] ?? 0) ^ 1]),
          ])
        : sig;
    return `${signingInput}.${out.toString('base64url')}`;
  }
}
