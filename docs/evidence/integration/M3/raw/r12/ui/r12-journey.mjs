// r12 patient journeys (distinct offer screenshots per R10-FR-N1; notification probes per stage) in Chromium against the REAL API + worker processes and the built patient app.
// usage: node r12-journey.mjs <repoRoot> <outDir>. Journeys: A book, B change, C cancel, D waitlist, E offer+decline, F offer+accept.
import { createRequire } from 'node:module';
const [root, out] = process.argv.slice(2);
const { chromium } = createRequire(root + '/apps/patient/package.json')('@playwright/test');
const pg = createRequire(root + '/package.json')('pg');
const ORG = '00000000-0000-7000-8000-0000000000a1';
const adminUrl = new URL(process.env.EHR_TEST_ADMIN_URL); adminUrl.pathname = '/ehr_int02_r12_ui';
const sql = async (s, params) => { const c = new pg.Client({ connectionString: adminUrl.toString() }); await c.connect();
  try { await c.query('BEGIN'); await c.query("SELECT set_config('app.org_id', $1, true), set_config('app.audience', 'system', true)", [ORG]); const r = await c.query(s, params); await c.query('COMMIT'); return r.rows; } finally { await c.end(); } };
const B = 'http://127.0.0.1:4274';
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
const NQ = `SELECT template_key, channel, status, coalesce(suppress_reason,'') AS why, count(*)::int FROM notifications.notification GROUP BY 1,2,3,4 ORDER BY 1,2,3`;
// per-row view of the appointment notices: dedupe key (carries the reservation id and offset), status, send_after, and hours from send_after to that reservation's start
const NR = `SELECT n.template_key AS tpl, n.channel AS ch, n.status, coalesce(n.suppress_reason,'') AS why, left(n.dedupe_key, 22) AS dk, round((extract(epoch FROM (lower(o.period) - n.send_after))/3600)::numeric, 1)::float AS h_before_start, (n.send_after > now()) AS future
  FROM notifications.notification n LEFT JOIN scheduling.slot_occupancy o ON o.id::text = split_part(n.dedupe_key, ':', CASE WHEN n.dedupe_key LIKE 'reminder:%' THEN 2 ELSE 2 END)
 WHERE n.template_key LIKE 'appointment_%' ORDER BY n.created_at, n.template_key, n.channel`;
const notes = async (label) => { try { log.push(`      NOTIFICATIONS after ${label}: ` + JSON.stringify(await sql(NQ))); log.push(`      APPOINTMENT NOTICE ROWS after ${label}: ` + JSON.stringify(await sql(NR))); } catch (e) { log.push('      notifications query failed: ' + e.message.split('\n')[0]); } };
const tmpl = async () => log.push('      templates present (published): ' + JSON.stringify(await sql(`SELECT key, count(*)::int AS rows FROM notifications.template WHERE status='published' GROUP BY 1 ORDER BY 1`)));

