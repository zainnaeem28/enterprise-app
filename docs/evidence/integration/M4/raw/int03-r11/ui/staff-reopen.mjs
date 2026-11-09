// r10: F20 reopen an in-progress visit; F21 documents panel in the chart; alerts page and live stream.
import { open, signIn, BASE } from './staff-lib.mjs';
const [root, out] = process.argv.slice(2);
const T = { timeout: 15000 };
const h = await open(root, out, 'reopen', { sub: 'sub-ci-doctor', email: 'doctor@example.com' });
const { p, step } = h;
await signIn(h);
await step('schedule', async () => { await p.goto(BASE + '/schedule'); await p.waitForTimeout(2500); }, 500);
await step('open-visit-and-start-consultation', async () => { await p.getByRole('button', { name: /Sam Synthetic/ }).nth(0).click(T); await p.waitForTimeout(3000); const st = p.getByRole('button', { name: 'Start consultation' }); if (await st.count()) { await st.click(T); await p.waitForTimeout(3000); } }, 500);
await step('write-and-save-draft', async () => { const ta = p.locator('textarea'); await ta.nth(0).fill('Synthetic: reopen test, cough.', T); await p.getByRole('button', { name: 'Save draft' }).click(T); await p.waitForTimeout(2500); }, 500);
await step('back-to-schedule', async () => { await p.goto(BASE + '/schedule'); await p.waitForTimeout(2500); }, 500);
await step('reopen-same-visit-409-picker', async () => { await p.getByRole('button', { name: /Sam Synthetic/ }).nth(0).click(T); await p.waitForTimeout(3000); }, 900);
await step('pick-draft', async () => { await p.getByRole('button', { name: /Open this draft/ }).first().click(T); await p.waitForTimeout(3000); }, 700);
await step('documents-panel-in-chart', async () => { await p.goto(BASE + '/patients'); await p.waitForTimeout(2000); const b = p.getByRole('button', { name: /Sam Synthetic/ }); if (await b.count()) { await b.first().click(T); await p.waitForTimeout(3000); } }, 900);
await step('alerts-page', async () => { await p.goto(BASE + '/alerts'); await p.waitForTimeout(3000); }, 700);
await h.finish();
