// Real-database tests for account deletion and the retention purge (owner ruling 2026-11-11 C, items 1 and 2; ticket HEAAA-789 C-BE-DEL):
//   TC-PR-03  (deletion request -> identity check -> approval -> execution: deactivated, non-record data deleted, medical record kept,
//             statement, legal hold never deleted, audited), TC-DOC-07 and TC-AU-09 support (retention windows, hold, audit trail untouched),
//   the minors rule, the 7-day export expiry, the job's report (counts per class, no PHI), the HIPAA documentation purge, and the gates of
//   the definer functions. The real roles, migrations 2600-2602, the real Nest application and guard, the worker's real jobs (loaded from the
//   worker's build). Synthetic data only. The statement sender and the package store are in memory: nothing here proves a mail provider
//   or an object store (C-01, C-11).
//   EHR_TEST_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres node --test dist/src/modules/privacy/deletion.dbtest.js
// Missing configuration FAILS; nothing skips.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { ScopeSettings } from '@ehr/kernel';
import { RETENTION_DEFAULTS } from './retention.js';
import { A1, ORG, setupPrivacy, uuidv7 } from './testkit.js';
import type { PatientKit, PrivacyKit } from './testkit.js';

const CANARY = 'CANARY-DELETION-DETAIL-9d2f';
const YEAR = 365.25 * 86_400_000;

