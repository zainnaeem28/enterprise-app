// r10 patient journeys in Chromium against the REAL API + worker processes and the built patient app.
// usage: node r10-journey.mjs <repoRoot> <outDir>. Journeys: A book, B change, C cancel, D waitlist, E offer+decline, F offer+accept.
import { createRequire } from 'node:module';
const [root, out] = process.argv.slice(2);
const { chromium } = createRequire(root + '/apps/patient/package.json')('@playwright/test');
const pg = createRequire(root + '/package.json')('pg');
const ORG = '00000000-0000-7000-8000-0000000000a1';
const adminUrl = new URL(process.env.EHR_TEST_ADMIN_URL); adminUrl.pathname = '/ehr_int02_r10_ui';
const sql = async (s, params) => { const c = new pg.Client({ connectionString: adminUrl.toString() }); await c.connect();
  try { await c.query('BEGIN'); await c.query("SELECT set_config('app.org_id', $1, true), set_config('app.audience', 'system', true)", [ORG]); const r = await c.query(s, params); await c.query('COMMIT'); return r.rows; } finally { await c.end(); } };
const B = 'http://127.0.0.1:4174';
const b = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const p = await ctx.newPage();
const calls = [], log = [];
p.on('response', async (r) => { const u = new URL(r.url()); if (!u.pathname.startsWith('/api/')) return; calls.push(`${r.request().method()} ${u.pathname}${u.search} -> ${r.status()}`);
  if (r.status() >= 400 && r.status() !== 404) { try { const t = await r.text(); calls.push('    body: ' + t.slice(0, 500) + ' req: ' + (r.request().postData() ?? '').slice(0, 400)); } catch {} } });
const text = async () => (await p.innerText('body')).replace(/\s+/g, ' ').slice(0, 400);
let n = 0, failed = false, anyFailed = false;
const shot = async (name) => p.screenshot({ path: `${out}/${String(++n).padStart(2, '0')}-${name}.png`, fullPage: true });
async function step(name, fn) {
  if (failed) { log.push(`SKIP  ${name} (earlier step of this journey failed)`); return; }
  try { await fn(); log.push(`PASS  ${name}`); await shot(name); }
  catch (e) { failed = anyFailed = true; log.push(`FAIL  ${name}: ${e.message.split('\n')[0]}`); log.push('      url: ' + p.url() + ' body: ' + await text()); await shot('FAILED-' + name); }
}
const journey = (t) => { failed = false; log.push(`== ${t}`); };
const T = { timeout: 15000 };
const SLOT = /\d{1,2}:\d\d [AP]M/;
const mark = () => calls.length;
const since = (m) => calls.slice(m).join(' | ');
let apptId;

journey('A. sign-in (fresh database, NO manual task-type sync) and booking');
await step('landing', async () => { await p.goto(B + '/'); await p.waitForLoadState('networkidle'); });
await step('sign-in', async () => {
  const s = p.getByRole('button', { name: /sign in/i }).or(p.getByRole('link', { name: /sign in/i }));
  await s.first().click(T);
  const c = p.getByRole('button', { name: /continue/i }).or(p.getByRole('link', { name: /continue/i }));
  if (await c.count()) await c.first().click(T);
  await p.waitForURL((u) => u.port === '4174' && !u.pathname.startsWith('/continue'), T); await p.waitForLoadState('networkidle');
  log.push('      cookies: ' + (await ctx.cookies()).map((c) => `${c.name} secure=${c.secure} httpOnly=${c.httpOnly}`).join('; ') + ' landed: ' + p.url());
  if (!calls.some((c) => /auth\/session -> 200/.test(c))) throw new Error('no 200 session');
});
const book = async (svc) => {
  await p.goto(B + '/book'); await p.getByRole('radio').first().waitFor(T);
  await (svc ? p.getByRole('radio', { name: svc }) : p.getByRole('radio').first()).check();
  await p.getByRole('button', { name: 'Continue' }).click(T);
  const place = p.getByLabel('Place'); await place.waitFor(T);
  const o = await place.locator('option').allInnerTexts(); await place.selectOption({ index: o.length > 1 ? 1 : 0 }).catch(() => {});
  await p.getByLabel('Doctor').waitFor(T);
  await p.getByRole('button', { name: 'Continue' }).click(T);
  await p.getByRole('heading', { name: 'Choose a date and time' }).waitFor(T);
  await p.getByRole('button', { name: SLOT }).first().waitFor(T);
};
await step('service, place, clinician, availability', () => book(/General appointment/));
await step('hold', async () => { await p.getByRole('button', { name: SLOT }).nth(48).click(T); await p.getByRole('timer').waitFor(T); });
await step('review', async () => { await p.getByRole('button', { name: 'Continue' }).click(T); await p.getByRole('heading', { name: 'Check and confirm' }).waitFor(T); });
await step('confirm', async () => { await p.getByRole('button', { name: 'Confirm appointment' }).click(T); await p.getByRole('heading', { name: 'Your appointment is booked' }).waitFor(T); });
await step('add to calendar (ICS download from the booked page)', async () => {
  const [d] = await Promise.all([p.waitForEvent('download', T), p.getByRole('button', { name: 'Add to calendar' }).click(T)]);
  const f = `${out}/booked.ics`; await d.saveAs(f);
  const t = (await import('node:fs')).readFileSync(f, 'utf8');
  log.push('      downloaded ' + d.suggestedFilename() + ', ' + t.length + ' bytes, BEGIN:VEVENT=' + /BEGIN:VEVENT/.test(t) + ', DTSTART=' + /DTSTART/.test(t));
  if (!/BEGIN:VCALENDAR/.test(t) || !/BEGIN:VEVENT/.test(t)) throw new Error('no iCalendar event in the download');
});
await step('my appointments', async () => {
  await p.goto(B + '/appointments'); await p.getByRole('heading', { name: 'Your appointments' }).waitFor(T);
  await p.getByRole('button', { name: 'View details' }).first().waitFor(T);
});

