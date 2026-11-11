// HEAAA-805: the cases unblocked by owner ruling 2026-11-11 (C): TC-PR-03, TC-AU-09, TC-DOC-07, TC-PP-03/04/05 (RA-R1-20b),
// TC-TH-06..08. ENV-INT/ci against the REAL built API and worker processes and a throwaway PostgreSQL 17 (same stack as QA-05).
// Every value comes from the ruling (HEAAA-33 comment 56261f7e-58eb-4b31-a1d3-81c5fc2240cb): conservative product defaults, NOT legal or
// clinical advice; items marked dagger need counsel before go-live. Real state values and the dagger confirmations stay on GO-LIVE.
//
// What this file does NOT prove (each is asserted in the evidence README as "not run", never as a pass):
//   * the e-mail provider is not configured in ci (C-10/C-11): the worker's mail and statement ports REFUSE. So the mailed invitation code,
//     the 30-day age-out notice mail and the deletion statement e-mail are not sent here. Where a case needs the code, the test writes the
//     salted hash of a code it chose (the fixture the real worker job would have written) and says so; the mail itself is "not run".
//   * the audit-trail archive (Object Lock bucket, DO-09b) is infrastructure that does not exist in ci.
//   * the clock is the database clock: "older than the retention value" is produced by writing the date columns the job reads.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  newPatient,
  newDoctor,
  newStaff,
  search,
  hold,
  book,
  soon,
  sql,
  sqlTx,
  SVC,
  A1,
  ORG,
  login,
  closeAdmin,
  until,
  fixtureDocument,
  uuid,
} from './lib/world.mjs';
import { adminClient, elevate } from './lib/admin.mjs';

after(() => closeAdmin());

const root = new URL('../../../', import.meta.url).pathname;
// Fixture states: three synthetic two-letter codes that are not USPS states (apps/api/src/platform/fixture-states.ts defaults).
const ST = { licensed: 'ZA', unlicensed: 'ZB', closed: 'ZC' };

const clients = {};
async function adm(key) {
  if (!clients[key]) {
    clients[key] = await adminClient(key);
    const e = await elevate(clients[key]);
    assert.equal(e.status, 200, `elevation ${key} ${e.status}`);
  }
  return clients[key];
}
const ymd = (d) => d.toISOString().slice(0, 10);
const yearsFromToday = (y) => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear() + y, d.getUTCMonth(), d.getUTCDate()));
};
const addDays = (d, n) => new Date(d.getTime() + n * 86400e3);
/** Enqueues a worker job through the queue library the way a cron tick would (the cron for these jobs fires once a day). */
const enqueue = (name, payload = {}) =>
  sql(`SELECT count(*)::int AS n FROM queue.add_job($1::text, $2::json)`, [
    name,
    JSON.stringify(payload),
  ]);

// ================================================================================================================================
// TC-PR-03  account deletion (ruling C item 1)
// ================================================================================================================================
async function seedMedicalRecord(p, { endedYearsAgo = 1 } = {}) {
  const doc = principalOfDesk();
  const enc = uuid();
  // Seeded below the triggers (the clinical module's own tests prove its state machine); same approach as the module's dbtests.
  await belowTriggers(async (c) => {
    await c.query(
      `INSERT INTO clinical.encounter (id, organisation_id, patient_id, location_id, clinician_principal_id, mode, status, started_at, ended_at, created_by)
       VALUES ($1,$2,$3,$4,$5,'in_person','completed', now() - make_interval(years => $6) - interval '1 hour', now() - make_interval(years => $6), $5)`,
      [enc, ORG, p.id, A1, doc, endedYearsAgo],
    );
    await c.query(
      `INSERT INTO clinical.allergy (id, organisation_id, patient_id, display, coded, category, recorded_by) VALUES ($1,$2,$3,'synthetic allergy',false,'food',$4)`,
      [uuid(), ORG, p.id, doc],
    );
  });
  return enc;
}
const belowTriggers = (fn) =>
  sqlTx(async (c) => {
    await c.query(`SET LOCAL session_replication_role = replica`);
    await c.query(`SET LOCAL transaction_timeout = '30s'`);
    return fn(c);
  });
let deskPrincipal;
function principalOfDesk() {
  return deskPrincipal;
}
async function initDesk() {
  const r = await sql(`SELECT id FROM identity.principal WHERE subject = 'sub-STF-DR-A1'`);
  deskPrincipal = r.rows[0].id;
}

