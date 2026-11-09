// r9 front-desk journey: second staff principal holding ONLY front_desk + care_coordinator (the pre-consultation roles).
import { open, signIn, BASE } from './staff-lib.mjs';
const [root, out] = process.argv.slice(2);
const T = { timeout: 15000 };
const h = await open(root, out, 'frontdesk', { sub: 'sub-ci-staff2', email: 'staff2@example.com' });
const { p, step } = h;
await signIn(h);
await step('arrivals-board', async () => { await p.goto(BASE + '/arrivals'); await p.waitForTimeout(2500); }, 900);
await step('check-in-visit', async () => { await p.getByRole('button', { name: /^Check in: Sam Synthetic/ }).first().click(T); await p.waitForTimeout(2500); }, 900);
await step('triage-queue', async () => { await p.goto(BASE + '/triage'); await p.waitForTimeout(2500); }, 700);
await step('forms-review', async () => { await p.goto(BASE + '/forms'); await p.waitForTimeout(2500); }, 700);
await step('register-patient', async () => {
  await p.goto(BASE + '/arrivals'); await p.waitForTimeout(2000);
  await p.getByRole('tab', { name: 'Register a patient' }).click(T);
  await p.screenshot({ path: `${out}/frontdesk-register-form-empty.png`, fullPage: true });
  console.log(await p.$$eval('main input, main select, main textarea, main button', (els) => els.map((e) => `${e.tagName}:${e.getAttribute('aria-label') || e.labels?.[0]?.innerText || e.innerText || e.name}`.replace(/\s+/g, ' ').slice(0, 50)).join(' | ')));
}, 1200);
await step('follow-ups', async () => { await p.goto(BASE + '/follow-ups'); await p.waitForTimeout(2500); }, 700);
await step('tasks-route-for-front-desk', async () => { await p.goto(BASE + '/tasks'); await p.waitForTimeout(2500); }, 500);
await h.finish();