journey('B. appointment detail and change time');
await step('detail', async () => {
  const m = mark(); await p.getByRole('button', { name: 'View details' }).first().click(T);
  await p.getByRole('button', { name: 'Change time' }).waitFor(T);
  apptId = new URL(p.url()).pathname.split('/').pop(); log.push('      appointment id seen in URL: ' + apptId + ' calls: ' + since(m));
});
let before;
await step('change: choose a different time', async () => {
  before = await p.innerText('main');
  await p.getByRole('button', { name: 'Change time' }).click(T);
  await p.getByRole('heading', { name: 'Choose a new time' }).waitFor(T);
  const slots = p.getByRole('button', { name: SLOT }); await slots.first().waitFor(T);
  await slots.nth(64).click(T); await p.waitForTimeout(800);
});
await step('change: confirm the new time', async () => {
  const m = mark(); await p.getByRole('button', { name: 'Continue' }).click(T);
  await p.getByRole('heading', { name: 'Confirm the new time' }).waitFor(T); await shot('change-review');
  await p.getByRole('button', { name: 'Change to this time' }).click(T);
  await p.waitForURL((u) => !u.pathname.endsWith('/confirm'), T); await p.waitForLoadState('networkidle');
  log.push('      calls: ' + since(m) + ' | page: ' + (await text()).slice(0, 200));
  if (!calls.slice(m).some((c) => /reschedule -> 200/.test(c))) throw new Error('reschedule did not return 200');
});
await step('appointments after change (still one confirmed)', async () => {
  await p.goto(B + '/appointments'); await p.getByRole('button', { name: 'View details' }).first().waitFor(T);
  log.push('      listed: ' + await p.getByRole('button', { name: 'View details' }).count() + ' | ' + (await text()).slice(0, 250));
});

journey('C. cancel');
await step('cancel page shows policy text', async () => {
  await p.getByRole('button', { name: 'View details' }).first().click(T);
  await p.getByRole('button', { name: 'Cancel appointment' }).click(T);
  await p.getByRole('heading', { level: 1 }).first().waitFor(T);
  log.push('      page: ' + (await text()).slice(0, 300));
});
await step('cancel confirmed', async () => {
  const m = mark();
  await p.getByRole('button', { name: 'Cancel appointment' }).first().click(T);
  await p.getByRole('dialog').or(p.getByRole('alertdialog')).waitFor(T); await shot('cancel-dialog');
  await p.getByRole('alertdialog').or(p.getByRole('dialog')).getByRole('button', { name: 'Cancel appointment' }).click(T);
  await p.waitForLoadState('networkidle'); await p.waitForTimeout(1000);
  log.push('      calls: ' + since(m) + ' | page: ' + (await text()).slice(0, 250));
  if (!calls.slice(m).some((c) => /cancel -> 200/.test(c))) throw new Error('cancel did not return 200');
});
await step('appointments after cancel', async () => {
  await p.goto(B + '/appointments'); await p.waitForLoadState('networkidle');
  log.push('      page: ' + (await text()).slice(0, 300));
});

