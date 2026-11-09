// r10 staff journeys on the built staff app (Chromium, real API + worker). Doctor principal (doctor + front_desk + care_coordinator) and a second staff principal.
import { open, signIn, BASE } from './staff-lib.mjs';
const [root, out] = process.argv.slice(2);
const S2 = "00000000-0000-7000-8000-000000000521";
const T = { timeout: 15000 };
const h = await open(root, out, 'doctor', { sub: 'sub-ci-doctor', email: 'doctor@example.com' });
const { p, step } = h;
await signIn(h);
await step('schedule', async () => { await p.goto(BASE + '/schedule'); await p.waitForTimeout(2500); }, 700);
await step('visit-open-chart', async () => { await p.getByRole('button', { name: /Sam Synthetic/ }).nth(Number(process.env.VISIT ?? 0)).click(T); await p.waitForTimeout(3000); }, 600);
await step('note-editor', async () => { const st = p.getByRole('button', { name: 'Start consultation' }); if (await st.count()) { await st.click(T); await p.waitForTimeout(3000); } }, 900);
await step('note-write-and-save-draft', async () => {
  const ta = p.locator('textarea'); const txt = ['Synthetic: cough for 3 days.', 'Synthetic: temp 37.1, chest clear.', 'Synthetic: viral upper respiratory infection.', 'Synthetic: fluids, rest, review if worse.'];
  for (let i = 0; i < 4; i++) await ta.nth(i).fill(txt[i], T);
  await p.getByRole('button', { name: 'Save draft' }).click(T); await p.waitForTimeout(2500);
}, 900);
await step('note-sign-and-lock', async () => { await p.getByRole('button', { name: 'Sign and lock note' }).click(T); await p.waitForTimeout(2000); const d = p.getByRole('alertdialog').or(p.getByRole('dialog')); if (await d.count()) { await p.screenshot({ path: `${out}/doctor-sign-dialog.png`, fullPage: true }); await d.getByRole('button', { name: /sign/i }).last().click(T); } await p.waitForTimeout(3000); }, 900);
await step('notes-to-sign', async () => { await p.goto(BASE + '/notes-to-sign'); await p.waitForTimeout(2500); });
await step('tasks-create', async () => {
  await p.goto(BASE + '/tasks'); await p.waitForTimeout(2000);
  await p.getByRole('button', { name: 'New task' }).click(T);
  await p.getByLabel('Title').fill('Synthetic: call patient about results', T);
  await p.getByLabel('Details').fill('Synthetic detail, no real data', T);
  await p.getByRole('button', { name: 'Create task' }).click(T); await p.waitForTimeout(2500);
});
await step('tasks-mark-done', async () => { await p.getByRole('button', { name: /^Mark done: Synthetic: call patient/ }).click(T); await p.waitForTimeout(2500); });
await step('messages-new-thread', async () => {
  await p.getByRole('tab', { name: 'Secure messages' }).click(T); await p.waitForTimeout(1500);
  await p.getByRole('button', { name: 'New message' }).click(T);
  await p.getByLabel('Subject').fill('Synthetic: handover for Sam', T);
  await p.getByLabel('Recipients').fill(S2, T);
  await p.getByLabel('Message', { exact: true }).fill('Synthetic message: please book the follow-up.', T);
  await p.screenshot({ path: `${out}/doctor-message-form-filled.png`, fullPage: true });
  await p.getByRole('button', { name: 'Send message' }).click(T); await p.waitForTimeout(3000);
}, 700);
await h.finish();

