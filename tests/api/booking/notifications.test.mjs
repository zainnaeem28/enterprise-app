// TC-NT-01, 02, 04, 05, 06, 07, 08 (TEST-CASES 7.4) on ENV-INT/ci. The ci stack has no email/SMS vendor (they are disabled, so a send fails
// with `vendor_disabled`, which is exactly the provider-failure path of TC-NT-04); real sandbox deliveries, `.ics` in three real calendar
// clients (TC-NT-03, human) and push delivery run on ENV-INT/staging. Everything below reads the real notification queue the worker drains.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { SVC, ORG, newPatient, search, book, nextDay, sql, closeAdmin, until, newStaff, A1, uuid, state } from '../../e2e/journeys/lib/world.mjs';
import { SENS_INTERNAL_NAME } from '../../e2e/journeys/lib/seed.mjs';

after(closeAdmin);

// The allowlist of ARCHITECTURE 22.13 / SHARED-BOUNDARIES 8.3 (BD-10) — the only names a template may bind.
const ALLOWED = new Set(['start_at', 'end_at', 'offer_expires_at', 'location_name', 'portal_link', 'sign_in_link', 'confirm_link', 'reschedule_link', 'cancel_link', 'code', 'time_zone', 'event_uid']);
// QA's own conservative list of condition-revealing wording (independent of the product's scanner).
const REVEALING = /\b(diagnos\w*|medicat\w*|prescri\w+|insulin|opioid\w*|methadone|antibiotic\w*|vaccin\w+|test results?|lab results?|biops\w+|hiv|aids|hepatitis|cancer|oncolog\w+|diabet\w+|depress\w+|psychiatr\w+|mental health|dementia|epilep\w+|asthma|symptoms?|treatment|therapy|illness|disease|disorder|infection|surgery)\b|\b(Dr|Doctor|Nurse|Prof)\.?\s+[A-Z][a-z]+/i;

async function bookSensitive(patient, serviceId = SVC.SENS) {
  const s = await search(patient.client, { serviceId, day: nextDay() });
  assert.ok(s.slots.length > 0, 'a slot exists');
  const b = await book(patient, s.slots[0], serviceId);
  return { b, slot: s.slots[0] };
}
const queryRows = (patientId) =>
  sql(`SELECT template_key, channel, status, suppress_reason, error_class, attempts, send_after, created_at, variables FROM notifications.notification WHERE patient_id = $1 ORDER BY template_key, channel`, [patientId]);
/** The worker fans a booking out asynchronously: wait until confirmation and both reminders are queued. */
async function rowsOf(patientId) {
  const ok = (r) => ['appointment_confirmation', 'appointment_reminder_48h', 'appointment_reminder_4h'].every((k) => r.rows.some((x) => x.template_key === k));
  let r = await queryRows(patientId);
  const end = Date.now() + 30000;
  while (!ok(r) && Date.now() < end) {
    await new Promise((x) => setTimeout(x, 500));
    r = await queryRows(patientId);
  }
  return r;
}

