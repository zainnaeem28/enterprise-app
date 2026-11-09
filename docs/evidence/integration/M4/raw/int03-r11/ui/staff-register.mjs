// r10 front desk: register a NEW synthetic patient, then a duplicate attempt (duplicate warning). Principal: front_desk + care_coordinator only.
import { open, signIn, BASE } from './staff-lib.mjs';
const [root, out] = process.argv.slice(2);
const T = { timeout: 15000 };
const h = await open(root, out, 'register', { sub: 'sub-ci-staff2', email: 'staff2@example.com' });
const { p, step } = h;
await signIn(h);
const fill = async (g, f, d) => { await p.getByLabel('Given name').fill(g, T); await p.getByLabel('Family name').fill(f, T); await p.getByLabel('Date of birth').fill(d, T); await p.getByLabel('State').fill('NY', T); await p.getByLabel('Phone').fill('+15555550142', T); await p.getByLabel('Email').fill('riley.testpatient@example.org', T); };
await step('new-patient-form-filled', async () => { await p.goto(BASE + '/arrivals'); await p.waitForTimeout(1500); await p.getByRole('tab', { name: 'Register a patient' }).click(T); await fill('Riley', 'Testpatient', '1991-02-03'); }, 600);
await step('new-patient-check-existing', async () => { await p.getByRole('button', { name: 'Check for an existing record' }).click(T); await p.waitForTimeout(3000); }, 900);
const buttons = await p.$$eval('main button', (e) => e.map((b) => b.innerText.replace(/\s+/g, ' ')));
console.log('BUTTONS', buttons.join(' | '));
const create = p.getByRole('button', { name: /^(Register|Create|Save)/ });
if (await create.count()) await step('new-patient-create', async () => { await create.first().click(T); await p.waitForTimeout(3000); }, 900);
await step('duplicate-patient-warning', async () => { await p.goto(BASE + '/arrivals'); await p.waitForTimeout(1500); await p.getByRole('tab', { name: 'Register a patient' }).click(T); await fill('Sam', 'Synthetic', '1980-01-01'); await p.getByRole('button', { name: 'Check for an existing record' }).click(T); await p.waitForTimeout(3000); }, 900);
await h.finish();