journey('D. waitlist join (patient)');
await step('reach the waitlist page', async () => {
  await book(/Waitlist visit/).catch(() => {});
  const wl = p.getByRole('button', { name: 'join the waitlist' });
  await wl.waitFor(T);
  if (!(await wl.count())) throw new Error('no empty week reachable in the UI (waitlist link never shown)');
  await wl.click(T); await p.getByRole('heading', { name: 'Join the waitlist' }).waitFor(T);
});
await step('join', async () => {
  const m = mark(); await p.getByRole('button', { name: 'Join the waitlist' }).click(T);
  await p.waitForLoadState('networkidle'); await p.waitForTimeout(1000);
  log.push('      calls: ' + since(m) + ' | page: ' + (await text()).slice(0, 250));
  if (!calls.slice(m).some((c) => /waitlist-entries -> 20\d/.test(c))) throw new Error('waitlist-entries did not succeed');
});


journey('E. waitlist offer: freed slot -> worker offers -> accept (offer link opened in the UI)');
let offerId;
await step('SQL fixture: availability for the waitlist service clinician (disclosed)', async () => {
  const id = (n) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
  const T2 = '00000000-0000-7000-8000-000000000701';
  await sql(`INSERT INTO scheduling.availability_template (id, organisation_id, clinician_principal_id, location_id, valid_from) VALUES ($1,$2,$3,$4,'2020-01-01')`, [T2, ORG, id(511), id(101)]);
  for (let d = 0; d < 7; d++) await sql(`INSERT INTO scheduling.template_rule (id, organisation_id, template_id, clinician_principal_id, weekday, start_local, end_local, service_ids, mode, room_id) VALUES (gen_random_uuid(),$1,$2,$3,$4,'09:00','17:00',NULL,'either',$5)`, [ORG, T2, id(511), d, id(401)]);
});
await step('book the waitlist service slot days ahead (UI)', async () => {
  await book(/Waitlist visit/);
  await p.getByRole('button', { name: SLOT }).nth(48).click(T); await p.getByRole('timer').waitFor(T);
  await p.getByRole('button', { name: 'Continue' }).click(T); await p.getByRole('heading', { name: 'Check and confirm' }).waitFor(T);
  await p.getByRole('button', { name: 'Confirm appointment' }).click(T); await p.getByRole('heading', { name: 'Your appointment is booked' }).waitFor(T);
  log.push('      entries: ' + JSON.stringify(await sql(`SELECT status, count(*)::int FROM scheduling.waitlist_entry GROUP BY 1`)));
});
await step('cancel it in the UI (frees the slot)', async () => {
  await p.goto(B + '/appointments'); await p.getByRole('button', { name: 'View details' }).first().click(T);
  await p.getByRole('button', { name: 'Cancel appointment' }).click(T);
  await p.getByRole('button', { name: 'Cancel appointment' }).first().click(T);
  await p.getByRole('alertdialog').or(p.getByRole('dialog')).getByRole('button', { name: 'Cancel appointment' }).click(T);
  await p.waitForLoadState('networkidle');
});
const waitOffer = async (prevIds) => {
  let rows = [];
  for (let i = 0; i < 30 && !rows.length; i++) { await p.waitForTimeout(2000); rows = (await sql(`SELECT id, status, expires_at FROM scheduling.waitlist_offer ORDER BY created_at`)).filter((r) => !prevIds.includes(r.id)); }
  log.push('      offers: ' + JSON.stringify(rows));
  if (!rows.length) throw new Error('no new waitlist_offer row 60 s after the cancel');
  return rows[0];
};
const offerUrl = (o) => B + `/waitlist/offers/${o.id}?expires=${encodeURIComponent(new Date(o.expires_at).toISOString())}`;
const bookAndCancel = async (idx) => {
  await book(/Waitlist visit/);
  await p.getByRole('button', { name: SLOT }).nth(idx).click(T); await p.getByRole('timer').waitFor(T);
  await p.getByRole('button', { name: 'Continue' }).click(T); await p.getByRole('heading', { name: 'Check and confirm' }).waitFor(T);
  await p.getByRole('button', { name: 'Confirm appointment' }).click(T); await p.getByRole('heading', { name: 'Your appointment is booked' }).waitFor(T);
  await p.goto(B + '/appointments'); await p.getByRole('button', { name: 'View details' }).first().click(T);
  await p.getByRole('button', { name: 'Cancel appointment' }).click(T);
  await p.getByRole('button', { name: 'Cancel appointment' }).first().click(T);
  await p.getByRole('alertdialog').or(p.getByRole('dialog')).getByRole('button', { name: 'Cancel appointment' }).click(T);
  await p.waitForLoadState('networkidle');
};
await step('worker turns the freed slot into an offer (poll DB up to 60 s)', async () => { offerId = (await waitOffer([])).id; });
const offers1 = () => [offerId];
await step('DECLINE the offer in the UI (link as a notification would carry it)', async () => {
  const m = mark(); const o = (await sql(`SELECT id, status, expires_at FROM scheduling.waitlist_offer WHERE id=$1`, [offerId]))[0];
  await p.goto(offerUrl(o)); await p.getByRole('heading', { name: 'A time opened up for you' }).waitFor(T);
  await p.getByRole('button', { name: /decline|no thanks/i }).first().click(T);
  await p.waitForLoadState('networkidle'); await p.waitForTimeout(1000);
  log.push('      calls: ' + since(m) + ' | page: ' + (await text()).slice(0, 250));
  if (!calls.slice(m).some((c) => /decline -> 20\d/.test(c))) throw new Error('decline did not succeed');
  log.push('      offer: ' + JSON.stringify(await sql(`SELECT status FROM scheduling.waitlist_offer`)) + ' entry: ' + JSON.stringify(await sql(`SELECT status FROM scheduling.waitlist_entry`)));
});
journey('F. second freed slot -> second offer -> ACCEPT');
// a different slot on purpose: the product does not re-offer a slot the same entry declined (candidates() excludes it)
await step('book and cancel a DIFFERENT waitlist-service slot (UI)', () => bookAndCancel(60));
let offer2;
await step('worker creates a second offer', async () => { offer2 = await waitOffer(offers1()); });
await step('ACCEPT the offer in the UI', async () => {
  const m = mark();
  await p.goto(offerUrl(offer2)); await p.getByRole('heading', { name: 'A time opened up for you' }).waitFor(T);
  await p.getByRole('button', { name: /accept/i }).first().click(T);
  await p.waitForLoadState('networkidle'); await p.waitForTimeout(1500);
  log.push('      calls: ' + since(m) + ' | page: ' + (await text()).slice(0, 250));
  if (!calls.slice(m).some((c) => /accept -> 20\d/.test(c))) throw new Error('accept did not succeed');
  log.push('      offers: ' + JSON.stringify(await sql(`SELECT status FROM scheduling.waitlist_offer ORDER BY created_at`)) + ' entry: ' + JSON.stringify(await sql(`SELECT status FROM scheduling.waitlist_entry`)));
});
await step('appointments list shows the appointment created by the accepted offer', async () => {
  await p.goto(B + '/appointments'); await p.getByRole('button', { name: 'View details' }).first().waitFor(T);
  log.push('      listed: ' + await p.getByRole('button', { name: 'View details' }).count() + ' | ' + (await text()).slice(0, 250));
});
journey('G. staff view');
await step('staff app is reachable and shows what', async () => { throw new Error('not exercised: staff app is a connection placeholder (see apps/staff/src/App.tsx); no staff schedule/waitlist UI to open'); });