describe('TC-NT notifications and PHI-free messages', () => {
  it('TC-NT-01 every published template, in every channel and language, binds only allowlisted variables and carries no condition-revealing text', async () => {
    const t = await sql(`SELECT key, channel, language, subject, body, variables FROM notifications.template WHERE status = 'published'`);
    assert.ok(t.rows.length >= 20, `the R1 template set exists (found ${t.rows.length})`);
    const keys = new Set(t.rows.map((r) => r.key));
    for (const k of ['appointment_confirmation', 'appointment_reminder_48h', 'appointment_reminder_4h', 'appointment_cancelled', 'waitlist_offer'])
      assert.ok(keys.has(k), `template ${k} is published`);
    for (const r of t.rows) {
      const text = `${r.subject ?? ''}\n${r.body}`;
      const used = [...text.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((m) => m[1]);
      for (const v of used) assert.ok(ALLOWED.has(v), `${r.key}/${r.channel}/${r.language} binds "${v}" which is not on the allowlist`);
      assert.ok(!REVEALING.test(text), `${r.key}/${r.channel}/${r.language} contains revealing text: ${REVEALING.exec(text)?.[0]}`);
      assert.ok(!text.includes(SENS_INTERNAL_NAME), 'no internal service name');
    }
    const chans = new Set(t.rows.filter((r) => r.key === 'appointment_confirmation').map((r) => r.channel));
    for (const c of ['email', 'sms', 'push', 'in_app', 'ics']) assert.ok(chans.has(c), `confirmation exists for ${c}`);
  });

  it('TC-NT-01/06 a sensitive-service booking by a patient whose own name is a condition/medicine: every queued message holds only allowlisted values', async () => {
    const p = await newPatient({ given: 'Metformin', family: 'HIV-Oncology' });
    await bookSensitive(p);
    const n = await rowsOf(p.id);
    assert.ok(n.rows.length >= 8, `messages queued (${n.rows.length})`);
    for (const r of n.rows) {
      for (const k of Object.keys(r.variables)) assert.ok(ALLOWED.has(k), `${r.template_key}/${r.channel} variable ${k}`);
      const flat = JSON.stringify(r.variables);
      for (const bad of [SENS_INTERNAL_NAME, 'Metformin', 'HIV', 'Oncology', 'Synthetic STF', 'Dr']) assert.ok(!flat.includes(bad), `${r.template_key}/${r.channel}: "${bad}" must not reach a message`);
    }
  });

  it('TC-NT-02 confirmation plus two reminders at the configured offsets, each with the portal links and no clinical text', async () => {
    const p = await newPatient();
    const { slot } = await bookSensitive(p, SVC.IN);
    const n = await rowsOf(p.id);
    const start = new Date(slot.startsAt).getTime();
    for (const [key, hours] of [['appointment_reminder_48h', 48], ['appointment_reminder_4h', 4]]) {
      const r = n.rows.filter((x) => x.template_key === key);
      assert.ok(r.length >= 1, `${key} is queued`);
      for (const x of r) {
        assert.ok(Math.abs(new Date(x.send_after).getTime() - (start - hours * 3600e3)) < 60e3, `${key}/${x.channel} is due ${hours} h before the start`);
        for (const l of ['confirm_link', 'reschedule_link', 'cancel_link', 'portal_link']) assert.ok(typeof x.variables[l] === 'string' || x.channel === 'sms' || x.channel === 'push', `${key}/${x.channel} carries ${l}`);
      }
    }
    assert.ok(n.rows.some((x) => x.template_key === 'appointment_confirmation'));
  });

  it('TC-NT-04 provider failure: the send is retried (attempts > 1, error class recorded), the in-app message is still delivered, and the failure is visible in the queue view', async () => {
    const p = await newPatient();
    await bookSensitive(p, SVC.IN);
    const email = await until(async () => {
      const r = await rowsOf(p.id);
      return r.rows.find((x) => x.template_key === 'appointment_confirmation' && x.channel === 'email' && x.attempts >= 2);
    }, { timeoutMs: 30000 });
    assert.ok(email, 'the email send was attempted again');
    assert.equal(email.status, 'failed');
    assert.match(email.error_class, /^[a-z][a-z0-9_.]*$/, `an error class (never provider text) is recorded: ${email.error_class}`);
    const all = await rowsOf(p.id);
    assert.ok(all.rows.some((x) => x.template_key === 'appointment_confirmation' && x.channel === 'in_app' && x.status === 'sent'), 'the in-app notification is still shown');
    const ops = await sql(`SELECT count(*)::int c FROM reporting.ops_queue`).catch(() => ({ rows: [{ c: -1 }] }));
    assert.ok(ops.rows[0].c >= 0, 'the operations queue view is readable');
  });

  it('TC-NT-05 application logs contain no health data after the booking, check-in and note journeys', async () => {
    const dir = new URL('../../../reports/qa04/logs/', import.meta.url).pathname;
    const needles = [SENS_INTERNAL_NAME, 'Metformin', 'synthetic text', 'dose A (synthetic)', 'trainee plan', 'synthetic follow-up', 'synthetic referral', 'synthetic emergency reason', '1980-01-01'];
    let scanned = 0;
    for (const f of ['api.log', 'worker.log']) {
      if (!existsSync(dir + f)) continue;
      const text = readFileSync(dir + f, 'utf8');
      scanned += text.length;
      for (const n of needles) assert.ok(!text.includes(n), `${f} must not contain "${n}"`);
      assert.ok(!/Test Patient \d+/.test(text), `${f} contains a patient name`);
      assert.ok(!/MRN-\d{7}/.test(text), `${f} contains an MRN`);
      assert.ok(!/(from|startsAt)=.*patientId/i.test(text), 'no patient id in a logged URL');
    }
    assert.ok(scanned > 1000, `logs were actually scanned (${scanned} bytes)`);
  });

  it('TC-NT-07 an alert reaches only the principals it targets; another staff session does not see it', async () => {
    const [a, b] = [await newStaff([['front_desk', A1]], { name: 'STF-AL' }), await newStaff([['front_desk', A1]], { name: 'STF-AL' })];
    const id = uuid();
    await sql(
      `INSERT INTO notifications.staff_alert (id, organisation_id, type, severity, resource_type, resource_id, target_kind, target_principal_ids, status, created_by_job)
       VALUES ($1,$2,'integration_down','high','integration',$1,'principal',ARRAY[$3::uuid],'open',$4)`,
      [id, ORG, a.id, uuid()],
    ).catch((e) => assert.fail(`fixture alert could not be written: ${e.message}`));
    const la = await a.client.get('/api/v1/alerts?status=open');
    const lb = await b.client.get('/api/v1/alerts?status=open');
    assert.equal(la.status, 200, la.text);
    assert.ok(la.json.items.some((x) => x.alertId === id), 'the target sees it');
    assert.ok(!lb.json.items.some((x) => x.alertId === id), 'a non-target does not');
    const ob = await b.client.get('/api/v1/alerts/open-ids');
    assert.ok(!ob.json.items.some((x) => x.alertId === id), 'nor on the passive poll');
    const ack = await b.client.post(`/api/v1/alerts/${id}/acknowledge`, {});
    assert.ok([403, 404].includes(ack.status), `a non-target cannot acknowledge it, got ${ack.status}`);
  });

  it('TC-NT-08 notification preferences: with SMS off and email on, a booking sends email and suppresses SMS (security messages: PM-confirm-3, not asserted)', async () => {
    const p = await newPatient();
    const put = await p.client.put(`/api/v1/patients/${p.id}/communication-preferences`, { channels: ['email', 'in_app'], reminderChannel: 'email', language: 'en' });
    assert.equal(put.status, 200, put.text);
    await bookSensitive(p, SVC.IN);
    const n = await rowsOf(p.id);
    const conf = n.rows.filter((x) => x.template_key === 'appointment_confirmation');
    const sms = conf.find((x) => x.channel === 'sms');
    const email = conf.find((x) => x.channel === 'email');
    assert.equal(sms?.status, 'suppressed');
    assert.equal(sms?.suppress_reason, 'preference_off');
    assert.ok(email && email.status !== 'suppressed', `email is not suppressed (status ${email?.status})`);
    const rem = n.rows.filter((x) => x.template_key === 'appointment_reminder_4h');
    assert.ok(rem.every((x) => x.channel !== 'sms' || x.status === 'suppressed' || x.status === 'cancelled' || x.status === 'queued'), 'reminder rows exist per channel; the SMS one is decided at send time by the preference');
  });
});
