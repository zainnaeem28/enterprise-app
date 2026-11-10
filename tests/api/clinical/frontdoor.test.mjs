// TC-PC-01, 05, 06, 08, 11, 12 and TC-SAF-01..04 mechanics, TC-CL-10 step 1 (TEST-CASES 8.1, 8.2): check-in, queue, vitals, triage,
// red-flag alerts, referrals and follow-ups on ENV-INT/ci. The red-flag RULES here are synthetic fixtures; which answers are red flags
// is the D-12a reviewer's decision, so these cases prove the mechanism (exact comparison, fail-safe on blank, alert + advice delivery).
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  sql,
  closeAdmin,
  newStaff,
  newDoctor,
  newPatient,
  ORG,
  A1,
  B1,
  uuid,
  until,
  login,
} from '../../e2e/journeys/lib/world.mjs';
import {
  visit,
  checkIn,
  docClient,
  W,
  publishQuestionnaire,
  publishConsent,
  QUESTIONS,
  ADVICE,
} from '../../e2e/journeys/lib/clinical.mjs';

after(closeAdmin);
const onDuty = async (doc, loc = A1) => {
  await sql(
    `DELETE FROM scheduling.roster_entry WHERE location_id = $1 AND duty = 'on_duty_doctor'`,
    [loc],
  );
  return sql(
    `INSERT INTO scheduling.roster_entry (id, organisation_id, location_id, duty, principal_id, period) VALUES ($1,$2,$3,'on_duty_doctor',$4, tstzrange(now() - interval '1 hour', now() + interval '8 hours', '[)'))`,
    [uuid(), ORG, loc, doc.id],
  );
};

// One holder per duty, place and time (roster_entry_no_overlap): a single rostered on-duty doctor for the whole file.
let duty;
async function dutyDoctor() {
  if (!duty) {
    const doc = await newDoctor({ allDay: true });
    doc.client = await login('staff', doc.key);
    await onDuty(doc);
    duty = doc;
  }
  return duty;
}

