// Session routes of ARCHITECTURE 29.1 for the google and patient realms: sign-in redirect, callback, session, extend,
// sign-out and re-authentication. The admin routes of 29.1 (WebAuthn) belong to BE-05. The guard
// (`IdentityGuardPolicy`) has already authenticated the routes that need a session by the time a handler runs.
import { createHmac } from 'node:crypto';
import { Controller, Get, Post, Req as ReqParam, Res as ResParam } from '@nestjs/common';
import type { Type } from '@nestjs/common';
import type { KernelDb } from '@ehr/kernel';
import { ApiError } from '../../platform/errors.js';
import { hostOf } from '../../platform/http.js';
import type { Req, Res } from '../../platform/http.js';
import { PUBLIC } from '../../platform/permissions.js';
import { Route } from '../../platform/route.js';
import { IdentityError, SignInFailedError } from './errors.js';
import { requireAuthContext } from './guard-policy.js';
import { newPkce, randomUrlToken } from './oidc.js';
import { openOidcState, sealOidcState } from './oidc-state.js';
import type { OidcStateKeys } from './oidc-state.js';
import type { RealmAdapter, SignInRealm } from './realms.js';
import type { SessionService } from './sessions.js';
import type { SignInService } from './signin.js';
import type { SignInLimiter } from './signin-limiter.js';
import {
  buildCookie,
  clearCookie,
  issueToken,
  OIDC_COOKIE,
  OIDC_COOKIE_SECONDS,
  parseCookies,
  safeReturnTo,
  SID_COOKIE,
  hashPresentedToken,
} from './tokens.js';
import type { AuditService } from '../audit/index.js';

/** BQ-8: a re-authentication must have happened within this many seconds (with `prompt=login`). */
export const REAUTH_MAX_AGE_SECONDS = 300;

export interface AuthControllerDeps {
  db: KernelDb;
  orgId: string;
  /** Exact host (no port) -> realm. A host not listed gets 404 on the sign-in routes. */
  hosts: Readonly<Record<string, SignInRealm>>;
  realms: Readonly<Record<SignInRealm, RealmAdapter>>;
  oidcKeys: OidcStateKeys;
  /** `<env>/app/csrf-key`: its own secret. The CSRF token is HMAC(key, session id), so only its hash is stored (26.2). */
  csrfKey: string;
  sessions: SessionService;
  signIn: SignInService;
  limiter: SignInLimiter;
  audit: AuditService;
  now?: () => number;
}

