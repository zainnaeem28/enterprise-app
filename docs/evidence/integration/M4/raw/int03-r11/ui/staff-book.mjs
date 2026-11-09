// Creates one visit for today through the real API (availability search -> hold -> confirm). The staff-realm hold returned 403 (see staff-book-run-staff-403.txt), so this books as the patient. usage: node staff-book.mjs <root> <outfile>
import { createRequire } from 'node:module'; import { randomUUID } from 'node:crypto'; import { writeFileSync } from 'node:fs';
const [root, outFile] = process.argv.slice(2);
const { request } = createRequire(root + '/apps/staff/package.json')('@playwright/test');
const ids = { PAT: '00000000-0000-7000-8000-000000000601', DOC: '00000000-0000-7000-8000-000000000501', SVC: '00000000-0000-7000-8000-000000000301', LOC: '00000000-0000-7000-8000-000000000101' };
const out = []; const log = (...a) => { const l = a.join(' '); out.push(l); console.log(l); };
await fetch('http://127.0.0.1:9301/next?sub=sub-ci-doctor&email=doctor@example.com', { method: 'POST' });
const base = process.env.BOOK_BASE ?? 'http://127.0.0.1:4674'; // patient host: staff booking routes are not mounted (BE-13 README O-1), so the visit is booked as the patient
const c = await request.newContext({ baseURL: base, extraHTTPHeaders: { 'x-client-release': 'r1.000000000000' } });
await c.get('/api/v1/auth/sign-in?returnTo=/', { maxRedirects: 10 });
const sess = await (await c.get('/api/v1/auth/session')).json(); log('session roles', JSON.stringify(sess.roleKeys ?? sess.roles));
const post = async (path, data) => { const r = await c.post(path, { data, headers: { 'x-csrf-token': sess.csrfToken, 'idempotency-key': randomUUID(), origin: base } }); const t = await r.text(); log(`POST ${path} -> ${r.status()} ${t.slice(0, 200)}`); return { s: r.status(), j: t ? JSON.parse(t) : null }; };
const now = Date.now();
const s = await post('/api/v1/availability/search', { serviceId: ids.SVC, locationId: ids.LOC, clinicianId: ids.DOC, mode: 'in_person', from: new Date(now).toISOString(), to: new Date(now + 26 * 3600e3).toISOString() });
const slot = s.j.slots[0]; log('first slot', JSON.stringify(slot));
const h = await post('/api/v1/holds', { patientId: ids.PAT, serviceId: ids.SVC, locationId: ids.LOC, clinicianId: ids.DOC, startsAt: slot.startsAt, mode: 'in_person', reason: 'Synthetic r10 visit', patientState: 'NY' });
const a = await post(`/api/v1/appointments/${h.j.reservationId}/confirm`, {});
writeFileSync(outFile, out.join('\n') + '\n');