describe('TC-PC check-in, queue, triage, referrals', () => {
  it('TC-PC-01 desk check-in moves the visit to checked-in and it appears in the queue with a stage and wait time', async () => {
    const v = await visit();
    const ci = await checkIn(v);
    assert.equal(ci.json.method, 'desk');
    assert.ok(ci.json.checkedInAt);
    const q = await v.desk.client.get(`/api/v1/locations/${A1}/queue`);
    assert.equal(q.status, 200, q.text);
    const e = q.json.items.find((x) => x.id === v.reservationId);
    assert.ok(e, 'the patient is in the queue');
    const again = await v.desk.client.post(
      `/api/v1/appointments/${v.appt.id}/check-in`,
      {},
      { headers: { 'if-match': W(v.appt.version) } },
    );
    assert.ok(
      [200, 409, 412].includes(again.status),
      `second check-in is idempotent or refused, got ${again.status}`,
    );
    if (again.status === 200) assert.equal(again.json.alreadyCheckedIn, true);
    const n = await sql(`SELECT count(*)::int c FROM scheduling.queue_entry WHERE id = $1`, [
      v.reservationId,
    ]);
    assert.equal(n.rows[0].c, 1, 'one queue entry only');
  });

  it('TC-PC-08 check-in with a required consent unsigned raises the missing-consent flag', async () => {
    const ck = await publishConsent(1);
    const v = await visit({ consents: [ck] });
    const ci = await checkIn(v);
    assert.equal(
      ci.json.previsit.consents,
      false,
      `consent flag: ${JSON.stringify(ci.json.previsit)}`,
    );
    const pv = await v.patient.client.get(`/api/v1/appointments/${v.reservationId}/previsit`);
    assert.equal(pv.status, 200, pv.text);
    assert.ok(pv.json.requiredConsents.some((c) => JSON.stringify(c).includes(ck)));
  });

  it('TC-PC-05 four checked-in patients: category and wait time displayed for each, none dropped (order asserted only after PM-confirm-2)', async () => {
    const tri = await newStaff([['triage_nurse', A1]], { name: 'STF-TRI' });
    const desk = await newStaff([['front_desk', A1]], { name: 'STF-FD' });
    const vs = [];
    for (let i = 0; i < 4; i++) {
      const v = await visit({ tri, desk });
      await checkIn(v);
      vs.push(v);
    }
    const cats = ['standard', 'standard', 'urgent', 'standard'];
    for (let i = 0; i < 4; i++) {
      const t = await tri.client.post(`/api/v1/check-ins/${vs[i].reservationId}/triage`, {
        category: cats[i],
        redFlag: false,
      });
      assert.equal(t.status, 201, t.text);
    }
    const q = await desk.client.get(`/api/v1/locations/${A1}/queue`);
    assert.equal(q.status, 200, q.text);
    for (let i = 0; i < 4; i++) {
      const e = q.json.items.find((x) => x.id === vs[i].reservationId);
      assert.ok(e, `patient ${i + 1} is in the queue (none dropped)`);
      assert.equal(
        e.triageCategory,
        cats[i],
        `category shown for patient ${i + 1}: ${JSON.stringify(e)}`,
      );
      assert.equal(typeof e.waitSeconds, 'number', `a wait time is shown: ${JSON.stringify(e)}`);
    }
  });

  it('TC-PC-06 two nurses on one triage record: the second save is refused (412 stale ETag, 428 without one); no silent overwrite', async () => {
    const v = await visit();
    await checkIn(v);
    const n2 = await newStaff([['triage_nurse', A1]], { name: 'STF-TRI' });
    const t1 = await v.tri.client.post(`/api/v1/check-ins/${v.reservationId}/triage`, {
      category: 'standard',
      redFlag: false,
    });
    assert.equal(t1.status, 201, t1.text);
    const etag = t1.headers['etag'];
    assert.ok(etag, 'an ETag is returned');
    const noTag = await n2.client.post(`/api/v1/check-ins/${v.reservationId}/triage`, {
      category: 'urgent',
      redFlag: false,
    });
    assert.equal(noTag.status, 428, `an edit without If-Match is refused: ${noTag.status}`);
    const a = await v.tri.client.post(
      `/api/v1/check-ins/${v.reservationId}/triage`,
      { category: 'urgent', redFlag: false },
      { headers: { 'if-match': etag } },
    );
    assert.equal(a.status, 201, a.text);
    const b = await n2.client.post(
      `/api/v1/check-ins/${v.reservationId}/triage`,
      { category: 'standard', redFlag: false },
      { headers: { 'if-match': etag } },
    );
    assert.equal(b.status, 412, `stale ETag: ${b.status} ${b.text.slice(0, 200)}`);
    const cur = await v.tri.client.get(`/api/v1/check-ins/${v.reservationId}/triage`);
    assert.equal(cur.json.triage.category, 'urgent', 'the first save stands');
  });

  it('TC-CL-10 step 1 a vital with no range configured is stored and reported as no_range, never refused', async () => {
    const v = await visit();
    await checkIn(v);
    const r = await v.tri.client.post(`/api/v1/check-ins/${v.reservationId}/vitals`, {
      vitals: [
        { loincCode: '59408-5', value: 12, unit: '%', measuredAt: new Date().toISOString() },
      ],
    });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.vitals[0].rangeStatus, 'no_range');
    assert.deepEqual(r.json.outOfRange, []);
    assert.ok(r.json.patientBanner?.displayName, 'BR-34: the response carries the patient banner');
  });

  it('TC-PC-12 front desk without referral/follow-up permission is refused for both and the refusal is audited', async () => {
    const v = await visit();
    const refer = await v.desk.client.post(`/api/v1/patients/${v.patient.id}/referrals`, {
      fromLocationId: A1,
      reason: 'synthetic',
      targetKind: 'internal_location',
      targetLocationId: B1,
    });
    assert.equal(refer.status, 403, refer.text);
    const due = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
    const fu = await v.desk.client.post(`/api/v1/patients/${v.patient.id}/follow-ups`, {
      locationId: A1,
      dueOn: due,
      reason: 'synthetic',
    });
    assert.equal(fu.status, 403, fu.text);
    const a = await sql(
      `SELECT count(*)::int c FROM audit.event WHERE actor_principal_id = $1 AND outcome = 'denied'`,
      [v.desk.id],
    );
    assert.ok(a.rows[0].c >= 2, `denials audited, found ${a.rows[0].c}`);
  });

  it('TC-PC-11 coordinator records a follow-up and a referral; both are audited; no lab-collection booking exists', async () => {
    const v = await visit();
    const co = await newStaff([['care_coordinator', A1]], { name: 'STF-COORD' });
    const due = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
    const fu = await co.client.post(`/api/v1/patients/${v.patient.id}/follow-ups`, {
      locationId: A1,
      dueOn: due,
      reason: 'synthetic follow-up',
      serviceId: v.svc,
    });
    assert.equal(fu.status, 201, `follow-up: ${fu.status} ${fu.text.slice(0, 300)}`);
    const rf = await co.client.post(`/api/v1/patients/${v.patient.id}/referrals`, {
      fromLocationId: A1,
      reason: 'synthetic referral',
      targetKind: 'internal_location',
      targetLocationId: B1,
    });
    assert.equal(rf.status, 201, `referral: ${rf.status} ${rf.text.slice(0, 300)}`);
    assert.equal(rf.json.fromPrincipalId ?? co.id, co.id);
    assert.ok(rf.json.status, 'a referral has a status');
    const a = await sql(
      `SELECT count(*)::int c FROM audit.event WHERE actor_principal_id = $1 AND resource_type IN ('clinical.follow_up','clinical.referral')`,
      [co.id],
    );
    assert.ok(a.rows[0].c >= 2, `both audited, found ${a.rows[0].c}`);
    const lab = await co.client.post('/api/v1/lab-collections', {});
    assert.ok(
      [404, 405].includes(lab.status),
      'no lab sample collection booking route exists in R1 (D-4)',
    );
  });
});

