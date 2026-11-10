// API client for the QA-04 journeys: signs a persona in through the REAL OIDC flow (fixture IdP) and sends writes the way the
// portals do (session cookie, CSRF token, Idempotency-Key, Origin). Responses are returned verbatim; nothing is retried.
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { personaEmail, subjectOf } from './seed.mjs';

const req = createRequire(process.env.QA_PLAYWRIGHT_FROM ?? new URL('../../../../apps/staff/package.json', import.meta.url).pathname);
const { request } = req('@playwright/test');

export const state = () => JSON.parse(readFileSync(process.env.QA_STACK_STATE ?? 'reports/qa04/stack.json', 'utf8'));
const RELEASE = 'r1.000000000000';
// The API trusts X-Forwarded-For from loopback (trust proxy), and the unauthenticated rate limit is keyed by source IP. Each
// signed-in persona is a separate client, so each one gets its own synthetic address (10.200.x.y, never routable).
let ipSeq = Math.floor(Math.random() * 60000);
const nextIp = () => `10.200.${(ipSeq >> 8) & 255}.${(ipSeq++ & 255) || 1}`;

// The fixture IdP signs in "whoever is next", so two sign-ins must never overlap: one queue for all of them.
let signIn = Promise.resolve();
export function login(kind, key, over = {}) {
  const run = signIn.then(() => loginNow(kind, key, over), () => loginNow(kind, key, over));
  signIn = run.catch(() => {});
  return run;
}

async function loginNow(kind, key, over = {}) {
  const s = state();
  const host = kind === 'staff' ? 'localhost' : '127.0.0.1';
  const origin = `http://${host}:${s.ports.api}`;
  const idpPort = (kind === 'staff' ? s.ports.staffIdp : s.ports.patientIdp) + 1;
  const ctl = await fetch(
    `http://127.0.0.1:${idpPort}/next?sub=${encodeURIComponent(over.sub ?? subjectOf(key))}&email=${encodeURIComponent(over.email ?? personaEmail(key))}`,
  );
  if (!ctl.ok) throw new Error('IdP control failed');
  const ctx = await request.newContext({ baseURL: origin, extraHTTPHeaders: { 'x-client-release': RELEASE, 'x-forwarded-for': over.ip ?? nextIp() } });
  await ctx.get('/api/v1/auth/sign-in?returnTo=/', { maxRedirects: 10 });
  const sres = await ctx.get('/api/v1/auth/session');
  const session = sres.ok() ? await sres.json() : null;
  return new Client(ctx, origin, session, key, sres.status());
}

export class Client {
  constructor(ctx, origin, session, key, sessionStatus) {
    this.ctx = ctx;
    this.origin = origin;
    this.session = session;
    this.key = key;
    this.sessionStatus = sessionStatus;
  }
  async call(method, path, { body, headers = {}, idem = true, raw = false } = {}) {
    const h = { origin: this.origin, ...headers };
    if (method !== 'GET') {
      if (this.session?.csrfToken) h['x-csrf-token'] = this.session.csrfToken;
      if (idem && !h['idempotency-key']) h['idempotency-key'] = randomUUID();
    }
    const r = await this.ctx.fetch(path, { method, headers: h, data: body, maxRedirects: 0 });
    const text = await r.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    return { status: r.status(), headers: r.headers(), text, json };
  }
  get(path, o) { return this.call('GET', path, o); }
  post(path, body, o) { return this.call('POST', path, { body, ...o }); }
  patch(path, body, o) { return this.call('PATCH', path, { body, ...o }); }
  put(path, body, o) { return this.call('PUT', path, { body, ...o }); }
  delete(path, o) { return this.call('DELETE', path, o); }
  close() { return this.ctx.dispose(); }
}