describe('TC-PR-03 deletion semantics (ruling C item 1; counsel confirmation pending)', () => {
  test('request -> identity check -> approval: account deactivated at once, data outside the medical record deleted, record and audit kept, legal hold untouched, statement stored', async () => {
    await initDesk();
    const cmp = await adm('CMP-1');
    const p = await newPatient();
    const control = await newPatient();
    for (const x of [p, control]) {
      const put = await x.client.put(`/api/v1/patients/${x.id}/communication-preferences`, {
        channels: ['email'],
        reminderChannel: 'email',
        language: 'en',
      });
      assert.equal(put.status, 200, `preferences ${put.status}`);
    }
    const enc = await seedMedicalRecord(p);
    await seedMedicalRecord(control);
    const accepted = await fixtureDocument({ patientId: p.id, retentionUntil: '2036-01-01' });
    const heldAccepted = await fixtureDocument({ patientId: p.id, retentionUntil: '2000-01-01' });
    const upload = await fixtureDocument({ patientId: p.id, status: 'awaiting_upload' });
    const mro = await newStaff([['medical_records', A1]], { name: 'STF-MRO' });
    const hl = await mro.client.post(`/api/v1/documents/${heldAccepted}/legal-holds`, {
      action: 'placed',
      reason: 'QA TC-PR-03 hold on the old accepted document',
    });
    assert.equal(hl.status, 201, `hold ${hl.status}`);

    // 1. the patient requests deletion: recorded (state received), nothing deleted yet
    const r = await p.client.post('/api/v1/privacy-requests', { kind: 'deletion' });
    assert.equal(r.status, 201, `create ${r.status} ${r.text.slice(0, 200)}`);
    assert.equal(
      r.json.status,
      'received',
      'a deletion request is a normal request now (D-8 decided)',
    );
    const before = await sql(
      `SELECT count(*)::int AS n FROM patient.communication_preference WHERE patient_id = $1`,
      [p.id],
    );
    assert.equal(before.rows[0].n, 1);
    const seen = await cmp.get('/api/v1/admin/privacy-requests?status=received');
    assert.ok(
      seen.json.items.some((x) => x.id === r.json.id),
      'compliance sees the request',
    );
    // the legal-hold check is a system job: it records the count on the request
    assert.ok(
      await until(async () => {
        const q = await sql(`SELECT legal_hold_documents AS n FROM privacy.request WHERE id = $1`, [
          r.json.id,
        ]);
        return q.rows[0].n !== null && Number(q.rows[0].n) === 1;
      }),
      'the legal-hold check ran and counted the 1 held document',
    );

    // 2. approval is refused before the identity check
    const early = await cmp.post(`/api/v1/admin/privacy-requests/${r.json.id}/decide`, {
      decision: 'approve',
    });
    assert.ok(early.status >= 400, `approve before identity check refused (${early.status})`);
    const v = await cmp.post(`/api/v1/admin/privacy-requests/${r.json.id}/verify-identity`, {
      method: 'known_contact_callback',
    });
    assert.equal(v.status, 200, `verify ${v.status} ${v.text.slice(0, 200)}`);
    const d = await cmp.post(`/api/v1/admin/privacy-requests/${r.json.id}/decide`, {
      decision: 'approve',
    });
    assert.equal(d.status, 200, `approve ${d.status} ${d.text.slice(0, 200)}`);

    // 3. the real worker executes the deletion
    assert.ok(
      await until(
        async () =>
          (await sql(`SELECT status FROM privacy.request WHERE id = $1`, [r.json.id])).rows[0]
            .status === 'fulfilled',
        { timeoutMs: 60000 },
      ),
      'the worker completed the deletion request',
    );
    // (a) deactivated at once; the old cookie is refused; sign-in again is refused
    const pr = await sql(`SELECT status, disabled_reason FROM identity.principal WHERE id = $1`, [
      p.client.session.principalId,
    ]);
    assert.equal(pr.rows[0].status, 'disabled');
    assert.equal(pr.rows[0].disabled_reason, 'account_deleted');
    const old = await p.client.get('/api/v1/privacy-requests');
    assert.equal(old.status, 401, 'the old session is refused');
    const again = await login('patient', p.key);
    assert.notEqual(again.sessionStatus, 200, 'the deactivated account cannot sign in again');
    const ctl = await control.client.get('/api/v1/privacy-requests');
    assert.equal(ctl.status, 200, 'another patient is untouched');
    // (b) deleted: preferences, unaccepted upload; the control patient keeps hers
    const prefs = await sql(
      `SELECT patient_id FROM patient.communication_preference WHERE patient_id = ANY($1)`,
      [[p.id, control.id]],
    );
    assert.deepEqual(
      prefs.rows.map((x) => x.patient_id),
      [control.id],
      'only the control patient still has preferences',
    );
    const st = (id) =>
      sql(`SELECT status FROM documents.document WHERE id = $1`, [id]).then(
        (x) => x.rows[0].status,
      );
    assert.equal(await st(upload), 'deleted', 'an upload never accepted is deleted');
    // (c) kept: the medical record, the accepted documents, the audit trail
    const kept = await sql(
      `SELECT (SELECT count(*) FROM clinical.encounter WHERE id = $1)::int AS enc,
              (SELECT count(*) FROM clinical.allergy WHERE patient_id = $2)::int AS allergy,
              (SELECT count(*) FROM audit.event WHERE patient_id = $2)::int AS audit`,
      [enc, p.id],
    );
    assert.deepEqual(
      [kept.rows[0].enc, kept.rows[0].allergy],
      [1, 1],
      'encounter and allergy are kept',
    );
    assert.ok(kept.rows[0].audit > 0, 'the audit trail is kept');
    assert.equal(
      await st(accepted),
      'confirmed',
      'an accepted document is part of the record: kept',
    );
    assert.equal(
      await st(heldAccepted),
      'confirmed',
      'a document under legal hold is never deleted',
    );
    // the record and the statement
    const rec = await sql(`SELECT * FROM privacy.deletion_record WHERE request_id = $1`, [
      r.json.id,
    ]);
    assert.equal(rec.rows.length, 1);
    const row = rec.rows[0];
    assert.equal(Number(row.held_documents), 1);
    assert.equal(Number(row.principals_disabled), 1);
    assert.equal(row.purge_state, 'pending');
    assert.ok(row.deleted_counts.notification_preferences >= 1);
    assert.equal(row.statement.keptReason, 'medical_record_retention');
    assert.deepEqual(row.statement.legalHold, { documents: 1 });
    // retention end = last encounter (1 year ago) + 10 years (ruling value)
    const exp = ymd(addDays(yearsFromToday(9), 0));
    assert.ok(
      Math.abs(new Date(row.statement.keptUntil) - new Date(exp)) <= 3 * 86400e3,
      `kept until about ${exp}, got ${row.statement.keptUntil}`,
    );
    assert.doesNotMatch(
      JSON.stringify(row.statement),
      new RegExp(p.id),
      'no patient id in the statement',
    );
    assert.doesNotMatch(
      JSON.stringify(row.statement),
      /Test Patient|1980-01-01/,
      'no PHI in the statement',
    );
    // compliance sees the result, with counts only
    const done = await cmp.get('/api/v1/admin/privacy-requests?status=fulfilled');
    const item = done.json.items.find((x) => x.id === r.json.id);
    assert.ok(item?.deletion, 'compliance sees the deletion result on the request');
    assert.equal(item.deletion.heldDocuments, 1);
    // audited, no PHI
    const ev = await sql(
      `SELECT action, resource_type, change::text AS change FROM audit.event WHERE patient_id = $1 AND resource_type IN ('privacy.deletion_record','privacy.request')`,
      [p.id],
    );
    assert.ok(
      ev.rows.some(
        (e) => e.resource_type === 'privacy.deletion_record' && /account_deletion/.test(e.change),
      ),
      'the deletion is audited',
    );
    // the statement EMAIL itself: the sender port refuses in ci (C-11); the job retries until a provider exists. Recorded, not a pass.
    assert.equal(
      row.statement_sent_at,
      null,
      'LIMITATION: statement e-mail not sent (no provider in ci); the stored statement is what was verified',
    );
  });

  test('a refusal (with a reason) deletes nothing; a held request cannot be approved before identity is verified', async () => {
    const cmp = await adm('CMP-1');
    const p = await newPatient();
    await seedMedicalRecord(p);
    const r = await p.client.post('/api/v1/privacy-requests', { kind: 'deletion' });
    assert.equal(r.status, 201);
    const noReason = await cmp.post(`/api/v1/admin/privacy-requests/${r.json.id}/decide`, {
      decision: 'refuse',
    });
    assert.ok(noReason.status >= 400, 'a refusal needs a reason');
    const v = await cmp.post(`/api/v1/admin/privacy-requests/${r.json.id}/verify-identity`, {
      method: 'known_contact_callback',
    });
    assert.equal(v.status, 200);
    const ref = await cmp.post(`/api/v1/admin/privacy-requests/${r.json.id}/decide`, {
      decision: 'refuse',
      reason: 'QA TC-PR-03: refused by the compliance officer',
    });
    assert.equal(ref.status, 200, `refuse ${ref.status} ${ref.text.slice(0, 200)}`);
    const q = await sql(
      `SELECT (SELECT status FROM identity.principal WHERE id = $2) AS pstatus,
              (SELECT count(*) FROM privacy.deletion_record WHERE request_id = $1)::int AS recs,
              (SELECT count(*) FROM clinical.encounter WHERE patient_id = $3)::int AS enc`,
      [r.json.id, p.client.session.principalId, p.id],
    );
    assert.deepEqual(
      [q.rows[0].pstatus, q.rows[0].recs, q.rows[0].enc],
      ['active', 0, 1],
      'refused: nothing deleted, account active',
    );
    assert.equal(
      (await p.client.get('/api/v1/privacy-requests')).status,
      200,
      'the patient still signs in',
    );
  });
});

