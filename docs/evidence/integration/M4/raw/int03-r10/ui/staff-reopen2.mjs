// r10 F20 part 2: the visit already has a consultation (started in staff-reopen.mjs); start it again from the chart -> 409 -> draft picker -> pick.
import { open, signIn, BASE } from './staff-lib.mjs';
const [root, out] = process.argv.slice(2);
const T = { timeout: 15000 };
const h = await open(root, out, 'reopen2', { sub: 'sub-ci-doctor', email: 'doctor@example.com' });
const { p, step } = h;
await signIn(h);
await step('open-same-visit', async () => { await p.goto(BASE + '/schedule'); await p.waitForTimeout(2500); await p.getByRole('button', { name: /Sam Synthetic/ }).nth(0).click(T); await p.waitForTimeout(3000); }, 300);
await step('start-consultation-again-409-picker', async () => { await p.getByRole('button', { name: 'Start consultation' }).click(T); await p.waitForTimeout(3000); }, 900);
await step('pick-draft', async () => { await p.getByRole('button', { name: /Open this draft/ }).first().click(T); await p.waitForTimeout(3000); }, 900);
await h.finish();