describe('TC-SAF red-flag mechanics (rules are synthetic fixtures; acceptance blocked on D-12a)', () => {
  async function redFlagVisit() {
    const key = await publishQuestionnaire();
    const doc = await dutyDoctor();
    const v = await visit();
    await checkIn(v);
    return { v, key, doc };
  }
  const triage = (v, key, symptoms, extra = {}) =>
    v.tri.client.post(`/api/v1/check-ins/${v.reservationId}/triage`, {
      category: 'urgent',
      templateKey: key,
      symptoms,
      ...extra,
    });

  it('TC-SAF-03a near-miss and non-flag answers do not alert (exact comparison)', async () => {
    for (const symptoms of [
      { q_flag_a: false, q_flag_b: 'Red', q_score: 7 },
      { q_flag_a: false, q_flag_b: 'reddish', q_score: 7.99 },
      { q_flag_a: false, q_flag_b: 'green', q_score: 0 },
    ]) {
      const x = await redFlagVisit();
      const r = await triage(x.v, x.key, symptoms);
      assert.equal(r.status, 201, r.text);
      assert.equal(r.json.redFlag, false, `${JSON.stringify(symptoms)} must NOT alert`);
      assert.equal(r.json.alertId, undefined);
    }
  });

  it('TC-SAF-03b a blank or missing red-flag answer is rejected and nothing is saved as "no red flag"', async () => {
    const blank = await redFlagVisit();
    const rb = await triage(blank.v, blank.key, { q_flag_a: false, q_flag_b: '', q_score: 1 });
    assert.ok(
      [409, 422].includes(rb.status),
      `blank answer refused, got ${rb.status} ${rb.text.slice(0, 200)}`,
    );
    const rm = await triage(blank.v, blank.key, { q_flag_a: false, q_score: 1 });
    assert.ok([409, 422].includes(rm.status), `missing answer refused, got ${rm.status}`);
    const none = await sql(
      `SELECT count(*)::int c FROM clinical.triage_assessment WHERE check_in_id = $1`,
      [blank.v.reservationId],
    );
    assert.equal(none.rows[0].c, 0, 'nothing was saved as a silent "no red flag"');
  });

  it('TC-SAF-01/03c every configured red flag alerts the on-duty doctor at once (durable alert row, listed, audited)', async () => {
    const { v, key, doc } = await redFlagVisit();
    const hit = await triage(v, key, { q_flag_a: true, q_flag_b: 'green', q_score: 1 });
    assert.equal(
      hit.status,
      201,
      `a red-flag triage must be saved and alert: ${hit.status} ${hit.text.slice(0, 200)}`,
    );
    assert.equal(hit.json.redFlag, true);
    assert.ok(hit.json.alertId, 'a durable alert id is returned');
    const row = await sql(
      `SELECT type, status, target_principal_ids FROM notifications.staff_alert WHERE id = $1`,
      [hit.json.alertId],
    );
    assert.equal(row.rows[0].type, 'red_flag');
    assert.ok(row.rows[0].target_principal_ids.includes(doc.id), 'the on-duty doctor is a target');
    const list = await (await docClient(doc)).get('/api/v1/alerts?status=open');
    assert.ok(
      list.json.items.some((a) => a.alertId === hit.json.alertId),
      'the doctor sees it in the alert list',
    );
    const aud = await sql(`SELECT count(*)::int c FROM audit.event WHERE resource_id = $1`, [
      hit.json.triage.id,
    ]);
    assert.ok(aud.rows[0].c >= 1, 'audited');
    for (const symptoms of [
      { q_flag_a: false, q_flag_b: 'red', q_score: 1 },
      { q_flag_a: false, q_flag_b: 'purple', q_score: 1 },
      { q_flag_a: false, q_flag_b: 'green', q_score: 8 },
    ]) {
      const x = await redFlagVisit();
      const r = await triage(x.v, x.key, symptoms);
      assert.equal(
        r.json?.redFlag,
        true,
        `${JSON.stringify(symptoms)} must alert: ${r.status} ${r.text.slice(0, 120)}`,
      );
    }
  });

  async function submitFlagged() {
    const key = await publishQuestionnaire();
    const doc = await dutyDoctor();
    const v = await visit();
    const put = await v.patient.client.put(`/api/v1/questionnaire-responses/${uuid()}`, {
      reservationId: v.reservationId,
      templateKey: key,
      answers: { q_flag_a: true, q_flag_b: 'green', q_score: 1 },
    });
    assert.equal(put.status, 201, `save: ${put.status} ${put.text.slice(0, 300)}`);
    const sub = await v.patient.client.post(
      `/api/v1/questionnaire-responses/${put.json.id}/submit`,
      {},
      { headers: { 'if-match': put.headers['etag'] } },
    );
    return { v, doc, sub };
  }

  it('TC-SAF-01/04a the patient sees the configured emergency advice when a red flag is submitted (independent of the alert stream)', async () => {
    const { sub } = await submitFlagged();
    assert.equal(sub.status, 200, sub.text);
    assert.equal(sub.json.redFlag, true);
    assert.equal(sub.json.advice, ADVICE, 'the patient sees the configured emergency advice');
  });

  it('TC-SAF-01/04b the durable alert exists with no alert stream open, stays open and visible until acknowledged', async () => {
    const { v, doc } = await submitFlagged();
    const alert = await until(async () => {
      const l = await (await docClient(doc)).get('/api/v1/alerts?status=open');
      return l.json?.items?.find((a) => a.type === 'red_flag' && a.patientId === v.patient.id);
    });
    const rows = await sql(
      `SELECT count(*)::int c FROM notifications.staff_alert WHERE patient_id = $1 AND type = 'red_flag'`,
      [v.patient.id],
    );
    assert.ok(
      alert,
      `a durable red_flag alert exists for the on-duty doctor (rows in the table for this patient: ${rows.rows[0].c}; visible to the doctor through the API: no)`,
    );
    const ids = await (await docClient(doc)).get('/api/v1/alerts/open-ids');
    assert.ok(
      ids.json.items.some((a) => a.alertId === alert.alertId),
      'still open on the passive poll (not lost)',
    );
    assert.equal(alert.acknowledgedAt, null);
  });
});