// ================================================================================================================================
// TC-AU-09  retention configuration and the retention job (ruling C item 2; counsel confirmation pending)
// ================================================================================================================================
describe('TC-AU-09 retention values equal ruling C; the job removes only what is past retention; retrieval is audited', () => {
  test('step 1: the configured retention values equal the ruling', () => {
    // The values the application enforces and DevOps provisions, printed by the product's own CLI from an environment with no overrides.
    const env = { PATH: process.env.PATH };
    const out = JSON.parse(
      execFileSync(
        process.execPath,
        [`${root}apps/api/dist/src/modules/privacy/retention-cli.js`],
        { env },
      ).toString(),
    );
    const v = Object.fromEntries(out.settings.map((s) => [s.key, [s.value, s.unit]]));
    const ruling = {
      EHR_RETENTION_MEDICAL_RECORD_YEARS_AFTER_LAST_ENCOUNTER: [10, 'years'],
      EHR_RETENTION_AGE_OF_MAJORITY_YEARS: [18, 'years'],
      EHR_RETENTION_MINOR_UNTIL_AGE_YEARS: [21, 'years'],
      EHR_RETENTION_MINOR_YEARS_AFTER_LAST_ENCOUNTER: [10, 'years'],
      EHR_RETENTION_AUDIT_TRAIL_YEARS: [7, 'years'],
      EHR_RETENTION_AUDIT_ANCHOR_YEARS: [7, 'years'],
      EHR_RETENTION_HIPAA_DOCUMENTATION_YEARS: [6, 'years'],
      EHR_RETENTION_BACKUP_DAILY_DAYS: [35, 'days'],
      EHR_RETENTION_BACKUP_MONTHLY_MONTHS: [12, 'months'],
      EHR_RETENTION_APPLICATION_LOG_DAYS: [90, 'days'],
      EHR_RETENTION_APPLICATION_LOG_ARCHIVE_YEARS: [1, 'years'],
      EHR_RETENTION_NETWORK_FLOW_LOG_YEARS: [1, 'years'],
      EHR_RETENTION_EXPORT_PACKAGE_DAYS: [7, 'days'],
    };
    for (const [k, want] of Object.entries(ruling)) assert.deepEqual(v[k], want, `${k}`);
    assert.equal(
      Object.keys(v).length,
      Object.keys(ruling).length,
      'no setting outside the ruling',
    );
  });

  test('step 1b: a bad override stops the CLI by key name, never by value', () => {
    let err;
    try {
      execFileSync(
        process.execPath,
        [`${root}apps/api/dist/src/modules/privacy/retention-cli.js`],
        {
          env: { PATH: process.env.PATH, EHR_RETENTION_AUDIT_TRAIL_YEARS: 'seven-secret-value' },
          stdio: 'pipe',
        },
      );
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'a bad value is refused');
    const text = String(err.stderr) + String(err.stdout);
    assert.match(text, /EHR_RETENTION_AUDIT_TRAIL_YEARS/);
    assert.doesNotMatch(text, /seven-secret-value/);
  });

  test('step 2: the daily job purges only a deletion whose retention ended, defers under a legal hold, and never removes audit rows', async () => {
    await initDesk();
    const cmp = await adm('CMP-1');
    const due = await newPatient();
    const notDue = await newPatient();
    const held = await newPatient();
    const reqs = {};
    for (const [name, p] of [
      ['due', due],
      ['notDue', notDue],
      ['held', held],
    ]) {
      await seedMedicalRecord(p, { endedYearsAgo: 11 }); // last encounter 11 years ago: retention (10y) has ended for the due patient
      if (name === 'held') {
        const doc = await fixtureDocument({ patientId: p.id, retentionUntil: '2000-01-01' });
        const mro = await newStaff([['medical_records', A1]], { name: 'STF-MRO' });
        assert.equal(
          (
            await mro.client.post(`/api/v1/documents/${doc}/legal-holds`, {
              action: 'placed',
              reason: 'QA TC-AU-09 hold',
            })
          ).status,
          201,
        );
      }
      const r = await p.client.post('/api/v1/privacy-requests', { kind: 'deletion' });
      assert.equal(r.status, 201);
      assert.equal(
        (
          await cmp.post(`/api/v1/admin/privacy-requests/${r.json.id}/verify-identity`, {
            method: 'known_contact_callback',
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await cmp.post(`/api/v1/admin/privacy-requests/${r.json.id}/decide`, {
            decision: 'approve',
          })
        ).status,
        200,
      );
      reqs[name] = r.json.id;
    }
    for (const id of Object.values(reqs))
      assert.ok(
        await until(
          async () =>
            (await sql(`SELECT status FROM privacy.request WHERE id = $1`, [id])).rows[0].status ===
            'fulfilled',
          { timeoutMs: 60000 },
        ),
        'deletion executed',
      );
    // the retention end the job computed: last encounter 11y ago + 10y = 1 year ago for due/held, but the "notDue" patient gets a future end
    const rec = (id) =>
      sql(
        `SELECT retained_until::text AS d, purge_state FROM privacy.deletion_record WHERE request_id = $1`,
        [id],
      ).then((r) => r.rows[0]);
    for (const k of ['due', 'held']) {
      const r = await rec(reqs[k]);
      assert.ok(new Date(r.d) < new Date(), `${k}: retention already ended (${r.d})`);
    }
    await belowTriggers((c) =>
      c.query(
        `UPDATE privacy.deletion_record SET retained_until = current_date + 365 WHERE request_id = $1`,
        [reqs.notDue],
      ),
    );

    // an 8-year-old audit row (older than the 7-year audit retention): the application never deletes it
    const oldAudit = uuid();
    await belowTriggers((c) =>
      c.query(
        `INSERT INTO audit.event (event_id, organisation_id, occurred_at, realm, audience, action, resource_type, outcome, job_id)
         VALUES ($1,$2, now() - interval '8 years','worker','system','create','synthetic.resource','allowed','synthetic-job')`,
        [oldAudit, ORG],
      ),
    );
    const auditBefore = (
      await sql(
        `SELECT count(*)::int AS n FROM audit.event WHERE occurred_at < now() - interval '7 years'`,
      )
    ).rows[0].n;

    const runsBefore = (await sql(`SELECT count(*)::int AS n FROM privacy.retention_run`)).rows[0]
      .n;
    assert.equal((await enqueue('privacy.retention_purge')).rows[0].n, 1);
    assert.ok(
      await until(
        async () =>
          (await sql(`SELECT count(*)::int AS n FROM privacy.retention_run`)).rows[0].n >
          runsBefore,
        { timeoutMs: 60000 },
      ),
      'the real worker ran the retention job and wrote its report',
    );
    const run = (
      await sql(`SELECT status, report FROM privacy.retention_run ORDER BY started_at DESC LIMIT 1`)
    ).rows[0];
    assert.match(run.status, /completed|partial/);
    assert.equal(run.report.classes.audit_trail.removedByThisJob, 0);
    assert.equal(run.report.classes.audit_trail.reason, 'archive_governed');
    assert.equal(run.report.classes.audit_trail.years, 7);
    assert.equal(run.report.classes.audit_anchors.years, 7);
    assert.doesNotMatch(
      JSON.stringify(run.report),
      new RegExp(due.id),
      'the report holds counts only, no patient id',
    );

    const state = async (p) =>
      (
        await sql(
          `SELECT (SELECT status FROM patient.patient WHERE id = $1) AS pstatus, (SELECT count(*) FROM clinical.encounter WHERE patient_id = $1)::int AS enc`,
          [p.id],
        )
      ).rows[0];
    const sDue = await state(due);
    assert.equal(sDue.enc, 0, 'due: the medical record was purged after retention ended');
    assert.equal(sDue.pstatus, 'purged', 'due: the patient row is a tombstone');
    const sNot = await state(notDue);
    assert.deepEqual(
      [sNot.enc, sNot.pstatus],
      [1, 'active'],
      'not due: the younger record is untouched',
    );
    const sHeld = await state(held);
    assert.deepEqual(
      [sHeld.enc, sHeld.pstatus],
      [1, 'active'],
      'held: a legal hold defers the whole purge',
    );
    assert.equal((await rec(reqs.due)).purge_state, 'purged');
    assert.equal((await rec(reqs.held)).purge_state, 'pending');
    // audit rows are untouched, and the database refuses a delete for the application roles
    const auditAfter = (
      await sql(
        `SELECT count(*)::int AS n FROM audit.event WHERE occurred_at < now() - interval '7 years'`,
      )
    ).rows[0].n;
    assert.ok(
      auditAfter >= auditBefore && auditAfter >= 1,
      'no audit row older than the retention was removed',
    );
    await assert.rejects(
      sqlTx(async (c) => {
        await c.query('SET LOCAL ROLE app_worker');
        await c.query(`DELETE FROM audit.event WHERE event_id = $1`, [oldAudit]);
      }),
      /permission denied|append-only|PS001/i,
    );
    // TC-AU-09 step 2 "archive moves rows": LIMITATION recorded in the evidence README (audit archive bucket is DO-09b, not in ci).
  });

  test('step 3: an old audit row is retrievable by compliance and the retrieval is itself audited', async () => {
    const cmp = await adm('CMP-1');
    const id = uuid();
    const when = new Date(Date.now() - 8 * 365 * 86400e3);
    await belowTriggers((c) =>
      c.query(
        `INSERT INTO audit.event (event_id, organisation_id, occurred_at, realm, audience, action, resource_type, outcome, job_id)
         VALUES ($1,$2,$3,'worker','system','create','synthetic.old_resource','allowed','synthetic-job')`,
        [id, ORG, when.toISOString()],
      ),
    );
    const from = new Date(when.getTime() - 3600e3).toISOString();
    const to = new Date(when.getTime() + 3600e3).toISOString();
    const t0 = new Date().toISOString();
    const s = await cmp.post('/api/v1/admin/audit-events/search', {
      from,
      to,
      resourceType: 'synthetic.old_resource',
    });
    assert.equal(s.status, 200, `search ${s.status} ${s.text.slice(0, 200)}`);
    assert.ok(
      s.json.items.some(
        (x) => (x.eventId ?? x.id) === id || x.resourceType === 'synthetic.old_resource',
      ),
      'the 8-year-old row is retrievable',
    );
    const logged = await until(async () => {
      const q = await sql(
        `SELECT count(*)::int AS n FROM audit.event WHERE occurred_at >= $1 AND realm = 'admin_pool' AND resource_type LIKE 'audit%' AND action IN ('view','search','read','export')`,
        [t0],
      );
      return q.rows[0].n > 0;
    });
    assert.ok(logged, 'the retrieval of the audit trail is itself an audit event');
  });
});

// ================================================================================================================================
// TC-DOC-07  deletion of a document only after the legal period and with no hold (ruling C item 2: record retention 10 years)
// ================================================================================================================================
describe('TC-DOC-07 document retention from the configured value', () => {
  test('a confirmed document gets retention_until = confirmation date + the configured medical-record years (10); deletion follows the dates and the hold', async () => {
    const p = await newPatient();
    const mro = await newStaff([['medical_records', A1]], { name: 'STF-MRO' });
    const fd = await newStaff([['front_desk', A1]], { name: 'STF-FD' });
    // confirmation through the product: the date is computed from the setting, not written by the test
    const clean = await fixtureDocument({ patientId: p.id, status: 'clean' });
    const ver = (
      await sql(`SELECT row_version::text AS v FROM documents.document WHERE id = $1`, [clean])
    ).rows[0].v;
    const c = await mro.client.post(
      `/api/v1/documents/${clean}/confirm`,
      {},
      { headers: { 'if-match': `"${ver}"` } },
    );
    assert.equal(c.status, 200, `confirm ${c.status} ${c.text.slice(0, 200)}`);
    const ret = (
      await sql(`SELECT retention_until::text AS d FROM documents.document WHERE id = $1`, [clean])
    ).rows[0].d;
    assert.equal(
      ret,
      ymd(yearsFromToday(10)),
      'retention_until = today + 10 years (ruling C item 2)',
    );
    const fresh = await fd.client.post(`/api/v1/documents/${clean}/deletion-requests`, {});
    assert.equal(fresh.status, 409);
    assert.equal(
      fresh.json?.code,
      'documents.retention',
      'a document inside the legal period cannot be deleted',
    );

    // D1 older than the period, D2 younger, D3 older with a hold (controllable clock: the date column the rule reads)
    const D1 = await fixtureDocument({
      patientId: p.id,
      retentionUntil: ymd(addDays(new Date(), -1)),
    });
    const D2 = await fixtureDocument({
      patientId: p.id,
      retentionUntil: ymd(addDays(new Date(), 1)),
    });
    const D3 = await fixtureDocument({
      patientId: p.id,
      retentionUntil: ymd(addDays(new Date(), -1)),
    });
    assert.equal(
      (
        await mro.client.post(`/api/v1/documents/${D3}/legal-holds`, {
          action: 'placed',
          reason: 'QA TC-DOC-07 hold',
        })
      ).status,
      201,
    );
    const r2 = await fd.client.post(`/api/v1/documents/${D2}/deletion-requests`, {});
    assert.equal(
      r2.json?.code,
      'documents.retention',
      'D2: the retention period is still open (one day left)',
    );
    const r1 = await fd.client.post(`/api/v1/documents/${D1}/deletion-requests`, {});
    assert.equal(r1.status, 201, `D1 ${r1.status} ${r1.text.slice(0, 200)}`);
    const dec = await mro.client.post(`/api/v1/deletion-requests/${r1.json.id}/decide`, {});
    assert.equal(dec.status, 200);
    assert.equal(dec.json.outcome, 'deleted');
    const r3 = await fd.client.post(`/api/v1/documents/${D3}/deletion-requests`, {});
    assert.equal(r3.json?.code, 'documents.legal_hold', 'D3: the hold wins over an ended period');
    const by = Object.fromEntries(
      (
        await sql(`SELECT id, status FROM documents.document WHERE id = ANY($1)`, [[D1, D2, D3]])
      ).rows.map((x) => [x.id, x.status]),
    );
    assert.deepEqual([by[D1], by[D2], by[D3]], ['deleted', 'confirmed', 'confirmed']);
    // after the hold is released D3 is deletable
    assert.equal(
      (
        await mro.client.post(`/api/v1/documents/${D3}/legal-holds`, {
          action: 'released',
          reason: 'QA TC-DOC-07 release',
        })
      ).status,
      201,
    );
    const r3b = await fd.client.post(`/api/v1/documents/${D3}/deletion-requests`, {});
    assert.equal(r3b.status, 201, `D3 after release ${r3b.status} ${r3b.text.slice(0, 160)}`);
  });
});

// ================================================================================================================================
// TC-PP-03 / TC-PP-04 / TC-PP-05  proxies (ruling C item 3; RA-R1-20a/20b, AC-32)
// ================================================================================================================================
const emailOfKey = (key) => `${key.toLowerCase()}@example.com`;
const sha = (salt, code) => createHash('sha256').update(salt).update(code, 'utf8').digest();
/** Replaces the code hash the worker job wrote with the hash of a code the test chose (the mail provider is not configured in ci). */
async function setKnownCode(grantId, code) {
  // wait for the real worker job to have made its code (it then fails at the refusing mail port and would retry), then take it out of play
  assert.ok(
    await until(
      async () =>
        (await sql(`SELECT 1 FROM identity.proxy_invite_code WHERE grant_id = $1`, [grantId])).rows
          .length === 1,
      { timeoutMs: 40000 },
    ),
    'the real worker job identity.send_proxy_invite ran and stored a code hash',
  );
  await sql(
    `DELETE FROM queue._private_jobs WHERE task_id IN (SELECT id FROM queue._private_tasks WHERE identifier = 'identity.send_proxy_invite') AND payload::text LIKE '%' || $1 || '%'`,
    [grantId],
  );
  const salt = randomBytes(16);
  await sql(
    `UPDATE identity.proxy_invite_code SET salt = $2, code_hash = $3, attempts = 0, expires_at = now() + interval '1 hour' WHERE grant_id = $1`,
    [grantId, salt, sha(salt, code)],
  );
}
const CODE = '48151623';

async function invitedProxy({ owner, proxy, scopes }) {
  const r = await owner.client.post(`/api/v1/patients/${owner.id}/proxy-requests`, {
    email: emailOfKey(proxy.key),
    relationship: 'carer',
    ...(scopes ? { scopes } : {}),
  });
  assert.equal(r.status, 201, `invite ${r.status} ${r.text.slice(0, 200)}`);
  await setKnownCode(r.json.id, CODE);
  return r.json;
}
const accept = (proxy, grantId, code) =>
  proxy.client.post(`/api/v1/proxy-invites/${grantId}/accept`, { code });
const seesAppointments = async (proxy, patientId) =>
  (await proxy.client.get(`/api/v1/patients/${patientId}/appointments`)).status;

describe('TC-PP-03/04/05 proxy link, default scope, per-scope grants, revocation, leave (adult patient)', () => {
  test('TC-PP-04 invite by e-mail: pending until the proxy accepts with the e-mail code; wrong codes are counted; the default scope is appointments only (TC-PP-03)', async () => {
    const owner = await newPatient();
    const proxy = await newPatient();
    const g = await invitedProxy({ owner, proxy });
    assert.equal(g.status, 'invited', 'an invitation is pending, not a link');
    assert.deepEqual(g.scopes, ['appointments'], 'the default scope is appointments only');
    assert.equal(
      await seesAppointments(proxy, owner.id),
      404,
      'before acceptance the proxy sees nothing',
    );
    const bad = await accept(proxy, g.id, '00000000');
    assert.equal(bad.status, 422, `wrong code refused (${bad.status})`);
    const stranger = await newPatient();
    assert.notEqual(
      (await accept(stranger, g.id, CODE)).status,
      200,
      'another account cannot accept the invitation',
    );
    const ok = await accept(proxy, g.id, CODE);
    assert.equal(ok.status, 200, `accept ${ok.status} ${ok.text.slice(0, 200)}`);
    assert.equal(ok.json.status, 'active');
    // TC-PP-03: default view
    assert.equal(await seesAppointments(proxy, owner.id), 200, 'appointments are visible');
    for (const path of [
      'profile',
      'documents',
      'threads',
      'contacts',
      'insurance-coverages',
      'communication-preferences',
    ])
      assert.equal(
        (await proxy.client.get(`/api/v1/patients/${owner.id}/${path}`)).status,
        404,
        `default proxy: ${path} is closed`,
      );
    const audit = await sql(
      `SELECT count(*)::int AS n FROM audit.event WHERE patient_id = $1 AND resource_type = 'identity.proxy_grant'`,
      [owner.id],
    );
    assert.ok(audit.rows[0].n >= 2, 'invitation and acceptance are audited');
    // a minor cannot invite (adult patients invite their own proxies)
    const minor = await newPatient({ dob: ymd(yearsFromToday(-15)) });
    const mi = await minor.client.post(`/api/v1/patients/${minor.id}/proxy-requests`, {
      email: emailOfKey(proxy.key),
      relationship: 'carer',
    });
    assert.ok(mi.status >= 400 && mi.status < 500, `a minor cannot invite a proxy (${mi.status})`);
    const self = await owner.client.post(`/api/v1/patients/${owner.id}/proxy-requests`, {
      email: emailOfKey(owner.key),
      relationship: 'carer',
    });
    assert.ok(
      self.status >= 400 && self.status < 500,
      `inviting yourself is refused (${self.status})`,
    );
  });

  test('TC-PP-05 messages and documents are granted per scope and withdrawn at once; revocation by the patient and leaving are immediate; each change is audited', async () => {
    const owner = await newPatient();
    const proxy = await newPatient();
    const g = await invitedProxy({ owner, proxy });
    assert.equal((await accept(proxy, g.id, CODE)).status, 200);
    const docs = () =>
      proxy.client.get(`/api/v1/patients/${owner.id}/documents`).then((r) => r.status);
    const threads = () =>
      proxy.client.get(`/api/v1/patients/${owner.id}/threads`).then((r) => r.status);
    assert.equal(await docs(), 404);
    const grant = await owner.client.put(`/api/v1/patients/${owner.id}/proxies/${g.id}/scopes`, {
      scopes: ['appointments', 'documents'],
    });
    assert.equal(grant.status, 200, `scopes ${grant.status} ${grant.text.slice(0, 200)}`);
    assert.equal(await docs(), 200, 'documents were granted');
    assert.equal(await threads(), 404, 'messages were not');
    const widen = await proxy.client.put(`/api/v1/patients/${owner.id}/proxies/${g.id}/scopes`, {
      scopes: ['appointments', 'documents', 'messages'],
    });
    assert.notEqual(widen.status, 200, 'a proxy cannot widen its own scopes');
    assert.equal(await threads(), 404);
    await owner.client.put(`/api/v1/patients/${owner.id}/proxies/${g.id}/scopes`, {
      scopes: ['appointments'],
    });
    assert.equal(await docs(), 404, 'withdrawing a scope takes effect on the next request');
    // revocation by the patient: immediate
    assert.equal(await seesAppointments(proxy, owner.id), 200);
    const del = await owner.client.delete(`/api/v1/patients/${owner.id}/proxies/${g.id}`);
    assert.equal(del.status, 204, `revoke ${del.status}`);
    assert.equal(
      await seesAppointments(proxy, owner.id),
      404,
      'revocation is immediate: the very next request has no access',
    );
    assert.equal(
      (await sql(`SELECT status FROM identity.proxy_grant WHERE id = $1`, [g.id])).rows[0].status,
      'revoked',
    );
    // a second proxy leaves by themselves
    const proxy2 = await newPatient();
    const g2 = await invitedProxy({ owner, proxy: proxy2 });
    assert.equal((await accept(proxy2, g2.id, CODE)).status, 200);
    assert.equal(await seesAppointments(proxy2, owner.id), 200);
    const leave = await proxy2.client.post(`/api/v1/proxy-grants/${g2.id}/leave`, {});
    assert.equal(leave.status, 204, `leave ${leave.status}`);
    assert.equal(await seesAppointments(proxy2, owner.id), 404, 'leaving is immediate');
    const aud = await sql(
      `SELECT count(*)::int AS n FROM audit.event WHERE patient_id = $1 AND resource_type = 'identity.proxy_grant'`,
      [owner.id],
    );
    assert.ok(aud.rows[0].n >= 6, `every change is audited (${aud.rows[0].n} events)`);
  });

  test('RA-R1-20b staff link a guardian of a minor after a relationship document; ages 13-17 appointments only; access ends the day before the 18th birthday; staff revoke is immediate', async () => {
    const lead = await newStaff([['front_desk_lead', A1]], { name: 'STF-FDL' });
    const plain = await newStaff([['front_desk', A1]], { name: 'STF-FD' });
    const adult = await newPatient();
    const minor15 = await newPatient({ dob: ymd(yearsFromToday(-15)) });
    const guardian = await newPatient();
    const link = (patient, doc, who = lead, scopes = ['appointments', 'documents']) =>
      who.client.post(`/api/v1/patients/${patient.id}/guardian-links`, {
        email: emailOfKey(guardian.key),
        relationship: 'parent',
        documentId: doc,
        scopes,
      });
    const doc = await fixtureDocument({
      patientId: minor15.id,
      status: 'clean',
      classification: 'id_document',
    });
    // refusals: not a minor; no document / another patient's document; a desk without the verify permission
    const docAdult = await fixtureDocument({
      patientId: adult.id,
      status: 'clean',
      classification: 'id_document',
    });
    assert.ok(
      (await link(adult, docAdult)).status >= 400,
      'an adult patient cannot be given a guardian by staff',
    );
    assert.ok((await link(minor15, uuid())).status >= 400, 'no relationship document: refused');
    assert.ok(
      (await link(minor15, docAdult)).status >= 400,
      "another patient's document is not evidence",
    );
    assert.ok(
      [403, 404].includes((await link(minor15, doc, plain)).status),
      'a desk without identity.proxy.verify cannot link',
    );
    const l = await link(minor15, doc);
    assert.equal(l.status, 201, `link ${l.status} ${l.text.slice(0, 200)}`);
    assert.equal(
      l.json.status,
      'invited',
      'the relationship document was checked; the guardian still has to accept with the code',
    );
    assert.deepEqual(
      l.json.scopes,
      ['appointments'],
      'age 13-17: appointments only, whatever staff asked for',
    );
    await setKnownCode(l.json.id, CODE);
    assert.equal((await accept(guardian, l.json.id, CODE)).status, 200);
    assert.equal(await seesAppointments(guardian, minor15.id), 200);
    assert.equal(
      (await guardian.client.get(`/api/v1/patients/${minor15.id}/documents`)).status,
      404,
      'documents stay closed for ages 13-17',
    );
    // valid_until = the day before the 18th birthday (access ends on the birthday)
    const row = (
      await sql(
        `SELECT valid_until::text AS v, (patient_birth_date + interval '18 years')::date::text AS b18 FROM identity.proxy_grant WHERE id = $1`,
        [l.json.id],
      )
    ).rows[0];
    assert.equal(
      row.v,
      ymd(addDays(new Date(row.b18), -1)),
      'last day of access is the day before the 18th birthday',
    );
    // the proxy listing for staff shows the grant; staff revoke is immediate and audited
    const list = await lead.client.get(`/api/v1/patients/${minor15.id}/proxy-grants`);
    assert.equal(list.status, 200);
    assert.ok(list.json.items.some((x) => x.id === l.json.id));
    const rv = await lead.client.post(
      `/api/v1/patients/${minor15.id}/proxies/${l.json.id}/revoke`,
      {},
    );
    assert.equal(rv.status, 204, `staff revoke ${rv.status}`);
    assert.equal(
      await seesAppointments(guardian, minor15.id),
      404,
      'staff revocation is immediate',
    );
    const ev = await sql(
      `SELECT count(*)::int AS n FROM audit.event WHERE patient_id = $1 AND resource_type = 'identity.proxy_grant'`,
      [minor15.id],
    );
    assert.ok(ev.rows[0].n >= 3, 'link, accept and revoke are audited');

    // under 13 staff may grant more; from 13 the guardian keeps appointments only
    const child10 = await newPatient({ dob: ymd(yearsFromToday(-10)) });
    const doc10 = await fixtureDocument({
      patientId: child10.id,
      status: 'clean',
      classification: 'id_document',
    });
    const g10 = await link(child10, doc10);
    assert.equal(g10.status, 201);
    assert.deepEqual(
      [...g10.json.scopes].sort(),
      ['appointments', 'documents'],
      'under 13: the extra scope applies',
    );
  });

  test('RA-R1-20b age-out: the notice is due 30 days before the 18th birthday; access ends on the birthday with no job having run; the daily job records the expiry', async () => {
    const lead = await newStaff([['front_desk_lead', A1]], { name: 'STF-FDL' });
    // 17 years 11 months: the 18th birthday is about 20 days away (inside the 30-day notice window)
    const dob = ymd(addDays(yearsFromToday(-18), 20));
    const minor = await newPatient({ dob });
    const guardian = await newPatient();
    const doc = await fixtureDocument({
      patientId: minor.id,
      status: 'clean',
      classification: 'id_document',
    });
    const l = await lead.client.post(`/api/v1/patients/${minor.id}/guardian-links`, {
      email: emailOfKey(guardian.key),
      relationship: 'parent',
      documentId: doc,
      scopes: ['appointments'],
    });
    assert.equal(l.status, 201, `link ${l.status} ${l.text.slice(0, 200)}`);
    await setKnownCode(l.json.id, CODE);
    assert.equal((await accept(guardian, l.json.id, CODE)).status, 200);
    assert.equal(await seesAppointments(guardian, minor.id), 200, 'access runs until the last day');
    const gv = (
      await sql(`SELECT valid_until::text AS v FROM identity.proxy_grant WHERE id = $1`, [
        l.json.id,
      ])
    ).rows[0];
    assert.equal(
      gv.v,
      ymd(addDays(yearsFromToday(0), 19)),
      'last day = day before the 18th birthday (19 days from today)',
    );
    const notice = await sql(
      `SELECT value FROM kernel.setting WHERE key = 'proxy_age_out_notice_days' AND location_id IS NULL`,
    );
    assert.equal(
      Number(JSON.parse(JSON.stringify(notice.rows[0].value))),
      30,
      'the notice period is 30 days (ruling C item 3)',
    );
    assert.equal(
      Number(
        (
          await sql(
            `SELECT value FROM kernel.setting WHERE key = 'proxy_age_of_majority' AND location_id IS NULL`,
          )
        ).rows[0].value,
      ),
      18,
    );
    assert.equal(
      Number(
        (
          await sql(
            `SELECT value FROM kernel.setting WHERE key = 'proxy_adolescent_min_age' AND location_id IS NULL`,
          )
        ).rows[0].value,
      ),
      13,
    );

    // the worker job (notice step): the mail port refuses in ci, so the notice is NOT sent here. Run it to prove the other steps are independent.
    // time passes (controllable clock): the last day is in the past; access is gone before any job has run
    // (the daily job re-derives the dates from the stored birth date, so the clock is moved by moving the birth date, not valid_until)
    await belowTriggers((c) =>
      c.query(
        `UPDATE identity.proxy_grant SET patient_birth_date = current_date - interval '18 years' - interval '5 days',
                adolescent_from = (current_date - interval '18 years' - interval '5 days' + interval '13 years')::date,
                valid_until = current_date - 6 WHERE id = $1`,
        [l.json.id],
      ),
    );
    assert.equal(
      await seesAppointments(guardian, minor.id),
      404,
      'access ended without any job having run',
    );
    const before = (await sql(`SELECT status FROM identity.proxy_grant WHERE id = $1`, [l.json.id]))
      .rows[0].status;
    assert.equal(
      before,
      'active',
      'the row is still marked active: the access rule does not wait for the job',
    );
    assert.equal((await enqueue('identity.proxy_age_out')).rows[0].n, 1);
    assert.ok(
      await until(
        async () =>
          (await sql(`SELECT status FROM identity.proxy_grant WHERE id = $1`, [l.json.id])).rows[0]
            .status === 'expired',
        { timeoutMs: 60000 },
      ),
      'the daily job marked the grant expired',
    );
    const done = (
      await sql(`SELECT status, revoke_reason, ended_by FROM identity.proxy_grant WHERE id = $1`, [
        l.json.id,
      ])
    ).rows[0];
    assert.equal(done.status, 'expired');
    assert.deepEqual([done.revoke_reason, done.ended_by], ['age_out', 'age_out']);
    const ev = await sql(
      `SELECT count(*)::int AS n FROM audit.event WHERE patient_id = $1 AND resource_type = 'identity.proxy_grant' AND realm = 'worker'`,
      [minor.id],
    );
    assert.ok(ev.rows[0].n >= 1, 'the expiry is audited as the job');
    // the 30-day NOTICE mail: not sent in ci. The test asserts that the notice is not falsely recorded as sent.
    const sent = await sql(`SELECT age_out_notice_at FROM identity.proxy_grant WHERE id = $1`, [
      l.json.id,
    ]);
    assert.equal(
      sent.rows[0].age_out_notice_at,
      null,
      'LIMITATION: no notice mail is sent in ci (no provider); nothing is recorded as sent',
    );
  });
});

// ================================================================================================================================
// TC-TH-06..08  telehealth licensing with configured (fixture) states (ruling C item 4)
// ================================================================================================================================
async function ensureFixtureStates() {
  const adm1 = await adm('ADM-1');
  await sqlTx(async (c) => {
    for (const code of Object.values(ST))
      await c.query(
        `INSERT INTO organisation.jurisdiction (code, organisation_id, name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [code, ORG, `Fixture state ${code}`],
      );
  });
  // the organisation records its operating states through the admin API (no state list exists in production code)
  for (const [code, allowed] of [
    [ST.licensed, true],
    [ST.unlicensed, true],
    [ST.closed, false],
  ]) {
    const r = await adm1.put('/api/v1/admin/operating-states', {
      jurisdictionCode: code,
      effectiveFrom: '2020-01-01',
      telehealthAllowed: allowed,
    });
    assert.equal(r.status, 200, `operating state ${code}: ${r.status} ${r.text.slice(0, 200)}`);
  }
  return adm1;
}
const setLicensed = async (adm1, principalId, states) => {
  const r = await adm1.put(`/api/v1/admin/staff-profiles/${principalId}`, {
    licensedStates: states,
  });
  assert.equal(r.status, 200, `licensed states ${r.status} ${r.text.slice(0, 200)}`);
  return r;
};
async function videoVisit(adm1, { licensed = [ST.licensed], patientState = ST.licensed } = {}) {
  const pat = await newPatient();
  const doc = await newDoctor({ services: [SVC.VID], allDay: true });
  await setLicensed(adm1, doc.id, licensed);
  const sr = await search(pat.client, {
    serviceId: SVC.VID,
    mode: 'video',
    day: soon(0.1, 3),
    clinicianId: doc.id,
  });
  assert.ok(sr.slots.length > 0, 'a video slot exists');
  const b = await book(pat, sr.slots[0], SVC.VID, 'video', { patientState });
  return { pat, doc, id: b.appointment.id, slots: sr.slots };
}

describe('TC-TH-06..08 licensing with configured fixture states', () => {
  test('TC-TH-06 booking: telehealth only where the clinician holds a recorded licence for an operating state; otherwise refused', async () => {
    const adm1 = await ensureFixtureStates();
    const doc = await newDoctor({ services: [SVC.VID], allDay: true });
    await setLicensed(adm1, doc.id, [ST.licensed, ST.closed]); // licensed in the closed (non-operating) state as well
    const pat = await newPatient();
    const sr = await search(pat.client, {
      serviceId: SVC.VID,
      mode: 'video',
      day: soon(0.1, 6),
      clinicianId: doc.id,
    });
    assert.ok(sr.slots.length >= 3);
    const ok = await hold(pat, sr.slots[0], SVC.VID, 'video', { patientState: ST.licensed });
    assert.equal(
      ok.status,
      201,
      `licensed+operating state allowed (${ok.status} ${ok.text?.slice(0, 160)})`,
    );
    const unl = await hold(await newPatient(), sr.slots[1], SVC.VID, 'video', {
      patientState: ST.unlicensed,
    });
    assert.match(
      unl.json?.code ?? '',
      /licensing_refused/,
      'an operating state without a recorded licence is refused',
    );
    const closed = await hold(await newPatient(), sr.slots[2], SVC.VID, 'video', {
      patientState: ST.closed,
    });
    assert.match(
      closed.json?.code ?? '',
      /licensing_refused/,
      'a state that is not an operating state is refused even if the clinician is licensed there',
    );
    assert.doesNotMatch(
      unl.text + closed.text,
      new RegExp(`Fixture state|${ST.licensed}|Test Patient`),
      'refusals carry no PHI or state detail',
    );
    // an in-person service is not subject to the telehealth licence rule
    const inp = await search(pat.client, {
      serviceId: SVC.IN,
      mode: 'in_person',
      day: soon(0.1, 6),
      clinicianId: doc.id,
    });
    if (inp.slots.length > 0) {
      const h = await hold(await newPatient(), inp.slots[0], SVC.IN, 'in_person', {
        patientState: ST.unlicensed,
      });
      assert.equal(h.status, 201, 'in-person visits do not need a telehealth licence');
    }
  });

  test('TC-TH-07 join: the patient confirms the current location; outside the clinician licensed states refused, inside accepted; every answer kept', async () => {
    const adm1 = await ensureFixtureStates();
    const v = await videoVisit(adm1, { licensed: [ST.licensed] });
    assert.equal(
      (await v.pat.client.get(`/api/v1/appointments/${v.id}/video-session`)).status,
      200,
    );
    const out = await v.pat.client.post(`/api/v1/appointments/${v.id}/video-session/location`, {
      state: ST.unlicensed,
    });
    assert.equal(out.status, 422);
    assert.match(out.json?.code ?? '', /licensing_refused/);
    assert.doesNotMatch(out.text, /licen[cs]e number|SYNTH-/i);
    const inside = await v.pat.client.post(`/api/v1/appointments/${v.id}/video-session/location`, {
      state: ST.licensed,
    });
    assert.equal(inside.status, 200, `inside ${inside.status} ${inside.text.slice(0, 160)}`);
    const rows = await sql(
      `SELECT stated_state, result FROM telehealth.location_confirmation WHERE reservation_id = $1 ORDER BY created_at`,
      [v.id],
    );
    assert.equal(rows.rows.length, 2, 'every answer is kept as a row');
    assert.deepEqual(
      rows.rows.map((r) => r.stated_state),
      [ST.unlicensed, ST.licensed],
    );
  });

  test('TC-TH-08 licence removed by an administrator: join refused with a safe message; re-added: allowed; both changes audited', async () => {
    const adm1 = await ensureFixtureStates();
    const v = await videoVisit(adm1, { licensed: [ST.licensed] });
    assert.equal(
      (
        await v.pat.client.post(`/api/v1/appointments/${v.id}/video-session/location`, {
          state: ST.licensed,
        })
      ).status,
      200,
    );
    // Clock control: the join window opens 10 minutes before the start. The visit is moved to start now (the occupancy period the
    // join rule reads), because a slot found by search starts later than the test is willing to wait.
    await belowTriggers((c) =>
      c.query(
        `UPDATE scheduling.slot_occupancy SET period = tstzrange(now() - interval '1 minute', now() + interval '19 minutes') WHERE id = $1`,
        [v.id],
      ),
    );
    const t0 = new Date().toISOString();
    await setLicensed(adm1, v.doc.id, []); // administrator removes the licence
    const refused = await v.pat.client.post(`/api/v1/appointments/${v.id}/video-session/join`, {});
    assert.ok(refused.status >= 400, `join refused (${refused.status})`);
    assert.match(
      refused.json?.code ?? '',
      /licensing_refused/,
      'refused because of the licence, not for another reason',
    );
    assert.doesNotMatch(
      refused.text,
      new RegExp(`licen[cs]e|${ST.licensed}|Fixture state`, 'i'),
      'a safe message: no licence or state detail, no PHI',
    );
    await setLicensed(adm1, v.doc.id, [ST.licensed]); // re-added
    const again = await v.pat.client.post(`/api/v1/appointments/${v.id}/video-session/join`, {});
    assert.doesNotMatch(
      again.json?.code ?? '',
      /licensing_refused/,
      `the licence no longer blocks the join (${again.status} ${again.json?.code})`,
    );
    const aud = await sql(
      `SELECT change::text AS change FROM audit.event WHERE occurred_at >= $1 AND resource_type = 'identity.licensed_state' AND resource_id = $2`,
      [t0, v.doc.id],
    );
    assert.ok(aud.rows.length >= 2, `both changes are audited (${aud.rows.length})`);
    assert.ok(
      aud.rows.some((r) => /"licensed":\s*false/.test(r.change)) &&
        aud.rows.some((r) => /"licensed":\s*true/.test(r.change)),
    );
    // an administrator without the permission cannot edit licences
    const cmp = await adm('CMP-1');
    const deny = await cmp.put(`/api/v1/admin/staff-profiles/${v.doc.id}`, {
      licensedStates: [ST.licensed],
    });
    assert.ok(
      [401, 403].includes(deny.status),
      `compliance officer cannot edit licensed states (${deny.status})`,
    );
  });
});
