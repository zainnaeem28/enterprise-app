// r11 F21: staff documents list on the real stack returns patientBanner (afa2018). The staff UI does not render it; the response is read from the signed-in browser session.
import { writeFileSync } from 'node:fs';
import { open, signIn, BASE } from './staff-lib.mjs';
const [root, out] = process.argv.slice(2);
const T = { timeout: 15000 };
const h = await open(root, out, 'docsbanner', { sub: 'sub-ci-doctor', email: 'doctor@example.com' });
const { p, step } = h;
await signIn(h);
await step('open-chart-documents', async () => { await p.goto(BASE + '/schedule'); await p.waitForTimeout(2500); await p.getByRole('button', { name: /Sam Synthetic/ }).nth(0).click(T); await p.waitForTimeout(3000); }, 700);
const PAT = '00000000-0000-7000-8000-000000000601';
const r = await p.evaluate(async (id) => { const x = await fetch(`/api/v1/patients/${id}/documents`, { credentials: 'include', headers: { 'x-client-release': 'r1.000000000000' } }); return { status: x.status, body: await x.json().catch(() => null) }; }, PAT);
const unknown = await p.evaluate(async () => { const x = await fetch('/api/v1/patients/00000000-0000-7000-8000-0000000009ff/documents', { credentials: 'include', headers: { 'x-client-release': 'r1.000000000000' } }); return x.status; });
const txt = `documents list for the chart patient: HTTP ${r.status}\nkeys: ${r.body ? Object.keys(r.body).join(',') : '(none)'}\npatientBanner: ${JSON.stringify(r.body?.patientBanner)}\nitems: ${JSON.stringify(r.body?.items)}\nunknown patient id: HTTP ${unknown}\n`;
writeFileSync(`${out}/docsbanner-api-body.txt`, txt); console.log(txt);
await h.finish();
