import type { Endpoint, PayloadRequest } from 'payload';
import type { JWTVerifyGetKey } from 'jose';
import { loadCmsEnv } from '../lib/env';
import { openValue, sealValue } from '../lib/signed';
import { issueSession, sessionCookieName, sessionSetCookie } from './session';
import {
  SignInDenied,
  buildAuthorizationUrl,
  exchangeCode,
  googleKeys,
  newTransaction,
  statesMatch,
  verifyGoogleIdToken,
  type OAuthTransaction,
} from './google';

const TX_COOKIE = 'cms_oauth_tx';
const TX_TTL_SECONDS = 600;
const OAUTH_PATH = '/api/users/oauth';

const redirectUri = (publicUrl: string): string => `${publicUrl}${OAUTH_PATH}/google/callback`;
const cookieHeader = (value: string, maxAge: number): string =>
  `${TX_COOKIE}=${value}; Max-Age=${maxAge}; Path=${OAUTH_PATH}; HttpOnly; Secure; SameSite=Lax`;
const readCookie = (req: PayloadRequest, name: string): string | undefined =>
  req.headers
    .get('cookie')
    ?.split(';')
    .map((c) => c.trim().split('='))
    .find(([k]) => k === name)?.[1];

const back = (publicUrl: string, error?: string): Response =>
  new Response(null, {
    status: 302,
    headers: {
      location: `${publicUrl}/admin/login${error ? `?error=${encodeURIComponent(error)}` : ''}`,
      'cache-control': 'no-store',
    },
  });

// GET /api/users/oauth/google/start and /callback. No user input reaches a redirect target; the only redirect
// destinations are Google's fixed endpoint and this CMS's own /admin.
export interface OAuthDeps {
  keys?: JWTVerifyGetKey;
  fetchImpl?: typeof fetch;
}

export const createOAuthEndpoints = (deps: OAuthDeps = {}): Endpoint[] => {
  const keys = deps.keys ?? googleKeys();
  return [
    {
      path: '/oauth/google/start',
      method: 'get',
      handler: () => {
        const env = loadCmsEnv(process.env);
        const tx = newTransaction();
        const sealed = sealValue(
          env.payloadSecret,
          tx,
          Math.floor(Date.now() / 1000) + TX_TTL_SECONDS,
        );
        const location = buildAuthorizationUrl({
          clientId: env.google.clientId,
          redirectUri: redirectUri(env.publicUrl),
          hostedDomain: env.google.hostedDomain,
          tx,
        });
        return new Response(null, {
          status: 302,
          headers: {
            location,
            'set-cookie': cookieHeader(sealed, TX_TTL_SECONDS),
            'cache-control': 'no-store',
          },
        });
      },
    },
    {
      path: '/oauth/google/callback',
      method: 'get',
      handler: async (req) => {
        const env = loadCmsEnv(process.env);
        const url = new URL(req.url ?? '', env.publicUrl);
        const sealed = readCookie(req, TX_COOKIE);
        const tx = sealed
          ? openValue<OAuthTransaction>(env.payloadSecret, sealed, Math.floor(Date.now() / 1000))
          : null;
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        if (!tx || !code || !state || !statesMatch(state, tx.state))
          return withClearedTx(back(env.publicUrl, 'sign_in_failed'));
        try {
          const idToken = await exchangeCode({
            code,
            verifier: tx.verifier,
            clientId: env.google.clientId,
            clientSecret: env.google.clientSecret,
            redirectUri: redirectUri(env.publicUrl),
            fetchImpl: deps.fetchImpl,
          });
          const who = await verifyGoogleIdToken({
            idToken,
            clientId: env.google.clientId,
            hostedDomain: env.google.hostedDomain,
            nonce: tx.nonce,
            allowedEmails: env.allowedEmails,
            keys,
          });
          const payload = req.payload;
          const found = await payload.find({
            collection: 'users',
            where: { email: { equals: who.email } },
            limit: 1,
            depth: 0,
          });
          const data = {
            email: who.email,
            googleSub: who.sub,
            lastSignInAt: new Date().toISOString(),
          };
          const user = found.docs[0]
            ? await payload.update({ collection: 'users', id: found.docs[0].id, data, depth: 0 })
            : await payload.create({ collection: 'users', data, depth: 0 });
          const value = await issueSession({
            secret: payload.secret,
            userId: user.id,
            ttlSeconds: env.sessionTtlSeconds,
            nowSeconds: Math.floor(Date.now() / 1000),
          });
          const session = sessionSetCookie(
            sessionCookieName(payload.config.cookiePrefix),
            value,
            env.sessionTtlSeconds,
          );
          const res = back(env.publicUrl);
          res.headers.set('location', `${env.publicUrl}/admin`);
          res.headers.append('set-cookie', session);
          return withClearedTx(res);
        } catch (e) {
          // Reason is logged for operators and never echoed to the browser beyond a generic code.
          req.payload.logger.warn({
            msg: 'cms sign-in denied',
            reason: e instanceof SignInDenied ? e.reason : 'error',
          });
          return withClearedTx(back(env.publicUrl, 'sign_in_failed'));
        }
      },
    },
  ];
};

export const oauthEndpoints: Endpoint[] = createOAuthEndpoints();

function withClearedTx(res: Response): Response {
  res.headers.append('set-cookie', cookieHeader('', 0));
  return res;
}
