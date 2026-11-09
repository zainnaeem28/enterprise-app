// r9: second staff principal (granted the doctor-surface role 'assistant' by grant-role.mjs) reads and replies; the first principal reads the reply.
import { open, signIn, BASE } from './staff-lib.mjs';
const [root, out] = process.argv.slice(2);
const T = { timeout: 15000 };
const g = await open(root, out, 'staff2', { sub: 'sub-ci-staff2', email: 'staff2@example.com' });
await signIn(g);
await g.step('staff2-landing', async () => { await g.p.goto(BASE + '/tasks'); await g.p.waitForTimeout(2500); });
await g.step('staff2-messages-list', async () => { await g.p.getByRole('tab', { name: 'Secure messages' }).click(T); await g.p.waitForTimeout(2500); }, 700);
await g.step('staff2-open-thread-and-reply', async () => {
  await g.p.getByRole('button', { name: /Synthetic: handover for Sam/ }).first().click(T); await g.p.waitForTimeout(2500);
  await g.p.screenshot({ path: `${out}/staff2-thread-open.png`, fullPage: true });
  await g.p.getByLabel('Your reply').fill('Synthetic reply: follow-up booked.', T);
  await g.p.getByRole('button', { name: 'Send', exact: true }).click(T); await g.p.waitForTimeout(2500);
}, 900);
await g.finish();

// first principal reads the reply
const d = await open(root, out, 'doctor-readback', { sub: 'sub-ci-doctor', email: 'doctor@example.com' });
await signIn(d);
await d.step('doctor-reads-reply', async () => {
  await d.p.goto(BASE + '/tasks'); await d.p.waitForTimeout(1500);
  await d.p.getByRole('tab', { name: 'Secure messages' }).click(T); await d.p.waitForTimeout(2000);
  await d.p.getByRole('button', { name: /Synthetic: handover for Sam/ }).first().click(T); await d.p.waitForTimeout(2500);
}, 900);
await d.finish();