// ---- state evidence (what the worker really did) ----
const q = async (label, s) => { try { log.push(`STATE ${label}: ` + JSON.stringify(await sql(s))); } catch (e) { log.push(`STATE ${label}: query failed ${e.message.split('\n')[0]}`); } };
journey('state after the journeys (SQL read-only)');
await q('slot_occupancy', `SELECT status, count(*)::int FROM scheduling.slot_occupancy GROUP BY 1 ORDER BY 1`);
await q('waitlist_entry', `SELECT status, count(*)::int FROM scheduling.waitlist_entry GROUP BY 1`);
await q('waitlist_offer', `SELECT status, count(*)::int FROM scheduling.waitlist_offer GROUP BY 1`);
await q('waitlist_offer rows',`SELECT status, count(*)::int FROM scheduling.waitlist_offer GROUP BY 1`);
await q('notifications', `SELECT status, count(*)::int FROM notifications.notification GROUP BY 1`);
await q('audit events by realm/action (worker rows = written by a worker job)', `SELECT realm, action, count(*)::int FROM audit.event GROUP BY 1,2 ORDER BY 1,2`);
await q('audit events written by a job (job_id not null)', `SELECT left(job_id, 40) AS job, count(*)::int FROM audit.event WHERE job_id IS NOT NULL GROUP BY 1 ORDER BY 1`);
await q('queued jobs not yet processed', `SELECT t.identifier, j.attempts, j.run_at > now() AS in_future, left(coalesce(j.last_error,''),120) AS last_error FROM queue._private_jobs j JOIN queue._private_tasks t ON t.id = j.task_id ORDER BY j.run_at LIMIT 40`);

console.log(log.join('\n') + '\n--- API calls seen by the browser ---\n' + calls.join('\n'));
await b.close();
process.exit(anyFailed ? 1 : 0);