export const csrfTokenFor = (csrfKey: string, sessionId: string): string =>
  createHmac('sha256', csrfKey).update(`csrf:${sessionId}`).digest('base64url');

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A generic page: no IdP text, no exception text, only the request id (29.1). */
function failurePage(res: Res, status: number, requestId: string, clearOidc: string): void {
  res.status(status);
  res.setHeader('Set-Cookie', [clearOidc]);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  );
  res.end(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign-in did not complete</title></head><body><main><h1>We could not sign you in</h1><p>Please go back and try again. If it keeps happening, quote this reference: <code>${escapeHtml(requestId)}</code></p></main></body></html>`,
  );
}

export function createAuthController(d: AuthControllerDeps): Type<unknown> {
  const now = d.now ?? Date.now;
  const lax = (realm: SignInRealm): 'Strict' | 'Lax' => (realm === 'google' ? 'Strict' : 'Lax');
  const realmOf = (req: Req): SignInRealm => {
    const realm = d.hosts[hostOf(req)];
    if (realm === undefined) throw new ApiError(404, 'kernel.not_found');
    return realm;
  };

  /** Starts the code flow: state, nonce and PKCE verifier go into the sealed Lax pre-auth cookie (SEC01-F-11). */
  function redirectToIdp(
    req: Req,
    res: Res,
    realm: SignInRealm,
    returnTo: string,
    opts: { reauth?: boolean } = {},
  ): void {
    const pkce = newPkce();
    const state = randomUrlToken();
    const nonce = randomUrlToken();
    const maxAgeSeconds = opts.reauth === true ? REAUTH_MAX_AGE_SECONDS : undefined;
    const sealed = sealOidcState(
      {
        realm,
        state,
        nonce,
        verifier: pkce.verifier,
        returnTo,
        expiresAt: now() + OIDC_COOKIE_SECONDS * 1000,
        ...(maxAgeSeconds === undefined ? {} : { maxAgeSeconds }),
      },
      d.oidcKeys,
    );
    const url = d.realms[realm].authorizationUrl({
      state,
      nonce,
      codeChallenge: pkce.challenge,
      ...(opts.reauth === true
        ? { prompt: 'login' as const, maxAgeSeconds: REAUTH_MAX_AGE_SECONDS }
        : {}),
    });
    res.setHeader('Set-Cookie', [
      buildCookie(OIDC_COOKIE, sealed, { maxAgeSeconds: OIDC_COOKIE_SECONDS, sameSite: 'Lax' }),
    ]);
    res.setHeader('Location', url);
    res.status(302);
    res.end();
    void req;
  }

  @Controller('api/v1/auth')
  class AuthController {
    @Get('sign-in')
    @Route({ permission: PUBLIC, resolver: 'none', releaseExempt: true })
    signInRoute(@ReqParam() req: Req, @ResParam() res: Res): void {
      const realm = realmOf(req);
      redirectToIdp(req, res, realm, safeReturnTo(req.query['returnTo']));
    }

    @Get('callback')
    @Route({ permission: PUBLIC, resolver: 'none', releaseExempt: true })
    async callback(@ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      const realm = realmOf(req);
      const ip = req.ip ?? 'unknown';
      const clearOidc = clearCookie(OIDC_COOKIE, 'Lax');
      // Limit first, before any verification work. A 429 is a problem body, not the generic page.
      await d.limiter.assertAllowed(ip);
      try {
        const q = req.query;
        const code =
          typeof q['code'] === 'string' && q['code'].length <= 2048 ? q['code'] : undefined;
        const stateParam =
          typeof q['state'] === 'string' && q['state'].length <= 256 ? q['state'] : undefined;
        const sealed = parseCookies(req.headers['cookie']).get(OIDC_COOKIE);
        const st = openOidcState(sealed, d.oidcKeys, now());
        if (
          code === undefined ||
          stateParam === undefined ||
          st === undefined ||
          st.realm !== realm
        )
          throw new SignInFailedError();
        const a = Buffer.from(stateParam);
        const b = Buffer.from(st.state);
        if (a.length !== b.length || !a.equals(b)) throw new SignInFailedError();

        let identity;
        try {
          identity = await d.realms[realm].complete({
            code,
            codeVerifier: st.verifier,
            nonce: st.nonce,
            ...(st.maxAgeSeconds === undefined ? {} : { maxAgeSeconds: st.maxAgeSeconds }),
          });
        } catch {
          throw new SignInFailedError(); // the IdP's or the verifier's reason never leaves the process
        }

        // SAR-IDF-04: a live session the browser still holds is revoked first, in its own short transaction under its
        // own settings. If the sign-in then fails the user stays signed out (fail closed); an unresolvable cookie is ignored.
        const old = hashPresentedToken(parseCookies(req.headers['cookie']).get(SID_COOKIE));
        if (old !== undefined) {
          const found = await d.sessions.lookup(old);
          if (found.state === 'live')
            await d.sessions.revoke(
              found.session,
              found.session.realm === realm ? 'sign_out' : 'realm_switch',
            );
        }

        const token = issueToken();
        const result = await d.signIn.signIn(
          identity,
          token,
          { ip: req.ip ?? null, userAgent: req.header('user-agent') ?? null },
          (id) => csrfTokenFor(d.csrfKey, id),
        );
        const maxAge = Math.max(1, Math.floor((result.absoluteExpiresAt.getTime() - now()) / 1000));
        res.setHeader('Set-Cookie', [
          clearOidc,
          buildCookie(SID_COOKIE, token.token, { maxAgeSeconds: maxAge, sameSite: lax(realm) }),
        ]);
        res.setHeader('Location', st.returnTo);
        res.status(302);
        res.end();
      } catch (err) {
        await d.limiter.recordFailure(ip, realm);
        if (err instanceof IdentityError && err.status === 429) throw err;
        failurePage(res, 401, req.requestId ?? 'unknown', clearOidc);
      }
    }

    @Get('session')
    @Route({ permission: PUBLIC, resolver: 'session', realm: 'none' })
    session(@ReqParam() req: Req): Record<string, unknown> {
      const ctx = requireAuthContext(req);
      return {
        principalId: ctx.session.principalId,
        realm: ctx.session.realm,
        audience: ctx.session.audience,
        displayName: ctx.displayName,
        csrfToken: csrfTokenFor(d.csrfKey, ctx.session.id),
        idleExpiresAt: ctx.idleExpiresAt.toISOString(),
        roles: ctx.roles.map((r) => ({
          key: r.key,
          ...(r.locationId === undefined ? {} : { locationId: r.locationId }),
        })),
        permissions: ctx.grants.keys(),
        patients: ctx.patients.map((p) => ({
          patientId: p.patientId,
          relation: p.relation,
          scope: p.scope,
        })),
      };
    }

    @Post('session/extend')
    @Route({ permission: PUBLIC, resolver: 'session', realm: 'none' })
    async extend(@ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      const ctx = requireAuthContext(req);
      const idle = await d.sessions.extend(ctx.session);
      res.setHeader('X-Session-Idle-Expires-At', idle.toISOString());
      res.status(200).json({ idleExpiresAt: idle.toISOString() });
    }

    @Post('sign-out')
    @Route({ permission: PUBLIC, resolver: 'session', realm: 'none' })
    async signOut(@ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      const ctx = requireAuthContext(req);
      await d.db.withScope(ctx.scope, async (tx) => {
        const r = await tx.query(
          `UPDATE identity.session SET revoked_at = now(), revoke_reason = 'sign_out' WHERE id = $1 AND revoked_at IS NULL`,
          [ctx.session.id],
        );
        if ((r.rowCount ?? 0) === 1)
          await d.audit.record(tx, {
            requestId: req.requestId ?? null,
            action: 'sign_out',
            resourceType: 'identity.session',
            resourceId: ctx.session.id,
            ip: req.ip ?? null,
            userAgent: req.header('user-agent') ?? null,
          });
      });
      res.setHeader('Set-Cookie', [clearCookie(SID_COOKIE, lax(ctx.session.realm as SignInRealm))]);
      res.status(204);
      res.end();
    }

    @Post('reauth')
    @Route({ permission: PUBLIC, resolver: 'session', realm: 'google' })
    reauth(@ReqParam() req: Req, @ResParam() res: Res): void {
      requireAuthContext(req);
      redirectToIdp(req, res, 'google', safeReturnTo(req.query['returnTo']), { reauth: true });
    }
  }
  return AuthController;
}