journey('A. sign-in (fresh database, NO manual task-type sync) and booking');
await step('landing', async () => { await p.goto(B + '/'); await p.waitForLoadState('networkidle'); });
await step('sign-in', async () => {
  const s = p.getByRole('button', { name: /sign in/i }).or(p.getByRole('link', { name: /sign in/i }));
  await s.first().click(T);
  const c = p.getByRole('button', { name: /continue/i }).or(p.getByRole('link', { name: /continue/i }));
  if (await c.count()) await c.first().click(T);
  await p.waitForURL((u) => u.port === '4274' && !u.pathname.startsWith('/continue'), T); await p.waitForLoadState('networkidle');
  log.push('      cookies: ' + (await ctx.cookies()).map((c) => `${c.name} secure=${c.secure} httpOnly=${c.httpOnly}`).join('; ') + ' landed: ' + p.url());
  if (!calls.some((c) => /auth\/session -> 200/.test(c))) throw new Error('no 200 session');
  await tmpl();
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
  await p.waitForTimeout(3000); await notes('booking confirm');
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
  await p.waitForTimeout(3000); await notes('change');
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
  await p.waitForTimeout(3000); await notes('cancel');
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
  await p.waitForLoadState('networkidle'); await p.goto(B + '/appointments'); await p.waitForLoadState('networkidle');
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
  await p.waitForLoadState('networkidle'); await p.goto(B + '/appointments'); await p.waitForLoadState('networkidle');
};
await step('worker turns the freed slot into an offer (poll DB up to 60 s)', async () => { const o = await waitOffer([]); offerId = o.id; await notes('worker offer'); await p.goto(offerUrl(o)); await p.getByRole('heading', { name: 'A time opened up for you' }).waitFor(T); });
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
await step('worker creates a second offer', async () => { offer2 = await waitOffer(offers1()); await notes('second offer'); await p.goto(offerUrl(offer2)); await p.getByRole('heading', { name: 'A time opened up for you' }).waitFor(T); });
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
journey('H. video booking, reschedule (OBS-2: does the new reservation get a telehealth meeting?) and notices');
const TV = `SELECT (SELECT count(*)::int FROM telehealth.video_session) AS sessions, (SELECT count(*)::int FROM telehealth.video_session WHERE reservation_id IS NOT NULL) AS with_reservation`;
let vres;
await step('book a VIDEO visit (UI, asks for the patient state)', async () => {
  await p.goto(B + '/book'); await p.getByRole('radio').first().waitFor(T);
  await p.getByRole('radio', { name: /Video visit/ }).check();
  await p.getByRole('button', { name: 'Continue' }).click(T);
  const place = p.getByLabel('Place'); await place.waitFor(T);
  const o = await place.locator('option').allInnerTexts(); await place.selectOption({ index: o.length > 1 ? 1 : 0 }).catch(() => {});
  await p.getByLabel('Doctor').waitFor(T);
  await p.getByRole('button', { name: 'Continue' }).click(T);
  await p.getByRole('heading', { name: 'Choose a date and time' }).waitFor(T);
  await p.getByRole('button', { name: SLOT }).first().waitFor(T);
  const st = p.getByLabel(/state/i); await st.first().waitFor(T); await st.first().fill('NY');
  await p.getByRole('button', { name: SLOT }).nth(40).click(T);
  await p.getByRole('timer').waitFor(T);
  await p.getByRole('button', { name: 'Continue' }).click(T); await p.getByRole('heading', { name: 'Check and confirm' }).waitFor(T);
  await p.getByRole('button', { name: 'Confirm appointment' }).click(T); await p.getByRole('heading', { name: 'Your appointment is booked' }).waitFor(T);
  log.push('      booked page: ' + (await text()).slice(0, 300));
  await p.waitForTimeout(4000);
  vres = (await sql(`SELECT r.id FROM scheduling.slot_reservation r JOIN scheduling.slot_occupancy o ON o.id=r.id WHERE o.status='confirmed' ORDER BY o.created_at DESC LIMIT 1`))[0]?.id;
  log.push('      video reservation: ' + vres);
  log.push('      TELEHEALTH after video booking: ' + JSON.stringify(await sql(TV)) + ' ' + JSON.stringify(await sql(`SELECT reservation_id, status FROM telehealth.video_session`)));
  await notes('video booking');
});
await step('reschedule the video visit (UI)', async () => {
  const m = mark();
  await p.goto(B + '/appointments/' + vres); await p.getByRole('button', { name: 'Change time' }).waitFor(T);
  await p.getByRole('button', { name: 'Change time' }).click(T);
  await p.getByRole('heading', { name: 'Choose a new time' }).waitFor(T);
  const stc = p.getByLabel(/state/i); if (await stc.count()) await stc.first().fill('NY');
  const slots = p.getByRole('button', { name: SLOT }); await slots.first().waitFor(T);
  await slots.nth(70).click(T); await p.waitForTimeout(800);
  await p.getByRole('button', { name: 'Continue' }).click(T);
  await p.getByRole('heading', { name: 'Confirm the new time' }).waitFor(T);
  await p.getByRole('button', { name: 'Change to this time' }).click(T);
  await p.waitForURL((u) => !u.pathname.endsWith('/confirm'), T); await p.waitForLoadState('networkidle');
  if (!calls.slice(m).some((c) => /reschedule -> 200/.test(c))) throw new Error('reschedule did not return 200');
  await p.waitForTimeout(5000);
  log.push('      TELEHEALTH after video reschedule: ' + JSON.stringify(await sql(TV)));
  log.push('      video sessions by reservation: ' + JSON.stringify(await sql(`SELECT v.reservation_id, o.status AS occupancy_status FROM telehealth.video_session v LEFT JOIN scheduling.slot_occupancy o ON o.id=v.reservation_id`)));
  log.push('      confirmed video reservations now: ' + JSON.stringify(await sql(`SELECT o.id, o.status FROM scheduling.slot_occupancy o JOIN scheduling.slot_reservation r ON r.id=o.id JOIN organisation.service s ON s.id=r.service_id WHERE s.mode='video' ORDER BY o.created_at`)));
  await notes('video reschedule');
});
journey('I. negative control: notification templates removed (SQL, disclosed), then book -> what happens');
await step('retire all appointment_* notification templates by SQL (delete is refused by a trigger), then book and observe', async () => {
  log.push('      templates before delete: ' + JSON.stringify(await sql(`SELECT count(*)::int AS n FROM notifications.template`)));
  const del = await sql(`WITH d AS (UPDATE notifications.template SET status='retired' WHERE key LIKE 'appointment_%' AND status='published' RETURNING 1) SELECT count(*)::int AS retired FROM d`).catch((e) => [{ error: e.message.split('\n')[0] }]);
  log.push('      delete result: ' + JSON.stringify(del) + ' retired-state: ' + JSON.stringify(await sql(`SELECT count(*)::int AS n FROM notifications.template`)));
  const before = (await sql(`SELECT count(*)::int AS n FROM notifications.notification`))[0].n;
  await p.waitForTimeout(12000); const before2 = (await sql(`SELECT count(*)::int AS n FROM notifications.notification`))[0].n; await book(/General appointment/);
  await p.getByRole('button', { name: SLOT }).nth(56).click(T); await p.getByRole('timer').waitFor(T);
  await p.getByRole('button', { name: 'Continue' }).click(T); await p.getByRole('heading', { name: 'Check and confirm' }).waitFor(T);
  await p.getByRole('button', { name: 'Confirm appointment' }).click(T); await p.getByRole('heading', { name: 'Your appointment is booked' }).waitFor(T);
  await p.waitForTimeout(8000);
  log.push('      notifications before/after: ' + before + ' / ' + JSON.stringify(await sql(`SELECT count(*)::int AS n FROM notifications.notification`)));
  log.push('      NEG-CONTROL notices created for the new booking: ' + JSON.stringify(await sql(`SELECT template_key, channel, status, coalesce(suppress_reason,'') AS why FROM notifications.notification WHERE created_at > now() - interval '10 seconds' AND template_key LIKE 'appointment_%' ORDER BY 1,2`)));
  log.push('      booking confirmed anyway: ' + JSON.stringify(await sql(`SELECT status, count(*)::int FROM scheduling.slot_occupancy GROUP BY 1`)));
  log.push('      jobs with errors: ' + JSON.stringify(await sql(`SELECT t.identifier, j.attempts, left(coalesce(j.last_error,''),160) AS last_error FROM queue._private_jobs j JOIN queue._private_tasks t ON t.id=j.task_id WHERE j.last_error IS NOT NULL ORDER BY 1`)));
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