describe('account deletion and retention (HEAAA-789) on PostgreSQL 17', () => {
  let t: PrivacyKit;
  let seq = 400;
  before(async () => {
    t = await setupPrivacy('deletion');
  });
  after(async () => {
    await t.close();
  });

  const mk = async (): Promise<PatientKit> => t.mkPatient(++seq);
  const row = async (sql: string, params: unknown[] = []): Promise<Record<string, unknown>> =>
    (await t.k.q(sql, params))[0] as Record<string, unknown>;
  const n = async (sql: string, params: unknown[] = []): Promise<number> =>
    Number((await row(sql, params))['n']);
  const code = (r: { json(): Record<string, unknown> }): unknown => r.json()['code'];
  const jobs = (name: string, key: string, value: string): Promise<number> =>
    t.k
      .q<{ n: number }>(
        `SELECT count(*)::int AS n FROM queue._private_jobs j JOIN queue._private_tasks x ON x.id = j.task_id WHERE x.identifier = $1 AND j.payload->>$2 = $3`,
        [name, key, value],
      )
      .then((r) => r[0]?.n ?? 0);
  const ymd = (d: Date): string => d.toISOString().slice(0, 10);
  const yearsAgo = (y: number): Date => new Date(Date.now() - y * YEAR);

  // ---- seeding (below the triggers: the owning modules' own tests prove their rules) --------------------------------------------
  const seedEncounter = async (p: PatientKit, endedAt: Date): Promise<string> => {
    const id = uuidv7();
    await t.seed(
      `INSERT INTO clinical.encounter (id, organisation_id, patient_id, location_id, clinician_principal_id, mode, status, started_at, ended_at, created_by)
       VALUES ($1, $2, $3, $4, $5, 'in_person', 'completed', $6::timestamptz - interval '1 hour', $6::timestamptz, $5)`,
      [id, ORG, p.patientId, A1, t.desk.seeded.principalId, endedAt.toISOString()],
    );
    return id;
  };
  const seedNote = async (p: PatientKit, encounterId: string): Promise<string> => {
    const id = uuidv7();
    await t.seed(
      `INSERT INTO clinical.note (id, organisation_id, encounter_id, patient_id, author_principal_id, template_id, body, created_by)
       VALUES ($1, $2, $3, $4, $5, 'soap', '{"s":"synthetic"}'::jsonb, $5)`,
      [id, ORG, encounterId, p.patientId, t.desk.seeded.principalId],
    );
    return id;
  };
  const seedAllergy = async (p: PatientKit): Promise<void> => {
    await t.seed(
      `INSERT INTO clinical.allergy (id, organisation_id, patient_id, display, coded, category, recorded_by)
       VALUES ($1, $2, $3, 'synthetic allergy', false, 'food', $4)`,
      [uuidv7(), ORG, p.patientId, t.desk.seeded.principalId],
    );
  };
  const seedResponse = async (
    p: PatientKit,
    status: 'in_progress' | 'submitted',
  ): Promise<string> => {
    const id = uuidv7();
    await t.seed(
      `INSERT INTO clinical.questionnaire_response (id, organisation_id, patient_id, template_key, template_version, answers, status, submitted_at)
       VALUES ($1, $2, $3, 'intake', 1, '{}'::jsonb, $4, CASE WHEN $4 = 'submitted' THEN now() END)`,
      [id, ORG, p.patientId, status],
    );
    return id;
  };
  const seedPreference = async (p: PatientKit): Promise<void> => {
    await t.seed(
      `INSERT INTO patient.communication_preference (patient_id, organisation_id, channels, language) VALUES ($1, $2, ARRAY['email','sms'], 'en')`,
      [p.patientId, ORG],
    );
  };
  const seedPush = async (p: PatientKit): Promise<void> => {
    await t.seed(
      `INSERT INTO identity.push_subscription (id, organisation_id, principal_id, endpoint, p256dh, auth)
       VALUES ($1, $2, $3, 'https://push.example.test/endpoint-1', '\\x01', '\\x02')`,
      [uuidv7(), ORG, p.session.seeded.principalId],
    );
  };
  const seedConsent = async (p: PatientKit, key: string): Promise<string> => {
    const id = uuidv7();
    await t.seed(
      `INSERT INTO patient.consent (id, organisation_id, patient_id, template_key, template_version, template_language, status, signed_at, signer_principal_id, signer_relationship, signed_name)
       VALUES ($1, $2, $3, $4, 1, 'en', 'signed', now(), $5, 'self', 'Synthetic Signer')`,
      [id, ORG, p.patientId, key, p.session.seeded.principalId],
    );
    return id;
  };
  type DocStatus = 'awaiting_upload' | 'scanning' | 'quarantined' | 'clean' | 'confirmed';
  const seedDoc = async (
    p: PatientKit,
    status: DocStatus,
    o: { retentionUntil?: string; hold?: 'placed' | 'released'; removed?: boolean } = {},
  ): Promise<string> => {
    const id = uuidv7();
    const clean = status === 'clean' || status === 'confirmed';
    const key = `${clean ? 'c' : 'q'}/${id.replaceAll('-', '')}`;
    await t.seed(
      `INSERT INTO documents.document (id, organisation_id, patient_id, classification, status, uploaded_by, upload_channel, created_by,
                                       confirmed_by, confirmed_at, retention_until)
       VALUES ($1, $2, $3, 'patient_upload_other', $4, $5, 'patient', $5,
               CASE WHEN $4 = 'confirmed' THEN $5::uuid END, CASE WHEN $4 = 'confirmed' THEN now() END, $6::date)`,
      [id, ORG, p.patientId, status, p.session.seeded.principalId, o.retentionUntil ?? null],
    );
    await t.seed(
      `INSERT INTO documents.document_version (document_id, version, organisation_id, patient_id, object_key, bucket, sha256, size_bytes, content_type,
                                               declared_content_type, scan_status, scanned_at, object_removed_at, created_by)
       VALUES ($1, 1, $2, $3, $4, $5, CASE WHEN $6 THEN decode(repeat('ab', 32), 'hex') END, 10, 'application/pdf', 'application/pdf',
               CASE WHEN $6 THEN 'clean' ELSE 'pending' END, CASE WHEN $6 THEN now() END, CASE WHEN $7 THEN now() END, $8)`,
      [
        id,
        ORG,
        p.patientId,
        key,
        clean ? 'clean' : 'quarantine',
        clean,
        o.removed === true,
        p.session.seeded.principalId,
      ],
    );
    if (o.hold !== undefined)
      await t.seed(
        `INSERT INTO documents.legal_hold (id, organisation_id, document_id, patient_id, action, reason, by_person_id, created_by)
         VALUES ($1, $2, $3, $4, $5, 'Synthetic hold for the test', $6, $7)`,
        [
          uuidv7(),
          ORG,
          id,
          p.patientId,
          o.hold,
          t.compliance.seeded.personId,
          t.compliance.seeded.principalId,
        ],
      );
    return id;
  };
  const release = async (p: PatientKit, docId: string): Promise<void> => {
    await t.seed(
      `INSERT INTO documents.legal_hold (id, organisation_id, document_id, patient_id, action, reason, by_person_id, created_by)
       VALUES ($1, $2, $3, $4, 'released', 'Synthetic release for the test', $5, $6)`,
      [
        uuidv7(),
        ORG,
        docId,
        p.patientId,
        t.compliance.seeded.personId,
        t.compliance.seeded.principalId,
      ],
    );
  };

  /** A deletion request through the API, identity verified and approved by compliance: the request ID. */
  const approvedDeletion = async (p: PatientKit): Promise<string> => {
    const c = await t.pcall(p.session, 'POST', '/api/v1/privacy-requests', {
      kind: 'deletion',
      detail: `please delete my account ${CANARY}`,
    });
    assert.equal(c.status, 201, c.body);
    const requestId = String(c.json()['id']);
    const v = await t.verify(requestId);
    assert.equal(v.status, 200, v.body);
    const d = await t.decide(requestId, 'approve');
    assert.equal(d.status, 200, d.body);
    assert.equal(d.json()['status'], 'in_progress');
    return requestId;
  };
  /** The deletion record of a request, or undefined. */
  const record = (requestId: string): Promise<Record<string, unknown> | undefined> =>
    t.k
      .q('SELECT * FROM privacy.deletion_record WHERE request_id = $1', [requestId])
      .then((r) => r[0]);
  /** Backdates what a test needs to make a record due: its retention end and the encounter dates (the SQL gate reads the database clock). */
  const makeDue = async (requestId: string): Promise<void> => {
    await t.seed(
      `UPDATE privacy.deletion_record SET retained_until = current_date - 1 WHERE request_id = $1`,
      [requestId],
    );
  };
  const countRows = async (table: string, p: PatientKit): Promise<number> =>
    n(`SELECT count(*)::int AS n FROM ${table} WHERE patient_id = $1`, [p.patientId]);
  const sysScope = (patientIds: string[]): ScopeSettings => ({
    audience: 'system',
    realm: 'worker',
    orgId: ORG,
    jobScope: 'patients',
    jobPatientIds: patientIds,
  });
  const orgScope = (): ScopeSettings => ({
    audience: 'system',
    realm: 'worker',
    orgId: ORG,
    jobScope: 'org',
  });

  // ================================================================================================================================
  // Item 1: the deletion flow
  // ================================================================================================================================
  test('TC-PR-03: approval deactivates the account, deletes the data outside the medical record, keeps the record, states what and why, and is audited', async () => {
    const p = await mk();
    const other = await mk();
    // What is outside the medical record (deleted) and what is in it (kept), for this patient and, as a control, for another.
    for (const x of [p, other]) {
      await seedPreference(x);
      await seedPush(x);
      await seedConsent(x, 'marketing.email');
      await seedConsent(x, 'cookies.analytics');
      await seedResponse(x, 'in_progress');
    }
    const treatment = await seedConsent(p, 'treatment');
    const submitted = await seedResponse(p, 'submitted');
    const enc = await seedEncounter(p, new Date('2019-03-15T10:00:00Z'));
    const note = await seedNote(p, enc);
    await seedAllergy(p);
    const upl = {
      awaiting: await seedDoc(p, 'awaiting_upload'),
      scanning: await seedDoc(p, 'scanning'),
      quarantined: await seedDoc(p, 'quarantined'),
      clean: await seedDoc(p, 'clean'),
    };
    const accepted = await seedDoc(p, 'confirmed', { retentionUntil: '2036-01-01' });
    const heldUpload = await seedDoc(p, 'awaiting_upload', { hold: 'placed' });
    const heldAccepted = await seedDoc(p, 'confirmed', {
      retentionUntil: '2036-01-01',
      hold: 'placed',
    });
    const otherEnc = await seedEncounter(other, new Date('2019-03-15T10:00:00Z'));
    assert.ok(otherEnc);
    assert.equal(
      await n(`SELECT count(*)::int AS n FROM identity.patient_link WHERE patient_id = $1`, [
        p.patientId,
      ]),
      1,
    );

    const requestId = await approvedDeletion(p);
    // Approval queued the job and deleted nothing.
    assert.equal(await jobs('privacy.execute_deletion', 'requestId', requestId), 1);
    assert.equal(await countRows('patient.communication_preference', p), 1);
    assert.equal(
      (
        await row(`SELECT status FROM identity.principal WHERE id = $1`, [
          p.session.seeded.principalId,
        ])
      )['status'],
      'active',
    );
    assert.equal(await record(requestId), undefined);

    assert.equal(await t.w.executeDeletion(requestId), 'executed');

    // (a) The account is deactivated at once: sign-in disabled, every session revoked, the old cookie is refused.
    const pr = await row(`SELECT status, disabled_reason FROM identity.principal WHERE id = $1`, [
      p.session.seeded.principalId,
    ]);
    assert.equal(pr['status'], 'disabled');
    assert.equal(pr['disabled_reason'], 'account_deleted');
    assert.equal(
      await n(
        `SELECT count(*)::int AS n FROM identity.session WHERE principal_id = $1 AND revoked_at IS NULL`,
        [p.session.seeded.principalId],
      ),
      0,
    );
    assert.equal((await t.pcall(p.session, 'GET', '/api/v1/privacy-requests')).status, 401);
    // The control patient is untouched.
    assert.equal(
      (
        await row(`SELECT status FROM identity.principal WHERE id = $1`, [
          other.session.seeded.principalId,
        ])
      )['status'],
      'active',
    );

    // (b) Outside the medical record: preferences, device tokens, marketing and cookie consents, drafts, uploads never accepted.
    assert.equal(await countRows('patient.communication_preference', p), 0);
    assert.equal(
      await n(`SELECT count(*)::int AS n FROM identity.push_subscription WHERE principal_id = $1`, [
        p.session.seeded.principalId,
      ]),
      0,
    );
    assert.equal(
      await n(
        `SELECT count(*)::int AS n FROM patient.consent WHERE patient_id = $1 AND template_key ~ '^(marketing|cookies)'`,
        [p.patientId],
      ),
      0,
    );
    assert.equal(
      await n(
        `SELECT count(*)::int AS n FROM clinical.questionnaire_response WHERE patient_id = $1 AND status = 'in_progress'`,
        [p.patientId],
      ),
      0,
    );
    for (const id of Object.values(upl))
      assert.equal(
        (await row(`SELECT status FROM documents.document WHERE id = $1`, [id]))['status'],
        'deleted',
        'an upload never accepted is deleted',
      );
    // The control patient keeps all of it.
    assert.equal(await countRows('patient.communication_preference', other), 1);
    assert.equal(
      await n(`SELECT count(*)::int AS n FROM identity.push_subscription WHERE principal_id = $1`, [
        other.session.seeded.principalId,
      ]),
      1,
    );
    assert.equal(
      await n(`SELECT count(*)::int AS n FROM patient.consent WHERE patient_id = $1`, [
        other.patientId,
      ]),
      2,
    );
    assert.equal(
      await n(
        `SELECT count(*)::int AS n FROM clinical.questionnaire_response WHERE patient_id = $1`,
        [other.patientId],
      ),
      1,
    );

    // (c) The medical record and the audit trail are kept: encounter, note, allergy, signed treatment consent, submitted questionnaire,
    // the accepted documents.
    assert.equal(await countRows('clinical.encounter', p), 1);
    assert.equal(await n(`SELECT count(*)::int AS n FROM clinical.note WHERE id = $1`, [note]), 1);
    assert.equal(await countRows('clinical.allergy', p), 1);
    assert.equal(
      await n(`SELECT count(*)::int AS n FROM patient.consent WHERE id = $1`, [treatment]),
      1,
    );
    assert.equal(
      await n(`SELECT count(*)::int AS n FROM clinical.questionnaire_response WHERE id = $1`, [
        submitted,
      ]),
      1,
    );
    assert.equal(
      (await row(`SELECT status FROM documents.document WHERE id = $1`, [accepted]))['status'],
      'confirmed',
    );
    assert.ok(
      (await n(`SELECT count(*)::int AS n FROM audit.event WHERE patient_id = $1`, [p.patientId])) >
        0,
      'the audit trail is kept',
    );

    // A legal hold is never deleted: the held upload and the held accepted document are as they were.
    assert.equal(
      (await row(`SELECT status FROM documents.document WHERE id = $1`, [heldUpload]))['status'],
      'awaiting_upload',
    );
    assert.equal(
      (await row(`SELECT status FROM documents.document WHERE id = $1`, [heldAccepted]))['status'],
      'confirmed',
    );

    // The request is complete and carries the legal-hold check; the record carries the counts, the retention end and the statement.
    const rq = await row(
      `SELECT status, legal_hold_documents, legal_hold_checked_at FROM privacy.request WHERE id = $1`,
      [requestId],
    );
    assert.equal(rq['status'], 'fulfilled');
    assert.equal(Number(rq['legal_hold_documents']), 2);
    assert.ok(rq['legal_hold_checked_at'] !== null);
    const rec = (await record(requestId)) as Record<string, unknown>;
    assert.equal(
      ymd(new Date(String(rec['retained_until']))),
      '2029-03-15',
      'last encounter + 10 years (adult)',
    );
    assert.equal(rec['purge_state'], 'pending');
    assert.equal(Number(rec['held_documents']), 2);
    assert.equal(Number(rec['principals_disabled']), 1);
    assert.deepEqual(rec['deleted_counts'], {
      notification_preferences: 1,
      device_and_push_tokens: 1,
      marketing_and_cookie_consents: 2,
      drafts: 1,
      unaccepted_uploads: 4,
    });
    const kept = rec['kept_counts'] as Record<string, number>;
    assert.equal(kept['encounters'], 1);
    assert.equal(kept['notes'], 1);
    assert.equal(kept['accepted_documents'], 2);
    assert.equal(kept['consents'], 1);

    // (d) The statement: what was deleted, what is kept, why and until when, and the legal hold; no PHI in it.
    const st = rec['statement'] as Record<string, unknown>;
    assert.equal(st['keptReason'], 'medical_record_retention');
    assert.equal(st['keptUntil'], '2029-03-15');
    assert.deepEqual(st['legalHold'], { documents: 2 });
    assert.equal(JSON.stringify(st).includes(p.patientId), false);
    assert.equal(JSON.stringify(st).includes('person'), false);
    assert.equal(JSON.stringify(st).includes(CANARY), false);
    assert.equal(
      await jobs('privacy.send_deletion_statement', 'requestId', requestId),
      1,
      'queued in the same transaction',
    );
    t.statements.sent.length = 0;
    assert.equal(await t.w.sendStatement(requestId), 'sent');
    assert.equal(t.statements.sent.length, 1);
    const text = (t.statements.sent[0] as { text: string }).text;
    assert.match(text, /deactivated/);
    assert.match(text, /2029-03-15/);
    assert.match(text, /legal hold/);
    assert.match(text, /notification preferences/);
    assert.match(text, /clinical notes/);
    assert.equal(
      text.includes(p.patientId) || text.includes(CANARY),
      false,
      'no PHI in the statement',
    );
    assert.ok((await record(requestId))?.['statement_sent_at'] !== null);
    assert.equal(await t.w.sendStatement(requestId), 'already_sent');
    assert.equal(t.statements.sent.length, 1);

    // Audited: counts only, no PHI.
    const ev = await t.k.q(
      `SELECT action, resource_type, change::text AS change FROM audit.event WHERE patient_id = $1 AND resource_type IN ('privacy.deletion_record', 'privacy.request') ORDER BY occurred_at`,
      [p.patientId],
    );
    assert.ok(
      ev.some(
        (e) =>
          e['resource_type'] === 'privacy.deletion_record' &&
          e['action'] === 'update' &&
          String(e['change']).includes('account_deletion'),
      ),
    );
    for (const e of ev) assert.equal(String(e['change']).includes(CANARY), false);

    // Idempotent: a second run (a retry) changes nothing.
    assert.equal(await t.w.executeDeletion(requestId), 'final');
    assert.equal(
      await n(`SELECT count(*)::int AS n FROM privacy.deletion_record WHERE request_id = $1`, [
        requestId,
      ]),
      1,
    );

    // Compliance sees the result on the request; the patient's own scope cannot read the deletion record.
    const list = await t.scall(
      t.compliance,
      'GET',
      '/api/v1/admin/privacy-requests?status=fulfilled',
    );
    const item = (list.json()['items'] as Record<string, unknown>[]).find(
      (x) => x['id'] === requestId,
    ) as Record<string, unknown>;
    const del = item['deletion'] as Record<string, unknown>;
    assert.equal(del['retainedUntil'], '2029-03-15');
    assert.equal(del['heldDocuments'], 2);
    assert.equal(del['purgeState'], 'pending');
    assert.ok(del['statementSentAt'] !== null);
    assert.equal(
      await t.as(
        {
          audience: 'patient',
          realm: 'patient_pool',
          orgId: ORG,
          principalId: other.session.seeded.principalId,
          personId: other.session.seeded.personId,
          patientIds: [other.patientId],
        },
        (tx) => tx.query(`SELECT 1 FROM privacy.deletion_record`).then((r) => r.rows.length),
      ),
      0,
    );
  });

  test('a failing statement sender leaves the record unsent and the job retried; the deletion itself stands', async () => {
    const p = await mk();
    const requestId = await approvedDeletion(p);
    assert.equal(await t.w.executeDeletion(requestId), 'executed');
    t.statements.fail = true;
    await assert.rejects(t.w.sendStatement(requestId), /mail provider/);
    assert.equal((await record(requestId))?.['statement_sent_at'], null);
    t.statements.fail = false;
    assert.equal(await t.w.sendStatement(requestId), 'sent');
    assert.ok((await record(requestId))?.['statement_sent_at'] !== null);
  });

  test('the execution is refused before approval, after refusal, and for a request that is not a deletion', async () => {
    const p = await mk();
    const c = await t.pcall(p.session, 'POST', '/api/v1/privacy-requests', { kind: 'deletion' });
    const requestId = String(c.json()['id']);
    await assert.rejects(t.w.executeDeletion(requestId), /not approved/);
    assert.equal(await countRows('patient.communication_preference', p), 0);
    assert.equal((await t.verify(requestId)).status, 200);
    assert.equal(
      (await t.decide(requestId, 'refuse', 'Requester withdrew the request.')).status,
      200,
    );
    assert.equal(await t.w.executeDeletion(requestId), 'final');
    assert.equal(
      (
        await row(`SELECT status FROM identity.principal WHERE id = $1`, [
          p.session.seeded.principalId,
        ])
      )['status'],
      'active',
    );
    const exp = await t.approvedExport(await mk());
    await assert.rejects(t.w.executeDeletion(exp.requestId), /not a deletion request/);
    assert.equal(await t.w.executeDeletion(uuidv7()), 'gone');
  });

  test('a legacy blocked_d8 request (recorded before the ruling) is approved once its identity is verified, then runs like any other', async () => {
    const p = await mk();
    const requestId = uuidv7();
    // What the previous release wrote: a deletion request stored blocked_d8 (still accepted by the state machine, N-1).
    await t.as(
      {
        audience: 'patient',
        realm: 'patient_pool',
        orgId: ORG,
        principalId: p.session.seeded.principalId,
        personId: p.session.seeded.personId,
        patientIds: [p.patientId],
      },
      (tx) =>
        tx.query(
          `INSERT INTO privacy.request (id, organisation_id, patient_id, kind, requested_by_principal_id, channel, status, due_at, created_by)
           VALUES ($1::uuid, kernel.uuid1('app.org_id'), $2::uuid, 'deletion', $3::uuid, 'portal', 'blocked_d8', now() + interval '30 days', $3::uuid)`,
          [requestId, p.patientId, p.session.seeded.principalId],
        ),
    );
    assert.equal(
      code(await t.decide(requestId, 'approve')),
      'privacy.invalid_transition',
      'not before the identity check',
    );
    const v = await t.verify(requestId);
    assert.equal(v.json()['status'], 'blocked_d8');
    assert.equal((await t.decide(requestId, 'approve')).status, 200);
    await seedPreference(p);
    assert.equal(await t.w.executeDeletion(requestId), 'executed');
    assert.equal(await countRows('patient.communication_preference', p), 0);
    assert.equal(
      (await row(`SELECT status FROM privacy.request WHERE id = $1`, [requestId]))['status'],
      'fulfilled',
    );
  });

  test('retry: a deletion request still in progress with no record queues the execution again; a finished one cannot', async () => {
    const p = await mk();
    const requestId = await approvedDeletion(p);
    const again = await t.decide(requestId, 'retry');
    assert.equal(again.status, 200, again.body);
    assert.equal(
      await jobs('privacy.execute_deletion', 'requestId', requestId),
      1,
      'the same job key replaces the old job',
    );
    assert.equal(await t.w.executeDeletion(requestId), 'executed');
    assert.equal(code(await t.decide(requestId, 'retry')), 'privacy.invalid_transition');
  });

  test('a deletion request cannot be completed without its record, by anyone but the worker, and a record cannot be hand-written', async () => {
    const p = await mk();
    const requestId = await approvedDeletion(p);
    // Compliance cannot complete it.
    await assert.rejects(
      t.as(
        {
          audience: 'staff',
          realm: 'admin_pool',
          orgId: ORG,
          principalId: t.compliance.seeded.principalId,
          personId: t.compliance.seeded.personId,
          phiAccess: 'limited',
          complianceScopes: ['privacy_requests'],
        },
        (tx) =>
          tx.query(`UPDATE privacy.request SET status = 'fulfilled' WHERE id = $1::uuid`, [
            requestId,
          ]),
      ),
      /deletion request is completed by the worker|PS001/i,
    );
    // The worker cannot either, until the deletion record exists.
    await assert.rejects(
      t.worker.withScope(sysScope([p.patientId]), (tx) =>
        tx.query(`UPDATE privacy.request SET status = 'fulfilled' WHERE id = $1::uuid`, [
          requestId,
        ]),
      ),
      /deletion record is written|completed by the worker|PS001/i,
    );
    // A record for a request that is not approved is refused by the trigger.
    const c = await t.pcall(p.session, 'POST', '/api/v1/privacy-requests', { kind: 'deletion' });
    const unapproved = String(c.json()['id']);
    await assert.rejects(
      t.worker.withScope(sysScope([p.patientId]), (tx) =>
        tx.query(
          `INSERT INTO privacy.deletion_record (id, organisation_id, request_id, executed_at, principals_disabled, sessions_revoked, deleted_counts, kept_counts, held_documents, retained_until, statement)
           VALUES ($1::uuid, kernel.uuid1('app.org_id'), $2::uuid, now(), 0, 0, '{}', '{}', 0, current_date, '{}')`,
          [uuidv7(), unapproved],
        ),
      ),
      /approved, identity-verified deletion request|PS001/i,
    );
  });

  test('the definer functions are gated: wrong scope, wrong request, foreign patients, and no EXECUTE for the API role', async () => {
    const p = await mk();
    const q = await mk();
    const requestId = await approvedDeletion(p);
    const call = (scope: ScopeSettings, fn: string): Promise<unknown> =>
      t.worker.withScope(scope, (tx) =>
        tx.query(`SELECT privacy.delete_nonrecord_data($1::uuid) AS r`, [fn]),
      );
    await assert.rejects(call(orgScope(), requestId), /42501|only the patients-scope system job/i);
    await assert.rejects(
      call(sysScope([q.patientId]), requestId),
      /no such deletion request for this job/,
    );
    await assert.rejects(
      call(sysScope([p.patientId, q.patientId]), requestId),
      /outside this request/,
    );
    await assert.rejects(call(sysScope([p.patientId]), uuidv7()), /no such deletion request/);
    await assert.rejects(
      t.api.withScope(
        {
          audience: 'patient',
          realm: 'patient_pool',
          orgId: ORG,
          principalId: p.session.seeded.principalId,
          personId: p.session.seeded.personId,
          patientIds: [p.patientId],
        },
        (tx) => tx.query(`SELECT privacy.delete_nonrecord_data($1::uuid)`, [requestId]),
      ),
      /permission denied/i,
    );
    // The same refusals for the purge functions.
    await assert.rejects(
      t.worker.withScope(orgScope(), (tx) =>
        tx.query(`SELECT privacy.purge_medical_record($1::uuid)`, [uuidv7()]),
      ),
      /patients-scope/,
    );
    await assert.rejects(
      t.worker.withScope(sysScope([p.patientId]), (tx) =>
        tx.query(`SELECT privacy.purge_hipaa_documentation(current_date - 4000)`),
      ),
      /organisation-scope/,
    );
    await assert.rejects(
      t.worker.withScope(orgScope(), (tx) =>
        tx.query(`SELECT privacy.purge_hipaa_documentation(current_date - 10)`),
      ),
      /at least a year/,
    );
    // Nothing was deleted by any refused call, and the worker still has no direct DELETE on the record.
    assert.equal(
      (
        await row(`SELECT status FROM identity.principal WHERE id = $1`, [
          p.session.seeded.principalId,
        ])
      )['status'],
      'active',
    );
    const enc = await seedEncounter(p, yearsAgo(20));
    assert.ok(enc);
    await assert.rejects(
      t.worker.withScope(sysScope([p.patientId]), (tx) =>
        tx.query(`DELETE FROM clinical.encounter WHERE patient_id = $1::uuid`, [p.patientId]),
      ),
      /permission denied/i,
    );
    assert.equal(await countRows('clinical.encounter', p), 1);
  });

  // ================================================================================================================================
  // Item 2: retention
  // ================================================================================================================================
  /** A patient whose deletion was executed; returns the request ID. */
  const deleted = async (p: PatientKit): Promise<string> => {
    const requestId = await approvedDeletion(p);
    assert.equal(await t.w.executeDeletion(requestId), 'executed');
    return requestId;
  };

  test('the medical record is purged only after its retention ends: adult 10 years after the last encounter; the report counts per class and holds no PHI', async () => {
    const young = await mk(); // last encounter 2 years ago
    const old = await mk(); // last encounter 11 years ago
    for (const [x, years] of [
      [young, 2],
      [old, 11],
    ] as const) {
      const e = await seedEncounter(x, yearsAgo(years));
      await seedNote(x, e);
      await seedAllergy(x);
      await seedConsent(x, 'treatment');
      await seedResponse(x, 'submitted');
      await seedDoc(x, 'confirmed', { retentionUntil: ymd(yearsAgo(1)) });
    }
    const yReq = await deleted(young);
    const oReq = await deleted(old);
    // Both stored dates are backdated so the database gate would let them through; the job's own rule decides.
    await makeDue(yReq);
    await makeDue(oReq);
    const rep = await t.w.retentionPurge();
    assert.equal(rep.status, 'completed');
    // young: the recomputed end (2 years ago + 10) is in the future: extended, nothing deleted.
    assert.equal(rep.classes.medical_record.extendedByNewerEncounter, 1);
    assert.equal(await countRows('clinical.encounter', young), 1);
    assert.equal(await countRows('clinical.allergy', young), 1);
    assert.equal((await record(yReq))?.['purge_state'], 'pending');
    // old: purged (documents marked deleted, rows follow once the objects are gone).
    assert.equal(await countRows('clinical.encounter', old), 0);
    assert.equal(await countRows('clinical.note', old), 0);
    assert.equal(await countRows('clinical.allergy', old), 0);
    assert.equal(await countRows('patient.consent', old), 0);
    assert.equal(await countRows('clinical.questionnaire_response', old), 0);
    assert.equal(rep.classes.medical_record.objectsPending, 1);
    assert.equal(rep.classes.medical_record.purged, 0);
    assert.equal(rep.classes.medical_record.removed['clinical.encounter'], 1);
    assert.equal(rep.classes.medical_record.removed['clinical.note'], 1);
    assert.equal(rep.classes.medical_record.removed['documents.document_marked_deleted'], 1);
    assert.equal((await record(oReq))?.['purge_state'], 'objects_pending');
    // The next run, after documents.retention_sweep removed the objects, finishes it.
    await t.seed(
      `UPDATE documents.document_version SET object_removed_at = now() WHERE patient_id = $1`,
      [old.patientId],
    );
    const rep2 = await t.w.retentionPurge();
    assert.equal(rep2.classes.medical_record.purged, 1);
    assert.equal(rep2.classes.medical_record.removed['documents.document'], 1);
    assert.equal(await countRows('documents.document', old), 0);
    assert.equal(await countRows('documents.document_version', old), 0);
    const fin = (await record(oReq)) as Record<string, unknown>;
    assert.equal(fin['purge_state'], 'purged');
    assert.ok(fin['purged_at'] !== null);
    // A purged record is final and never purged twice.
    const rep3 = await t.w.retentionPurge();
    assert.equal(
      rep3.classes.medical_record.purged + rep3.classes.medical_record.objectsPending,
      0,
    );

    // The report is stored and audited: counts per class, class names only, no PHI, no identifiers.
    const stored = await row(
      `SELECT status, report::text AS report FROM privacy.retention_run WHERE id = $1`,
      [rep.runId],
    );
    assert.equal(stored['status'], 'completed');
    for (const secret of [old.patientId, young.patientId, CANARY, 'Given', 'Family', 'person'])
      assert.equal(String(stored['report']).includes(secret), false, `no ${secret} in the report`);
    const ev = await row(
      `SELECT change::text AS change, patient_id FROM audit.event WHERE resource_type = 'privacy.retention_run' AND resource_id = $1`,
      [rep.runId],
    );
    assert.equal(ev['patient_id'], null);
    assert.equal(String(ev['change']).includes(old.patientId), false);
    // Compliance reads the report through the slice.
    assert.equal(
      await t.as(
        {
          audience: 'staff',
          realm: 'admin_pool',
          orgId: ORG,
          principalId: t.compliance.seeded.principalId,
          personId: t.compliance.seeded.personId,
          phiAccess: 'limited',
          complianceScopes: ['privacy_requests'],
        },
        (tx) =>
          tx
            .query(`SELECT id FROM privacy.retention_run WHERE id = $1::uuid`, [rep.runId])
            .then((r) => r.rows.length),
      ),
      1,
    );
  });

  test('minors: kept until age 21 or 10 years after the last encounter, whichever is later; the setting changes the date with no code change', async () => {
    const child = await mk();
    const adult = await mk();
    // Born 19 years ago, last seen 11 years ago (age 8, a minor): adult rule = 1 year ago (due); minor rule = 21st birthday, 2 years from now.
    await t.seed(`UPDATE patient.patient SET date_of_birth = $2::date WHERE id = $1`, [
      child.patientId,
      ymd(yearsAgo(19)),
    ]);
    for (const x of [child, adult]) await seedEncounter(x, yearsAgo(11));
    const cReq = await deleted(child);
    const aReq = await deleted(adult);
    const cEnd = ymd(new Date(String((await record(cReq))?.['retained_until'])));
    const aEnd = ymd(new Date(String((await record(aReq))?.['retained_until'])));
    assert.ok(
      cEnd > ymd(new Date()),
      'the minors rule keeps the child record beyond the adult date',
    );
    assert.ok(aEnd < ymd(new Date()), 'the adult date has passed');
    await makeDue(cReq);
    await makeDue(aReq);
    const rep = await t.w.retentionPurge();
    assert.ok(
      rep.classes.medical_record.extendedByNewerEncounter >= 1,
      'the child record is not purged',
    );
    assert.equal(await countRows('clinical.encounter', child), 1);
    assert.equal(await countRows('clinical.encounter', adult), 0, 'the adult record is purged');
    // The age is a setting: with the minors age at 18 (passed 1 year ago) the child rule gives way to the encounter rule.
    t.setRetention({ minorRetainUntilAgeYears: 18 });
    const rep2 = await t.w.retentionPurge();
    assert.ok(
      rep2.classes.medical_record.purged + rep2.classes.medical_record.objectsPending >= 1,
      'now due: 11 + 10 years is long past, 18th birthday too',
    );
    assert.equal(await countRows('clinical.encounter', child), 0);
    t.setRetention();
  });

  test('a legal hold on any document defers the whole purge, and nothing is deleted; releasing it lets the next run purge', async () => {
    const p = await mk();
    const e = await seedEncounter(p, yearsAgo(12));
    await seedNote(p, e);
    const held = await seedDoc(p, 'confirmed', {
      retentionUntil: ymd(yearsAgo(1)),
      hold: 'placed',
    });
    const req = await deleted(p);
    await makeDue(req);
    const rep = await t.w.retentionPurge();
    assert.equal(rep.classes.medical_record.deferredLegalHold, 1);
    assert.equal(rep.classes.medical_record.purged + rep.classes.medical_record.objectsPending, 0);
    assert.equal(await countRows('clinical.encounter', p), 1);
    assert.equal(await countRows('clinical.note', p), 1);
    assert.equal(
      (await row(`SELECT status FROM documents.document WHERE id = $1`, [held]))['status'],
      'confirmed',
    );
    const rec = (await record(req)) as Record<string, unknown>;
    assert.equal(rec['purge_state'], 'pending');
    assert.equal(rec['purge_deferred_reason'], 'legal_hold');
    assert.ok(rec['purge_checked_at'] !== null);
    // Still deferred on the next run.
    assert.equal((await t.w.retentionPurge()).classes.medical_record.deferredLegalHold, 1);
    // The hold is released: the next run purges.
    await release(p, held);
    const rep2 = await t.w.retentionPurge();
    assert.equal(rep2.classes.medical_record.deferredLegalHold, 0);
    assert.equal(await countRows('clinical.encounter', p), 0);
    assert.equal(rep2.classes.medical_record.objectsPending, 1);
  });

  test('a hold placed after the deletion is also respected at the database: the retention role cannot mark a held document deleted', async () => {
    const p = await mk();
    await seedEncounter(p, yearsAgo(12));
    const held = await seedDoc(p, 'confirmed', { retentionUntil: ymd(yearsAgo(1)) });
    const req = await deleted(p);
    await makeDue(req);
    // The hold arrives between the job's read and the function call: here, before; the function re-reads it under the document lock.
    await t.seed(
      `INSERT INTO documents.legal_hold (id, organisation_id, document_id, patient_id, action, reason, by_person_id, created_by)
       VALUES ($1, $2, $3, $4, 'placed', 'Synthetic hold placed late', $5, $6)`,
      [
        uuidv7(),
        ORG,
        held,
        p.patientId,
        t.compliance.seeded.personId,
        t.compliance.seeded.principalId,
      ],
    );
    const rec = (await record(req)) as Record<string, unknown>;
    const res = await t.worker.withScope(sysScope([p.patientId]), (tx) =>
      tx.query(`SELECT privacy.purge_medical_record($1::uuid) AS r`, [rec['id']]),
    );
    assert.equal((res.rows[0]?.['r'] as Record<string, unknown>)['reason'], 'legal_hold');
    assert.equal(await countRows('clinical.encounter', p), 1);
    assert.equal(
      (await row(`SELECT status FROM documents.document WHERE id = $1`, [held]))['status'],
      'confirmed',
    );
  });

  test('a document whose own retention has not ended defers the purge (TC-DOC-07 windows)', async () => {
    const p = await mk();
    await seedEncounter(p, yearsAgo(12));
    await seedDoc(p, 'confirmed', { retentionUntil: ymd(new Date(Date.now() + 5 * 86_400_000)) });
    const req = await deleted(p);
    await makeDue(req);
    const rep = await t.w.retentionPurge();
    assert.equal(rep.classes.medical_record.deferredDocumentRetention, 1);
    assert.equal(await countRows('clinical.encounter', p), 1);
    assert.equal((await record(req))?.['purge_deferred_reason'], 'document_retention');
  });

  test('privacy export packages expire 7 days after creation, whatever their expires_at, and the object is removed', async () => {
    const p = await mk();
    const t0 = new Date(Date.now() - 10 * 86_400_000);
    t.clock.at = t0;
    let done: { requestId: string; packageId: string };
    try {
      done = await t.approvedExport(p);
      const out = await t.assemble(done.packageId);
      assert.equal(out.status, 'ready');
    } finally {
      t.clock.at = undefined;
    }
    const pk = await row(
      `SELECT object_key, created_at FROM privacy.export_package WHERE id = $1`,
      [done.packageId],
    );
    const created = new Date(String(pk['created_at']));
    const key = String(pk['object_key']);
    assert.ok(t.store.has(key));
    // expires_at is the assembler's: created + 7 days (the retention setting), not the old 14.
    const exp = new Date(
      String(
        (
          await row(`SELECT expires_at FROM privacy.export_package WHERE id = $1`, [done.packageId])
        )['expires_at'],
      ),
    );
    assert.ok(Math.abs(exp.getTime() - (t0.getTime() + 7 * 86_400_000)) < 5000);
    // Push expires_at far out: the creation rule still applies.
    await t.seed(
      `UPDATE privacy.export_package SET expires_at = now() + interval '90 days' WHERE id = $1`,
      [done.packageId],
    );
    // Six days and 23 hours after creation: still there.
    const before = await t.w.retentionPurge({
      now: () => new Date(created.getTime() + 7 * 86_400_000 - 3_600_000),
    });
    assert.equal(before.classes.export_packages.expired, 0);
    assert.ok(t.store.has(key));
    // Seven days and one minute after creation: expired, object removed, reported.
    const after = await t.w.retentionPurge({
      now: () => new Date(created.getTime() + 7 * 86_400_000 + 60_000),
    });
    assert.equal(after.classes.export_packages.expired, 1);
    assert.equal(t.store.has(key), false);
    assert.equal(
      (await row(`SELECT status FROM privacy.export_package WHERE id = $1`, [done.packageId]))[
        'status'
      ],
      'expired',
    );
  });

  test('HIPAA documentation: finished requests, expired packages, closed incidents and purged deletion records go after 6 years; younger ones stay', async () => {
    const p = await mk();
    // An old fulfilled export request with an expired package, a young one, an old closed incident, a young one, an open old one.
    const oldReq = uuidv7();
    const youngReq = uuidv7();
    const mkReq = (id: string, years: number, status: string): Promise<unknown> =>
      t.seed(
        `INSERT INTO privacy.request (id, organisation_id, patient_id, kind, requested_by_principal_id, channel, status, verification_method, verified_by_person_id, verified_at, decided_by_person_id, decided_at, decision_reason, due_at, created_by)
         VALUES ($1, $2, $3, 'export', $4, 'portal', $5, 'in person', $6, now(), $6, $7::timestamptz, 'Synthetic decision reason', now(), $4)`,
        [
          id,
          ORG,
          p.patientId,
          p.session.seeded.principalId,
          status,
          t.compliance.seeded.personId,
          yearsAgo(years).toISOString(),
        ],
      );
    await mkReq(oldReq, 7, 'fulfilled');
    await mkReq(youngReq, 5, 'fulfilled');
    await t.seed(
      `INSERT INTO privacy.export_package (id, organisation_id, request_id, patient_id, status, created_by) VALUES ($1, $2, $3, $4, 'expired', $5)`,
      [uuidv7(), ORG, oldReq, p.patientId, p.session.seeded.principalId],
    );
    const incident = async (years: number, status: 'closed' | 'open'): Promise<string> => {
      const id = uuidv7();
      await t.seed(
        `INSERT INTO privacy.incident (id, organisation_id, title, description, severity, status, discovered_at, closed_at, created_by)
         VALUES ($1, $2, 'Synthetic incident', 'Synthetic', 'low', $3, $4::timestamptz - interval '10 days', CASE WHEN $3 = 'closed' THEN $4::timestamptz END, $5)`,
        [id, ORG, status, yearsAgo(years).toISOString(), t.compliance.seeded.principalId],
      );
      await t.seed(
        `INSERT INTO privacy.incident_patient (incident_id, patient_id, organisation_id) VALUES ($1, $2, $3)`,
        [id, p.patientId, ORG],
      );
      return id;
    };
    const oldInc = await incident(7, 'closed');
    const youngInc = await incident(5, 'closed');
    const openInc = await incident(8, 'open');
    // A purged deletion record from 7 years ago (and its request) and one purged 5 years ago.
    const mkRecord = async (years: number): Promise<{ req: string }> => {
      const q = await mk();
      const req = await deleted(q);
      await t.seed(
        `UPDATE privacy.deletion_record SET purge_state = 'purged', purged_at = $2::timestamptz WHERE request_id = $1`,
        [req, yearsAgo(years).toISOString()],
      );
      return { req };
    };
    const oldRec = await mkRecord(7);
    const youngRec = await mkRecord(5);

    const rep = await t.w.retentionPurge();
    const gone = rep.classes.hipaa_documentation.removed;
    assert.equal(
      gone['privacy.request'],
      2,
      'the old export request and the old purged deletion request',
    );
    assert.equal(gone['privacy.export_package'], 1);
    assert.equal(gone['privacy.incident'], 1);
    assert.equal(gone['privacy.incident_patient'], 1);
    assert.equal(gone['privacy.deletion_record'], 1);
    assert.equal(
      await n(`SELECT count(*)::int AS n FROM privacy.request WHERE id = $1`, [oldReq]),
      0,
    );
    assert.equal(
      await n(`SELECT count(*)::int AS n FROM privacy.request WHERE id = $1`, [youngReq]),
      1,
    );
    assert.equal(
      await n(`SELECT count(*)::int AS n FROM privacy.incident WHERE id = $1`, [oldInc]),
      0,
    );
    assert.equal(
      await n(`SELECT count(*)::int AS n FROM privacy.incident WHERE id = $1`, [youngInc]),
      1,
    );
    assert.equal(
      await n(`SELECT count(*)::int AS n FROM privacy.incident WHERE id = $1`, [openInc]),
      1,
      'an open incident is never removed',
    );
    assert.equal(
      await n(`SELECT count(*)::int AS n FROM privacy.deletion_record WHERE request_id = $1`, [
        oldRec.req,
      ]),
      0,
    );
    assert.equal(
      await n(`SELECT count(*)::int AS n FROM privacy.request WHERE id = $1`, [oldRec.req]),
      0,
    );
    assert.equal(
      await n(`SELECT count(*)::int AS n FROM privacy.deletion_record WHERE request_id = $1`, [
        youngRec.req,
      ]),
      1,
    );
    assert.equal(
      await n(`SELECT count(*)::int AS n FROM privacy.request WHERE id = $1`, [youngRec.req]),
      1,
    );
  });

  test('TC-AU-09 support: the audit trail and anchors are not touched by the job, the report states the configured retention and the cut-off', async () => {
    // An 8-year-old audit event (older than the 7-year retention): the application never deletes audit rows.
    const eventId = uuidv7();
    await t.seed(
      `INSERT INTO audit.event (event_id, organisation_id, occurred_at, realm, audience, action, resource_type, outcome, job_id)
       VALUES ($1, $2, now() - interval '8 years', 'worker', 'system', 'create', 'synthetic.resource', 'allowed', 'synthetic-job')`,
      [eventId, ORG],
    );
    const before = await n(`SELECT count(*)::int AS n FROM audit.event`);
    const rep = await t.w.retentionPurge();
    assert.equal(rep.classes.audit_trail.removedByThisJob, 0);
    assert.equal(rep.classes.audit_trail.reason, 'archive_governed');
    assert.equal(rep.classes.audit_trail.years, RETENTION_DEFAULTS.auditTrailYears);
    assert.equal(rep.classes.audit_anchors.years, 7);
    assert.ok(
      Number(rep.cutoffs['auditTrailOnOrBefore']?.slice(0, 4)) === new Date().getUTCFullYear() - 7,
    );
    assert.ok(
      (await n(`SELECT count(*)::int AS n FROM audit.event`)) >= before,
      'no audit row is removed (the job adds its own event)',
    );
    // The database refuses it for every application role anyway.
    await assert.rejects(
      t.worker.withScope(orgScope(), (tx) =>
        tx.query(`DELETE FROM audit.event WHERE event_id = $1::uuid`, [eventId]),
      ),
      /permission denied|append-only|PS001/i,
    );
  });

  test('a failure in one class does not stop the others: the run is partial and the failure is counted', async () => {
    const p = await mk();
    await seedEncounter(p, yearsAgo(12));
    const req = await deleted(p);
    await makeDue(req);
    // A store that cannot remove objects: the export package class fails, the purge and the report still happen.
    const done = await t.approvedExport(await mk());
    assert.equal((await t.assemble(done.packageId)).status, 'ready');
    t.clock.at = undefined;
    const broken = { remove: () => Promise.reject(new Error('store unavailable')) };
    const rep = await t.w.retentionPurge({
      store: broken,
      now: () => new Date(Date.now() + 8 * 86_400_000),
    });
    assert.equal(rep.status, 'partial');
    assert.ok(rep.classes.export_packages.failed >= 1);
    assert.equal(await countRows('clinical.encounter', p), 0, 'the other classes ran');
    assert.equal(
      (await row(`SELECT status FROM privacy.retention_run WHERE id = $1`, [rep.runId]))['status'],
      'partial',
    );
  });

  test('the retention job and the deletion jobs are in the worker task table with the real handlers', async () => {
    const tasks = (await import(
      new URL('../../../../../worker/dist/jobs/privacy/index.js', import.meta.url).href
    )) as { createPrivacyTasks(d: unknown): Record<string, unknown>; PRIVACY_CRONTAB: string };
    const table = tasks.createPrivacyTasks({ ...t.w.deps(), assemble: () => Promise.resolve() });
    for (const name of [
      'privacy.execute_deletion',
      'privacy.send_deletion_statement',
      'privacy.retention_purge',
    ])
      assert.equal(typeof table[name], 'function', name);
    assert.match(tasks.PRIVACY_CRONTAB, /10 4 \* \* \* privacy\.retention_purge/);
  });
  // ================================================================================================================================
  // HEAAA-881 (decision HEAAA-880 D-880-1..6): the purge also removes the patient-linked data outside the clinical record
  // ================================================================================================================================
  type Row = Record<string, unknown>;
  const synthetic = (dataType: string): unknown => {
    switch (dataType) {
      case 'uuid':
        return uuidv7();
      case 'text':
        return 'synthetic';
      case 'jsonb':
        return '{}';
      case 'boolean':
        return false;
      case 'integer':
      case 'bigint':
      case 'smallint':
      case 'numeric':
        return 1;
      case 'date':
        return '2026-01-01';
      case 'ARRAY':
        return '{}';
      case 'tstzrange':
        return '[2026-01-01 10:00+00,2026-01-01 11:00+00)';
      case 'bytea':
        return Buffer.alloc(32, 1);
      default:
        if (dataType.startsWith('timestamp')) return '2026-01-01T10:00:00Z';
        throw new Error(`no synthetic value for type ${dataType}`);
    }
  };
  /** One synthetic row below the triggers: every required column without a default gets a value of its type unless given. */
  const fill = async (table: string, o: Row): Promise<void> => {
    const [schema, name] = table.split('.');
    const cols = await t.k.q<{
      column_name: string;
      data_type: string;
      column_default: string | null;
      is_nullable: string;
      is_generated: string;
      is_identity: string;
    }>(
      `SELECT column_name, data_type, column_default, is_nullable, is_generated, is_identity FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
      [schema, name],
    );
    const names: string[] = [];
    const vals: unknown[] = [];
    for (const c of cols) {
      let v: unknown;
      if (c.column_name in o) v = o[c.column_name];
      else if (
        c.is_nullable === 'NO' &&
        c.column_default === null &&
        c.is_generated === 'NEVER' &&
        c.is_identity === 'NO'
      )
        v = synthetic(c.data_type);
      else continue;
      names.push(`"${c.column_name}"`);
      vals.push(v);
    }
    await t.seed(
      `INSERT INTO ${table} (${names.join(', ')}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(', ')})`,
      vals,
    );
  };
  interface Linked {
    res: string;
    thread: string;
    notification: string;
    alert: string;
  }
  /** One row in every patient-linked class outside the clinical record, for the patient (and one pointing at an `other` patient). */
  const seedLinked = async (p: PatientKit, other?: PatientKit): Promise<Linked> => {
    const [res, thread, notification, alert] = [uuidv7(), uuidv7(), uuidv7(), uuidv7()];
    const P = p.patientId;
    const X = t.desk.seeded.principalId;
    const pr = p.session.seeded.principalId;
    await fill('patient.patient_contact', {
      patient_id: P,
      organisation_id: ORG,
      kind: 'emergency',
    });
    await fill('patient.insurance_coverage', { patient_id: P, organisation_id: ORG });
    await fill('patient.care_relationship', {
      patient_id: P,
      organisation_id: ORG,
      reason: 'booking',
    });
    await fill('identity.proxy_grant', {
      patient_id: P,
      organisation_id: ORG,
      proxy_principal_id: X,
      relationship: 'parent',
      scope: 'appointments',
      status: 'active',
      patient_display_name: 'synthetic',
    });
    await fill('patient.care_team_member', {
      patient_id: P,
      organisation_id: ORG,
      role: 'nurse',
      principal_id: X,
    });
    await fill('patient.duplicate_flag', {
      patient_id: P,
      candidate_patient_id: other?.patientId ?? uuidv7(),
      organisation_id: ORG,
      source: 'front_desk',
      strength: 'exact',
    });
    // patient.staff_scope exists already: registration writes it.
    const mergeReq = uuidv7();
    await fill('patient.merge_request', {
      id: mergeReq,
      survivor_id: P,
      merged_id: uuidv7(),
      organisation_id: ORG,
    });
    await fill('patient.patient_merge', {
      merged_id: uuidv7(),
      direct_survivor_id: P,
      final_survivor_id: P,
      organisation_id: ORG,
      merge_request_id: mergeReq,
    });
    await fill('patient.merge_residue', {
      merge_request_id: mergeReq,
      survivor_id: P,
      merged_id: uuidv7(),
      organisation_id: ORG,
      source_table: 'clinical.note',
    });
    await fill('patient.match_check', {
      principal_id: pr,
      candidate_patient_ids: `{${P}}`,
      candidate_refs: `{${uuidv7()}}`,
      candidate_strengths: '{exact}',
      organisation_id: ORG,
    });
    await fill('scheduling.slot_occupancy', {
      id: res,
      organisation_id: ORG,
      location_id: A1,
      status: 'confirmed',
    });
    await fill('scheduling.slot_reservation', {
      id: res,
      patient_id: P,
      organisation_id: ORG,
      location_id: A1,
      booked_via: 'staff',
      mode: 'in_person',
    });
    await fill('scheduling.no_show_flag', {
      reservation_id: res,
      organisation_id: ORG,
      location_id: A1,
    });
    await fill('scheduling.check_in', {
      id: res,
      patient_id: P,
      organisation_id: ORG,
      location_id: A1,
      method: 'desk',
    });
    await fill('scheduling.queue_entry', {
      id: res,
      patient_id: P,
      organisation_id: ORG,
      location_id: A1,
      stage: 'waiting',
    });
    const wl = uuidv7();
    await fill('scheduling.waitlist_entry', { id: wl, patient_id: P, organisation_id: ORG });
    await fill('scheduling.waitlist_offer', {
      waitlist_entry_id: wl,
      patient_id: P,
      organisation_id: ORG,
      occupancy_id: res,
      status: 'expired',
      decided_at: '2026-01-01T10:30:00Z',
    });
    if (other !== undefined) {
      // Another patient's offer for the slot this patient's reservation held: it cannot outlive the occupancy row it points at.
      const owl = uuidv7();
      await fill('scheduling.waitlist_entry', {
        id: owl,
        patient_id: other.patientId,
        organisation_id: ORG,
      });
      await fill('scheduling.waitlist_offer', {
        waitlist_entry_id: owl,
        patient_id: other.patientId,
        organisation_id: ORG,
        occupancy_id: res,
        status: 'offered',
      });
    }
    const session = uuidv7();
    const part = uuidv7();
    await fill('telehealth.video_session', {
      id: session,
      patient_id: P,
      organisation_id: ORG,
      reservation_id: res,
      status: 'scheduled',
    });
    await fill('telehealth.participant', {
      id: part,
      session_id: session,
      patient_id: P,
      organisation_id: ORG,
      role: 'patient',
      principal_id: pr,
    });
    await fill('telehealth.join_token', {
      session_id: session,
      participant_id: part,
      patient_id: P,
      principal_id: pr,
      organisation_id: ORG,
      issued_at: '2026-01-01T10:00:00Z',
      expires_at: '2026-01-01T10:10:00Z',
      status: 'issued',
    });
    await fill('telehealth.location_confirmation', {
      reservation_id: res,
      patient_id: P,
      principal_id: pr,
      organisation_id: ORG,
      result: 'allowed',
      stated_state: 'CA',
    });
    await fill('messaging.thread', {
      id: thread,
      patient_id: P,
      organisation_id: ORG,
      kind: 'patient',
      created_by: X,
    });
    await fill('messaging.thread_participant', {
      thread_id: thread,
      principal_id: X,
      organisation_id: ORG,
      role: 'owner',
      added_by: X,
    });
    await fill('messaging.message', {
      thread_id: thread,
      patient_id: P,
      organisation_id: ORG,
      author_principal_id: X,
    });
    await fill('messaging.task', {
      patient_id: P,
      organisation_id: ORG,
      assignee_kind: 'principal',
      assignee_principal_id: X,
      created_by: X,
    });
    await fill('notifications.notification', {
      id: notification,
      patient_id: P,
      organisation_id: ORG,
      recipient_kind: 'patient',
      channel: 'email',
      dedupe_key: `seed:${notification}`,
    });
    await fill('notifications.delivery_receipt', {
      notification_id: notification,
      patient_id: P,
      organisation_id: ORG,
      status: 'delivered',
    });
    await fill('notifications.in_app_read', {
      notification_id: notification,
      patient_id: P,
      organisation_id: ORG,
    });
    await fill('notifications.staff_alert', {
      id: alert,
      patient_id: P,
      organisation_id: ORG,
      type: 'red_flag',
      severity: 'high',
      resource_type: 'seed',
      target_kind: 'principal',
      target_principal_ids: `{${X}}`,
    });
    await fill('notifications.staff_alert_event', {
      alert_id: alert,
      patient_id: P,
      organisation_id: ORG,
      kind: 'created',
    });
    return { res, thread, notification, alert };
  };
  /** Rows that still point at the patient, in every table of the catalog with a patient column or a link to the patient (none is exempt but audit, privacy and the tombstone). */
  const leftovers = async (p: PatientKit, l: Linked): Promise<Record<string, number>> => {
    const tables = await t.k.q<{ tbl: string }>(
      `SELECT DISTINCT c.oid::regclass::text AS tbl
         FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        WHERE c.relkind = 'r' AND NOT c.relispartition AND a.attname = 'patient_id'
          AND c.relnamespace::regnamespace::text NOT IN ('audit', 'privacy', 'pg_catalog', 'information_schema')
          AND c.oid::regclass::text <> 'patient.patient'`,
    );
    const out: Record<string, number> = {};
    for (const { tbl } of tables)
      out[tbl] = await n(`SELECT count(*)::int AS n FROM ${tbl} WHERE patient_id = $1`, [
        p.patientId,
      ]);
    const P = p.patientId;
    const extra: Record<string, [string, unknown[]]> = {
      'patient.duplicate_flag.candidate': [
        `SELECT count(*)::int AS n FROM patient.duplicate_flag WHERE candidate_patient_id = $1`,
        [P],
      ],
      'patient.merge_request': [
        `SELECT count(*)::int AS n FROM patient.merge_request WHERE survivor_id = $1 OR merged_id = $1`,
        [P],
      ],
      'patient.patient_merge': [
        `SELECT count(*)::int AS n FROM patient.patient_merge WHERE final_survivor_id = $1 OR direct_survivor_id = $1 OR merged_id = $1`,
        [P],
      ],
      'patient.merge_residue': [
        `SELECT count(*)::int AS n FROM patient.merge_residue WHERE survivor_id = $1 OR merged_id = $1`,
        [P],
      ],
      'patient.match_check': [
        `SELECT count(*)::int AS n FROM patient.match_check WHERE candidate_patient_ids @> ARRAY[$1::uuid]`,
        [P],
      ],
      'scheduling.slot_occupancy': [
        `SELECT count(*)::int AS n FROM scheduling.slot_occupancy WHERE id = $1`,
        [l.res],
      ],
      'scheduling.no_show_flag': [
        `SELECT count(*)::int AS n FROM scheduling.no_show_flag WHERE reservation_id = $1`,
        [l.res],
      ],
      'scheduling.waitlist_offer.occupancy': [
        `SELECT count(*)::int AS n FROM scheduling.waitlist_offer WHERE occupancy_id = $1`,
        [l.res],
      ],
      'messaging.thread_participant': [
        `SELECT count(*)::int AS n FROM messaging.thread_participant WHERE thread_id = $1`,
        [l.thread],
      ],
      'messaging.message.thread': [
        `SELECT count(*)::int AS n FROM messaging.message WHERE thread_id = $1`,
        [l.thread],
      ],
      'notifications.delivery_receipt.notification': [
        `SELECT count(*)::int AS n FROM notifications.delivery_receipt WHERE notification_id = $1`,
        [l.notification],
      ],
      'notifications.staff_alert_event.alert': [
        `SELECT count(*)::int AS n FROM notifications.staff_alert_event WHERE alert_id = $1`,
        [l.alert],
      ],
      'clinical.referral_inbox': [
        `SELECT count(*)::int AS n FROM clinical.referral_inbox i JOIN clinical.referral r ON r.id = i.referral_id WHERE r.patient_id = $1`,
        [P],
      ],
      'identity.patient_link': [
        `SELECT count(*)::int AS n FROM identity.patient_link WHERE patient_id = $1`,
        [P],
      ],
    };
    for (const [k, [sql, params]] of Object.entries(extra)) out[k] = await n(sql, params);
    return out;
  };
  const nonZero = (o: Record<string, number>): string[] =>
    Object.entries(o)
      .filter(([, v]) => v !== 0)
      .map(([k, v]) => `${k}=${v}`);

  test('HEAAA-880 D-880-1/2: the statement names the other kept classes; they stay until retention ends, then the purge removes every one, in the same run, and tombstones the patient row', async () => {
    const p = await mk();
    const other = await mk();
    const e = await seedEncounter(p, yearsAgo(11));
    await seedNote(p, e);
    const l = await seedLinked(p, other);
    const before = await leftovers(p, l);
    assert.ok(
      nonZero(before).length >= 30,
      `the fixture reaches every class: ${nonZero(before).length}`,
    );
    const otherBefore = await countRows('scheduling.waitlist_offer', other);
    assert.equal(otherBefore, 1);

    const req = await deleted(p);
    // At the request nothing of these classes is deleted (ruling C item 1); the statement lists them as kept until the same date.
    assert.deepEqual(
      nonZero(await leftovers(p, l)).filter((x) => !x.startsWith('identity.patient_link')),
      nonZero(before).filter((x) => !x.startsWith('identity.patient_link')),
      'kept at the request',
    );
    const stmt = (await record(req))?.['statement'] as {
      kept: { class: string; count: number }[];
      documentation: { years: number };
    };
    const kept = stmt.kept.map((k) => k.class);
    for (const c of [
      'contact_details',
      'insurance_coverages',
      'appointments',
      'check_ins',
      'video_visits',
      'messages',
      'notices_sent',
      'people_with_access',
      'identity_record',
    ])
      assert.ok(kept.includes(c), `the statement keeps ${c}`);
    assert.equal(stmt.documentation.years, RETENTION_DEFAULTS.hipaaDocumentationYears);

    await makeDue(req);
    const rep = await t.w.retentionPurge();
    assert.equal(rep.status, 'completed');
    assert.equal(
      (await record(req))?.['purge_state'],
      'purged',
      'no document is left, so the record is purged in this run',
    );
    const removed = rep.classes.medical_record.removed;
    for (const c of [
      'scheduling.slot_reservation',
      'scheduling.slot_occupancy',
      'scheduling.no_show_flag',
      'scheduling.check_in',
      'scheduling.queue_entry',
      'scheduling.waitlist_entry',
      'telehealth.video_session',
      'telehealth.participant',
      'telehealth.join_token',
      'telehealth.location_confirmation',
      'messaging.thread',
      'messaging.thread_participant',
      'messaging.message',
      'messaging.task',
      'notifications.notification',
      'notifications.delivery_receipt',
      'notifications.in_app_read',
      'notifications.staff_alert',
      'notifications.staff_alert_event',
      'patient.patient_contact',
      'patient.insurance_coverage',
      'patient.care_relationship',
      'patient.care_team_member',
      'patient.duplicate_flag',
      'patient.staff_scope',
      'patient.merge_request',
      'patient.patient_merge',
      'patient.merge_residue',
      'patient.match_check',
      'identity.proxy_grant',
      'identity.patient_link',
      'patient.patient_tombstoned',
    ])
      assert.ok(Number(removed[c]) >= 1, `the report counts ${c}`);
    // Two waitlist offers: the patient's own and another patient's offer for the slot the purged reservation held.
    assert.ok(Number(removed['scheduling.waitlist_offer']) >= 2);

    assert.deepEqual(
      nonZero(await leftovers(p, l)),
      [],
      'no row of any non-exempt table refers to the patient',
    );
    assert.equal(
      await countRows('scheduling.waitlist_entry', other),
      1,
      'the other patient keeps their own entry',
    );
    assert.equal(await countRows('scheduling.waitlist_offer', other), 0);

    // The tombstone: id, organisation, record number, origin, creation and purge time; nothing personal.
    const ts = await row(`SELECT * FROM patient.patient WHERE id = $1`, [p.patientId]);
    assert.equal(ts['status'], 'purged');
    assert.ok(ts['purged_at'] !== null);
    assert.match(String(ts['mrn']), /^MRN-[0-9]{7,12}$/);
    for (const c of [
      'given_name',
      'family_name',
      'middle_name',
      'date_of_birth',
      'sex_at_birth',
      'gender_identity',
      'phone_e164',
      'email',
      'address',
      'state_code',
      'preferred_language',
      'photo_document_id',
      'preferred_pharmacy',
      'merged_into',
    ])
      assert.equal(ts[c], null, `${c} is removed`);
    // The sign-in is de-identified and still disabled; the person is renamed.
    const pr = await row(`SELECT email, subject, status FROM identity.principal WHERE id = $1`, [
      p.session.seeded.principalId,
    ]);
    assert.equal(pr['email'], null);
    assert.equal(pr['subject'], `purged:${p.session.seeded.principalId}`);
    assert.equal(pr['status'], 'disabled');
    assert.equal(
      (
        await row(`SELECT display_name FROM identity.person WHERE id = $1`, [
          p.session.seeded.personId,
        ])
      )['display_name'],
      'Deleted account',
    );
    // The report holds counts only.
    const stored = await row(
      `SELECT report::text AS report FROM privacy.retention_run WHERE id = $1`,
      [rep.runId],
    );
    for (const secret of [p.patientId, other.patientId, l.res, l.thread, `Given`, 'Family', CANARY])
      assert.equal(String(stored['report']).includes(secret), false, `no ${secret} in the report`);
    // The deletion documentation itself stays (6 years) and keeps pointing at the tombstone.
    assert.equal(await n(`SELECT count(*)::int AS n FROM privacy.request WHERE id = $1`, [req]), 1);
  });

  test('HEAAA-880 (Security Reviewer note 1): a legal hold or an unmet document retention leaves every class untouched, no partial purge', async () => {
    const p = await mk();
    await seedEncounter(p, yearsAgo(12));
    const held = await seedDoc(p, 'confirmed', {
      retentionUntil: ymd(yearsAgo(1)),
      hold: 'placed',
    });
    const l = await seedLinked(p);
    const req = await deleted(p);
    await makeDue(req);
    const before = nonZero(await leftovers(p, l));
    const rep = await t.w.retentionPurge();
    assert.ok(rep.classes.medical_record.deferredLegalHold >= 1);
    assert.equal((await record(req))?.['purge_deferred_reason'], 'legal_hold');
    assert.deepEqual(
      nonZero(await leftovers(p, l)),
      before,
      'nothing removed while the hold stands',
    );
    assert.equal(
      (await row(`SELECT status FROM patient.patient WHERE id = $1`, [p.patientId]))['status'],
      'active',
    );
    // The same for a document whose own retention has not ended.
    await release(p, held);
    await t.seed(`UPDATE documents.document SET retention_until = current_date + 5 WHERE id = $1`, [
      held,
    ]);
    const before2 = nonZero(await leftovers(p, l));
    const rep2 = await t.w.retentionPurge();
    assert.ok(rep2.classes.medical_record.deferredDocumentRetention >= 1);
    assert.equal((await record(req))?.['purge_deferred_reason'], 'document_retention');
    assert.deepEqual(nonZero(await leftovers(p, l)), before2);
    assert.equal(
      (await row(`SELECT status FROM patient.patient WHERE id = $1`, [p.patientId]))['status'],
      'active',
    );
  });

  test('HEAAA-880 (Security Reviewer note 2): a sign-in shared with a patient that is not purged, or a proxy for one, is not touched; the other patient keeps everything', async () => {
    const a = await mk(); // purged
    const b = await mk(); // stays
    await seedEncounter(a, yearsAgo(11));
    const la = await seedLinked(a);
    const lb = await seedLinked(b);
    const bBefore = nonZero(await leftovers(b, lb));
    const req = await deleted(a);
    // A's sign-in is also linked to B (the schema allows several links per principal): it must stay as it is.
    await t.seed(
      `INSERT INTO identity.patient_link (principal_id, patient_id, organisation_id, kind) VALUES ($1, $2, $3, 'self')`,
      [a.session.seeded.principalId, b.patientId, ORG],
    );
    await makeDue(req);
    await t.w.retentionPurge();
    assert.deepEqual(
      nonZero(await leftovers(a, la)).filter((x) => !x.startsWith('identity.patient_link')),
      [],
    );
    const pr = await row(`SELECT subject FROM identity.principal WHERE id = $1`, [
      a.session.seeded.principalId,
    ]);
    assert.notEqual(pr['subject'], null, 'the shared sign-in keeps its subject');
    assert.notEqual(pr['subject'], `purged:${a.session.seeded.principalId}`);
    assert.notEqual(
      (
        await row(`SELECT display_name FROM identity.person WHERE id = $1`, [
          a.session.seeded.personId,
        ])
      )['display_name'],
      'Deleted account',
    );
    assert.equal(
      await n(`SELECT count(*)::int AS n FROM identity.patient_link WHERE patient_id = $1`, [
        b.patientId,
      ]),
      2,
    );
    // B is untouched, rows and root.
    assert.deepEqual(
      nonZero(await leftovers(b, lb)),
      bBefore.map((x) => (x.startsWith('identity.patient_link') ? 'identity.patient_link=2' : x)),
    );
    assert.equal(
      (await row(`SELECT status FROM patient.patient WHERE id = $1`, [b.patientId]))['status'],
      'active',
    );

    // A proxy for a patient that is not purged: the proxy's own sign-in is not de-identified, and the grant for B stays.
    const c = await mk(); // purged; its sign-in is also a proxy for B
    await seedEncounter(c, yearsAgo(11));
    const lc = await seedLinked(c);
    await fill('identity.proxy_grant', {
      patient_id: b.patientId,
      organisation_id: ORG,
      proxy_principal_id: c.session.seeded.principalId,
      relationship: 'carer',
      scope: 'appointments',
      status: 'active',
      patient_display_name: 'synthetic',
    });
    const creq = await deleted(c);
    await makeDue(creq);
    await t.w.retentionPurge();
    assert.deepEqual(nonZero(await leftovers(c, lc)), []);
    assert.notEqual(
      (
        await row(`SELECT subject FROM identity.principal WHERE id = $1`, [
          c.session.seeded.principalId,
        ])
      )['subject'],
      `purged:${c.session.seeded.principalId}`,
      'a proxy for another patient keeps its sign-in',
    );
    assert.equal(
      await n(
        `SELECT count(*)::int AS n FROM identity.proxy_grant WHERE patient_id = $1 AND proxy_principal_id = $2`,
        [b.patientId, c.session.seeded.principalId],
      ),
      1,
      'the grant for the other patient is not removed',
    );
  });

  test('HEAAA-880 D-880-3: only the retention role sets or changes a purged patient; the tombstone holds no personal data; the HIPAA documentation purge deletes it last', async () => {
    const p = await mk();
    await seedEncounter(p, yearsAgo(11));
    const l = await seedLinked(p);
    const req = await deleted(p);
    await makeDue(req);
    await t.w.retentionPurge();
    // Nobody else can write a purged status or personal data back, and a live patient cannot become purged by anyone else.
    await assert.rejects(
      t.seed(`UPDATE patient.patient SET given_name = 'Back' WHERE id = $1`, [p.patientId]),
      /patient_purged_shape/,
    );
    const live = await mk();
    await assert.rejects(
      t.seed(`UPDATE patient.patient SET status = 'purged', purged_at = now() WHERE id = $1`, [
        live.patientId,
      ]),
      /patient_purged_shape/,
    );
    // Below the CHECK, the trigger: a complete shape written by anyone but the retention role is refused (this connection runs triggers).
    const complete = `UPDATE patient.patient SET status = 'purged', purged_at = now(), given_name = NULL, family_name = NULL, date_of_birth = NULL,
                state_code = NULL, preferred_language = NULL, middle_name = NULL, sex_at_birth = NULL, gender_identity = NULL, phone_e164 = NULL,
                email = NULL, address = NULL, photo_document_id = NULL, preferred_pharmacy = NULL WHERE id = $1`;
    await assert.rejects(
      t.k.sa.query(complete, [live.patientId]),
      /a purged patient is set and changed only by the retention purge/,
    );
    // The worker may not write it either: no UPDATE right on the patient row at all.
    await assert.rejects(
      t.worker.withScope(sysScope([live.patientId]), (tx) => tx.query(complete, [live.patientId])),
      /permission denied|row-level security/,
    );
    assert.equal(
      (await row(`SELECT status FROM patient.patient WHERE id = $1`, [live.patientId]))['status'],
      'active',
    );

    // The documentation (request, deletion record) is kept 6 years after the purge; then it goes, and the tombstone after it.
    assert.equal(
      await n(`SELECT count(*)::int AS n FROM patient.patient WHERE id = $1`, [p.patientId]),
      1,
    );
    await t.seed(
      `UPDATE privacy.deletion_record SET purged_at = $2::timestamptz WHERE request_id = $1`,
      [req, yearsAgo(7).toISOString()],
    );
    await t.seed(`UPDATE privacy.request SET decided_at = $2::timestamptz WHERE id = $1`, [
      req,
      yearsAgo(7).toISOString(),
    ]);
    const rep = await t.w.retentionPurge();
    assert.equal(rep.classes.hipaa_documentation.removed['privacy.deletion_record'], 1);
    assert.equal(rep.classes.hipaa_documentation.removed['patient.patient_tombstone'], 1);
    assert.equal(
      await n(`SELECT count(*)::int AS n FROM patient.patient WHERE id = $1`, [p.patientId]),
      0,
    );
    assert.deepEqual(nonZero(await leftovers(p, l)), []);
  });
});
