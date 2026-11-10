// Admin realm (path B) client helpers for ENV-INT/ci. Enrolment, sign-in and elevation are the REAL ceremonies against the real API;
// the security key is the run's software authenticator held by the stack process (control port), signing with the CI attestation
// fixture (INT04-F21). Nothing here weakens or bypasses a control.
import { readFileSync } from 'node:fs';
import { Client, state, rawRequest } from './http.mjs';

const ctl = async (path, body) => {
  const s = state();
  const token = readFileSync(s.ctlTokenFile, 'utf8');
  const r = await fetch(`http://127.0.0.1:${s.ports.ctl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};
export const attest = (options, opts) => ctl('/attest', { options, opts });
export const assertWith = (options, opts) => ctl('/assert', { options, opts });

const adminOrigin = () => `https://${state().staffHost}`;
const AD = '/api/v1/admin';

/** Sets session state from a sign-in/enrolment/elevation response: the cookie goes into the jar, csrf into the client. */
function adopt(c, r) {
  if (r.status === 200 && r.json?.csrfToken)
    c.session = { csrfToken: r.json.csrfToken, ...(c.session ?? {}), ...r.json };
  return r;
}

/** Signs an enrolled administrator in with their key. Returns {client, response}. */
export async function signInAdmin(key, { client } = {}) {
  const s = state();
  const handle = s.admins[key].handle;
  const c = client ?? new Client(adminOrigin(), key);
  const opt = await c.post(`${AD}/auth/sign-in/options`, { handle }, { bearerless: true });
  if (opt.status !== 200) return { client: c, response: opt };
  const a = await assertWith(opt.json.publicKey ?? opt.json);
  if (a.status !== 200)
    return { client: c, response: { status: 401, json: a.json, text: 'no key' } };
  const ver = await c.post(
    `${AD}/auth/sign-in/verify`,
    { challengeId: opt.json.challengeId, handle, assertion: a.json },
    { bearerless: true },
  );
  adopt(c, ver);
  return { client: c, response: ver };
}

/** Enrols (token + first key + second key) and returns the signed-in client; falls back to sign-in if already enrolled. */
export async function adminClient(key) {
  const first = await signInAdmin(key);
  if (first.response.status === 200) return first.client;
  const s = state();
  const t = await ctl(`/enrolment-token?key=${encodeURIComponent(key)}`);
  if (t.status !== 200) throw new Error(`no enrolment token for ${key}`);
  const c = new Client(adminOrigin(), key);
  const o1 = await c.post(
    `${AD}/auth/enrolment/options`,
    { handle: t.json.handle, token: t.json.token },
    { bearerless: true },
  );
  if (o1.status !== 200) throw new Error(`enrolment options ${o1.status} ${o1.text}`);
  const a1 = await attest(o1.json.publicKey);
  const v1 = await c.post(
    `${AD}/auth/enrolment/verify`,
    {
      challengeId: o1.json.challengeId,
      handle: t.json.handle,
      token: t.json.token,
      attestation: a1.json,
    },
    { bearerless: true },
  );
  if (v1.status !== 200) throw new Error(`enrolment verify ${v1.status} ${v1.text}`);
  adopt(c, v1);
  const o2 = await c.post(`${AD}/auth/enrolment/second-key/options`, {});
  if (o2.status !== 200) throw new Error(`second key options ${o2.status} ${o2.text}`);
  const a2 = await attest(o2.json.publicKey);
  const v2 = await c.post(`${AD}/auth/enrolment/second-key/verify`, {
    challengeId: o2.json.challengeId,
    attestation: a2.json,
  });
  if (v2.status !== 200) throw new Error(`second key verify ${v2.status} ${v2.text}`);
  void s;
  return c;
}

/** C1 step-up: a WebAuthn assertion that grants an elevation window on this session. Returns the verify response. */
export async function elevate(c) {
  const o = await c.post(`${AD}/auth/elevation/options`, {});
  if (o.status !== 200) return o;
  const a = await assertWith(o.json.publicKey ?? o.json);
  if (a.status !== 200) return { status: 401, json: a.json, text: 'no key' };
  const v = await c.post(`${AD}/auth/elevation/verify`, {
    challengeId: o.json.challengeId,
    assertion: a.json,
  });
  return v;
}
export { rawRequest };
