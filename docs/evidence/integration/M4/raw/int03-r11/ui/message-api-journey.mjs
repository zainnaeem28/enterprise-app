// r8 message send/receive at the real API (the patient UI does not offer a compose form; the staff messaging screens are not mounted).
// Both sides sign in through the real OIDC flow (fixture IdPs); every call carries the session cookie, CSRF token and Idempotency-Key.
// usage: node message-api-journey.mjs <root>
import { createRequire } from 'node:module'; import { randomUUID } from 'node:crypto';
const root = process.argv[2];
const { request } = createRequire(root + '/apps/patient/package.json')('@playwright/test');
const PAT = '00000000-0000-7000-8000-000000000601', DOC = '00000000-0000-7000-8000-000000000501';
const out = [];
const log = (...a) => { const l = a.join(' '); out.push(l); console.log(l); };
async function login(base) {
  const c = await request.newContext({ baseURL: base, extraHTTPHeaders: { 'x-client-release': 'r1.000000000000' } });
  const r = await c.get('/api/v1/auth/sign-in?returnTo=/', { maxRedirects: 10 });
  const s = await c.get('/api/v1/auth/session'); const j = await s.json();
  log(`login ${base} -> session ${s.status()} csrf=${typeof j.csrfToken}`);
  return { c, csrf: j.csrfToken, session: j };
}
const post = async (u, path, body) => { const r = await u.c.post(path, { data: body, headers: { 'x-csrf-token': u.csrf, 'idempotency-key': randomUUID(), origin: new URL(u.base).origin } }); const t = await r.text(); log(`POST ${path} -> ${r.status()} ${t.slice(0, 160)}`); return { status: r.status(), json: t ? JSON.parse(t) : null }; };
const get = async (u, path) => { const r = await u.c.get(path); const t = await r.text(); log(`GET ${path} -> ${r.status()} ${t.slice(0, 220)}`); return t ? JSON.parse(t) : null; };
const pat = await login('http://127.0.0.1:4674'); pat.base = 'http://127.0.0.1:4674';
const stf = await login('http://localhost:4675'); stf.base = 'http://localhost:4675';
log('staff roles:', JSON.stringify(stf.session.roleKeys ?? stf.session.roles));
const body = 'Synthetic integration check: patient to clinic ' + new Date().toISOString();
const t = await post(pat, `/api/v1/patients/${PAT}/threads`, { subject: 'INT-03 r8 check', recipientPrincipalIds: [DOC], body });
const id = t.json?.id;
await get(stf, '/api/v1/threads');
if (id) { await get(stf, `/api/v1/threads/${id}/messages`);
  await post(stf, `/api/v1/threads/${id}/messages`, { body: 'Synthetic reply from the clinic' });
  await get(pat, `/api/v1/patients/${PAT}/threads`); }
// staff-to-staff thread (no second staff principal exists in the fixture: a note-to-self thread of one participant)
const st = await post(stf, '/api/v1/threads', { subject: 'INT-03 r8 staff thread', participantIds: [], body: 'Synthetic staff message' });
if (st.json?.id) { await post(stf, `/api/v1/threads/${st.json.id}/messages`, { body: 'Synthetic staff follow-up' }); await get(stf, `/api/v1/threads/${st.json.id}/messages`); await get(stf, '/api/v1/threads'); }
// authorization boundary: the patient session must not reach the staff thread list
const r = await pat.c.get('/api/v1/threads'); log(`boundary: patient GET /api/v1/threads -> ${r.status()}`);
(await import('node:fs')).writeFileSync(process.argv[3] ?? '/dev/null', out.join('\n') + '\n');
