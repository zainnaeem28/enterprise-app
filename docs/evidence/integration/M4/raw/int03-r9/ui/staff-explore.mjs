import { open, signIn, BASE } from './staff-lib.mjs';
const [root, out] = process.argv.slice(2);
const h = await open(root, out, 'explore', { sub: 'sub-ci-doctor', email: 'doctor@example.com' });
await signIn(h);
for (const path of ['/schedule', '/patients', '/notes-to-sign', '/arrivals', '/triage', '/forms', '/follow-ups', '/tasks', '/availability', '/waitlist']) await h.step('path' + path.replace(/\//g, '-'), async () => { await h.p.goto(BASE + path); await h.p.waitForTimeout(2500); }, 700);
await h.finish();
