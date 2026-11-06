import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CALENDAR_SCOPES,
  GOOGLE_AUTH_URL,
  GOOGLE_TOKEN_URL,
  GoogleCalendarOAuth,
  OAuthExchangeError,
} from './oauth.js';

const mk = (f: typeof fetch) =>
  new GoogleCalendarOAuth({
    clientId: 'cid',
    clientSecret: 'csecret-0123456789',
    redirectUri: 'https://staff.example.test/api/v1/calendar-link/callback',
    fetch: f,
  });
const reply = (status: number, body: unknown): typeof fetch =>
  (() => Promise.resolve(new Response(JSON.stringify(body), { status }))) as never;

test('the authorisation URL: fixed Google host, offline access, S256, exactly the two minimal scopes, no client secret', () => {
  const u = new URL(mk(reply(200, {})).authorizationUrl({ state: 'st', codeChallenge: 'ch' }));
  assert.equal(`${u.origin}${u.pathname}`, GOOGLE_AUTH_URL);
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('scope'), CALENDAR_SCOPES.join(' '));
  assert.equal(u.searchParams.get('client_id'), 'cid');
  assert.ok(!u.toString().includes('csecret'));
  assert.equal(GOOGLE_TOKEN_URL, 'https://oauth2.googleapis.com/token');
});

test('the exchange returns the refresh token and sends the PKCE verifier; failures are classes with no vendor text', async () => {
  let sent = '';
  const ok = mk(((_u: string, init: { body: URLSearchParams }) => {
    sent = init.body.toString();
    return Promise.resolve(
      new Response(JSON.stringify({ refresh_token: 'RT-0123456789', access_token: 'at' }), {
        status: 200,
      }),
    );
  }) as never);
  assert.deepEqual(await ok.exchangeCode({ code: 'c', codeVerifier: 'v' }), {
    refreshToken: 'RT-0123456789',
  });
  assert.match(sent, /grant_type=authorization_code/);
  assert.match(sent, /code_verifier=v/);
  const cls = async (f: typeof fetch) =>
    (await mk(f)
      .exchangeCode({ code: 'c', codeVerifier: 'v' })
      .catch((e: OAuthExchangeError) => e)) as OAuthExchangeError;
  assert.equal(
    (await cls(reply(400, { error: 'invalid_grant', error_description: 'code CANARY-ECHO' })))
      .reason,
    'rejected',
  );
  assert.equal((await cls(reply(503, {}))).reason, 'unavailable');
  assert.equal((await cls(reply(429, {}))).reason, 'unavailable');
  assert.equal((await cls(reply(200, { access_token: 'at' }))).reason, 'no_refresh_token');
  assert.equal(
    (await cls((() => Promise.reject(new Error('boom CANARY-ECHO'))) as never)).reason,
    'unavailable',
  );
  const e = await cls(reply(400, { error_description: 'code CANARY-ECHO' }));
  assert.ok(!e.message.includes('CANARY') && !String(e.stack).includes('CANARY'));
});
