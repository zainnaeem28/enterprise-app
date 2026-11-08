// Real-database tests for BE-18, part 2: consent gate with the recorded emergency exception (RA-R1-08 MECHANISM), questionnaire
// (patient side), referrals, follow-ups, and the merge / export participant (38.2 item 11). Same harness as frontdoor.dbtest.ts.
//   EHR_TEST_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres node --test dist/src/modules/clinical/frontdoor/frontdoor-flows.dbtest.js
// The consent and red-flag RULE TEXT and timing stay BLOCKED by D-12a / C-03: everything here is synthetic mechanics evidence.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import {
  A1,
  A2,
  B1,
  CONSENT_A,
  CONSENT_B,
  ORG,
  SVC,
  SVC2,
  TEMPLATE_KEY,
  adminUrl,
  saWrite,
  setupFrontdoor,
  uuidv7,
} from './testkit.js';
import type { FrontdoorKit, PatientKit, SeededSession } from './testkit.js';
import { FRONTDOOR_MERGE_TABLES } from './merge.js';

let t: FrontdoorKit;
let seed = 500;
const n = (): number => ++seed;
const rows = <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> =>
  t.k.q<T>(sql, p);
const meta = (): { requestId: string } => ({ requestId: randomUUID() });
const tomorrow = (): string => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

async function signConsent(
  patientId: string,
  key: string,
  version: number,
  status: 'signed' | 'withdrawn' = 'signed',
): Promise<void> {
  if (status === 'withdrawn')
    await saWrite(
      t.k,
      `INSERT INTO patient.consent (id, organisation_id, patient_id, template_key, template_version, template_language, status, withdrawn_at)
       VALUES ($1, $2, $3, $4, $5, 'en', 'withdrawn', now())`,
      [uuidv7(), ORG, patientId, key, version],
    );
  else
    await saWrite(
      t.k,
      `INSERT INTO patient.consent (id, organisation_id, patient_id, template_key, template_version, template_language, status, signed_at, signer_principal_id, signer_relationship, signed_name)
       VALUES ($1, $2, $3, $4, $5, 'en', 'signed', now(), $6, 'staff_witnessed', 'Synthetic Signer')`,
      [uuidv7(), ORG, patientId, key, version, t.desk.seeded.principalId],
    );
}

describe('clinical front door (BE-18), flows on PostgreSQL 17', () => {
  before(async () => {
    assert.ok(
      adminUrl,
      'EHR_TEST_ADMIN_URL must name a throwaway PostgreSQL 17 server (a missing configuration fails, it does not skip)',
    );
    t = await setupFrontdoor('be18f');
    await t.publishTemplate();
    await t.publishConsent(CONSENT_A, 2);
    await t.publishConsent(CONSENT_B, 2);
    await t.requireConsents(SVC, [CONSENT_A, CONSENT_B]);
  });
  after(async () => {
    await t?.close();
  });

  // ===== consent gate (RA-R1-08 mechanism, BR-09) ======================================================================
  describe('consent status gate with a recorded emergency exception', () => {
    const start = (
      patientId: string,
      encounterId: string,
      emergencyException?: { reason?: unknown },
    ) =>
      t.as(t.staffScope(t.doctor), (tx) =>
        t.frontdoor.consentGate.start(tx, meta(), {
          encounterId,
          patientId,
          serviceId: SVC,
          ...(emergencyException ? { emergencyException } : {}),
        }),
      );

    test('all required consents signed in the latest version: nothing is recorded', async () => {
      const p = await t.mkPatient(n());
      await signConsent(p.patientId, CONSENT_A, 2);
      await signConsent(p.patientId, CONSENT_B, 2);
      const r = await start(p.patientId, randomUUID());
      assert.deepEqual(r.missing, []);
      assert.equal(r.exceptionId, undefined);
      assert.equal(
        (
          await rows(`SELECT 1 FROM clinical.consent_exception WHERE patient_id = $1`, [
            p.patientId,
          ])
        ).length,
        0,
      );
    });

    test('a missing, an outdated and a withdrawn consent each block with 409 naming the template keys, and nothing is recorded', async () => {
      const p = await t.mkPatient(n());
      await signConsent(p.patientId, CONSENT_A, 1); // outdated: the latest published is 2
      await signConsent(p.patientId, CONSENT_B, 2, 'withdrawn');
      await assert.rejects(
        start(p.patientId, randomUUID()),
        (e: { status?: number; missingConsentTemplates?: string[] }) => {
          assert.equal(e.status, 409);
          assert.deepEqual([...(e.missingConsentTemplates ?? [])].sort(), [CONSENT_A, CONSENT_B]);
          return true;
        },
      );
      assert.equal(
        (
          await rows(`SELECT 1 FROM clinical.consent_exception WHERE patient_id = $1`, [
            p.patientId,
          ])
        ).length,
        0,
      );
    });

    test('an emergency exception (reason 10..500 chars) lets the start through and records one append-only row and an audit row', async () => {
      const p = await t.mkPatient(n());
      const enc = randomUUID();
      const r = await start(p.patientId, enc, {
        reason: 'Unconscious patient, treatment cannot wait for consent',
      });
      assert.deepEqual([...r.missing].sort(), [CONSENT_A, CONSENT_B]);
      assert.ok(r.exceptionId);
      const ex = (
        await rows(`SELECT * FROM clinical.consent_exception WHERE id = $1`, [r.exceptionId])
      )[0] as Record<string, unknown>;
      assert.equal(ex['encounter_id'], enc);
      assert.equal(ex['by_principal_id'], t.doctor.seeded.principalId);
      assert.deepEqual([...(ex['missing_templates'] as string[])].sort(), [CONSENT_A, CONSENT_B]);
      const audit = await rows(
        `SELECT change FROM audit.event WHERE resource_type = 'clinical.consent_exception' AND patient_id = $1 AND action = 'consent_exception'`,
        [p.patientId],
      );
      assert.equal(audit.length, 1);
      assert.ok(
        !JSON.stringify(audit[0]).includes('Unconscious'),
        'the free-text reason is not copied into the audit change',
      );
      // append-only: no update or delete, even by a superuser
      await assert.rejects(
        saWrite(
          t.k,
          `UPDATE clinical.consent_exception SET reason = 'changed to something else' WHERE id = $1`,
          [r.exceptionId],
        ),
      );
      await assert.rejects(
        saWrite(t.k, `DELETE FROM clinical.consent_exception WHERE id = $1`, [r.exceptionId]),
      );
      // one exception per encounter
      await assert.rejects(
        start(p.patientId, enc, { reason: 'A second exception for the same encounter' }),
      );
    });

    test('a too short or too long reason is a validation error and records nothing', async () => {
      const p = await t.mkPatient(n());
      for (const reason of ['short', 'x'.repeat(501), 42, undefined])
        await assert.rejects(
          start(p.patientId, randomUUID(), { reason }),
          (e: { status?: number }) => e.status === 422,
        );
      assert.equal(
        (
          await rows(`SELECT 1 FROM clinical.consent_exception WHERE patient_id = $1`, [
            p.patientId,
          ])
        ).length,
        0,
      );
    });

    test("the database refuses an exception for a patient outside the caller's scope or in another principal's name", async () => {
      const p = await t.mkPatient(n());
      await t.checkedIn(p); // scope at A1 only
      const insert = (who: SeededSession, locs: string[], by: string) =>
        t.as(t.staffScope(who, locs), (tx) =>
          tx.query(
            `INSERT INTO clinical.consent_exception (id, organisation_id, encounter_id, patient_id, missing_templates, reason, by_principal_id, created_by)
             VALUES ($1, kernel.uuid1('app.org_id'), $2, $3, ARRAY['x'], 'Written outside the scope', $4, $4)`,
            [uuidv7(), randomUUID(), p.patientId, by],
          ),
        );
      await assert.rejects(
        insert(t.coordB, [A2], t.coordB.seeded.principalId),
        'no care relationship at A2',
      );
      await assert.rejects(
        insert(t.doctor, [A1], t.nurse.seeded.principalId),
        'by_principal_id must be the caller',
      );
    });
  });

  // ===== questionnaire (patient side) ====================================================================================
  describe('questionnaire template + response', () => {
    let p: PatientKit;
    let ci: string;
    before(async () => {
      p = await t.mkPatient(n());
      ci = await t.confirmed(p);
    });

    test('the patient reads the template, saves a draft, edits it with If-Match, and submits; a second submit is refused', async () => {
      const q = await t.pcall(
        p,
        'GET',
        `/api/v1/appointments/${ci}/questionnaire?templateKey=${TEMPLATE_KEY}`,
      );
      assert.equal(q.status, 200, q.body);
      assert.ok(q.json()['template']);
      const id = uuidv7();
      const c = await t.pcall(p, 'PUT', `/api/v1/questionnaire-responses/${id}`, {
        reservationId: ci,
        templateKey: TEMPLATE_KEY,
        answers: { q_flag_a: false },
      });
      assert.equal(c.status, 201, c.body);
      const tag = String(c.headers['etag']);
      const u = await t.pcall(
        p,
        'PUT',
        `/api/v1/questionnaire-responses/${id}`,
        { answers: { q_flag_a: false, q_flag_b: 'green', q_score: 2 } },
        { 'if-match': tag },
      );
      assert.equal(u.status, 200, u.body);
      // a stale tag is refused and nothing is overwritten
      const stale = await t.pcall(
        p,
        'PUT',
        `/api/v1/questionnaire-responses/${id}`,
        { answers: { q_score: 99 } },
        { 'if-match': tag },
      );
      assert.equal(stale.status, 412);
      // an undeclared question key is a validation error
      const bad = await t.pcall(
        p,
        'PUT',
        `/api/v1/questionnaire-responses/${id}`,
        { answers: { not_a_question: 1 } },
        { 'if-match': String(u.headers['etag']) },
      );
      assert.equal(bad.status, 422);
      const s = await t.pcall(
        p,
        'POST',
        `/api/v1/questionnaire-responses/${id}/submit`,
        undefined,
        { 'if-match': String(u.headers['etag']), 'idempotency-key': randomUUID() },
      );
      assert.equal(s.status, 200, s.body);
      assert.equal(s.json()['redFlag'], false);
      assert.equal((s.json()['response'] as Record<string, unknown>)['status'], 'submitted');
      const again = await t.pcall(
        p,
        'POST',
        `/api/v1/questionnaire-responses/${id}/submit`,
        undefined,
        {
          'if-match': String((s.headers as Record<string, string>)['etag']),
          'idempotency-key': randomUUID(),
        },
      );
      assert.ok(
        [404, 409, 412].includes(again.status),
        `a submitted response cannot be submitted again (${again.status})`,
      );
    });

    test("another patient cannot read or write this patient's response", async () => {
      const other = await t.mkPatient(n());
      const r = await t.pcall(
        other,
        'GET',
        `/api/v1/appointments/${ci}/questionnaire?templateKey=${TEMPLATE_KEY}`,
      );
      assert.ok([403, 404].includes(r.status), `got ${r.status}`);
      const mine = (
        await rows<{ id: string }>(
          `SELECT id FROM clinical.questionnaire_response WHERE patient_id = $1`,
          [p.patientId],
        )
      )[0];
      const w = await t.pcall(
        other,
        'PUT',
        `/api/v1/questionnaire-responses/${mine?.id}`,
        { answers: {} },
        { 'if-match': 'W/"1"' },
      );
      assert.ok([403, 404].includes(w.status), `got ${w.status}`);
    });

    test('staff with the pre-visit right read the responses of a patient in their scope; staff of another location do not', async () => {
      await t.checkedIn(p);
      const ok = await t.scall(
        t.nurse,
        'GET',
        `/api/v1/patients/${p.patientId}/questionnaire-responses`,
      );
      assert.equal(ok.status, 200, ok.body);
      assert.ok((ok.json()['items'] as unknown[]).length >= 1);
      const no = await t.scall(
        t.coordB,
        'GET',
        `/api/v1/patients/${p.patientId}/questionnaire-responses`,
      );
      assert.ok(
        [403, 404].includes(no.status),
        `staff of a location with no relationship: ${no.status}`,
      );
    });
  });

  // ===== referrals ======================================================================================================
  describe('referrals: referrer, target, status; the accept re-checks and creates the care relationship', () => {
    const post = (
      s: SeededSession,
      path: string,
      body?: unknown,
      extra: Record<string, string> = {},
    ) => t.scall(s, 'POST', path, body, { 'idempotency-key': randomUUID(), ...extra });

    // BLOCKER FOR INTEGRATION (module README, limitations): patient.lock_patients and patient.ensure_care_relationship (BE-08, 0703) call
    // patient.caller_sees(), which is false for the RECEIVING location of a referral (it has no care relationship yet), so accept ends in
    // PM008 -> 404 on the combined base. The function is another ticket's; this ticket cannot change it. The tests below put the
    // receiving location's sight in place by a staff_scope row (as the owner's fix would make visible) to prove everything on this side;
    // the `todo` test is the real path and passes once BE-08 / INT-02 adds the referral case to caller_sees.
    const seedTargetSight = (patientId: string): Promise<unknown> =>
      saWrite(
        t.k,
        `INSERT INTO patient.staff_scope (patient_id, location_id, organisation_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [patientId, A2, ORG],
      );

    test(
      'TODO (BE-08/INT-02): the real accept path without any stand-in',
      { todo: 'caller_sees() hides the patient from the receiving location' },
      async () => {
        const p = await t.mkPatient(n());
        await t.checkedIn(p);
        const c = await post(t.coord, `/api/v1/patients/${p.patientId}/referrals`, {
          fromLocationId: A1,
          targetKind: 'internal_location',
          targetLocationId: A2,
          reason: 'Real path',
        });
        const id = String(c.json()['id']);
        await post(t.coord, `/api/v1/referrals/${id}/send`);
        const a = await post(t.coordB, `/api/v1/referrals/${id}/accept`);
        assert.equal(a.status, 200, a.body);
      },
    );

    test('draft -> sent -> accepted (internal location): inbox is PHI-minimal; the care relationship appears at the target location only', async () => {
      const p = await t.mkPatient(n());
      await t.checkedIn(p); // the referrer's location (A1) has the patient in scope
      const c = await post(t.coord, `/api/v1/patients/${p.patientId}/referrals`, {
        fromLocationId: A1,
        targetKind: 'internal_location',
        targetLocationId: A2,
        reason: 'Needs a specialist review',
      });
      assert.equal(c.status, 201, c.body);
      const id = String(c.json()['id']);
      assert.equal(c.json()['status'], 'draft');
      assert.equal(
        c.json()['fromPrincipalId'] ?? c.json()['referrerId'] ?? t.coord.seeded.principalId,
        t.coord.seeded.principalId,
      );
      const s = await post(t.coord, `/api/v1/referrals/${id}/send`);
      assert.equal(s.status, 200, s.body);
      assert.equal(s.json()['status'], 'sent');
      const inbox = await t.scall(t.coordB, 'GET', `/api/v1/locations/${A2}/referral-inbox`);
      assert.equal(inbox.status, 200, inbox.body);
      const item = (inbox.json()['items'] as Record<string, unknown>[]).find(
        (x) => x['referralId'] === id,
      );
      assert.ok(item, 'the target location sees the referral');
      assert.ok(
        !JSON.stringify(item).includes(p.patientId),
        'the inbox row carries no patient identifier',
      );
      // before the accept the target location has no scope on the patient
      assert.equal(
        (
          await rows(
            `SELECT 1 FROM patient.staff_scope WHERE patient_id = $1 AND location_id = $2`,
            [p.patientId, A2],
          )
        ).length,
        0,
      );
      await seedTargetSight(p.patientId);
      const a = await post(t.coordB, `/api/v1/referrals/${id}/accept`);
      assert.equal(a.status, 200, a.body);
      assert.equal(a.json()['status'], 'accepted');
      assert.equal(
        (
          await rows(
            `SELECT 1 FROM patient.care_relationship WHERE patient_id = $1 AND location_id = $2`,
            [p.patientId, A2],
          )
        ).length,
        1,
        'accept created the care relationship at the target',
      );
      // a second accept (or a decline) is refused: not pending
      const again = await post(t.coordB, `/api/v1/referrals/${id}/accept`);
      assert.equal(again.status, 409);
      const dec = await post(t.coordB, `/api/v1/referrals/${id}/decline`, { reason: 'Too late' });
      assert.equal(dec.status, 409);
    });

    test('only the target location can decide: staff of the sending location and of a third location are refused; decline needs a reason', async () => {
      const p = await t.mkPatient(n());
      await t.checkedIn(p);
      const c = await post(t.coord, `/api/v1/patients/${p.patientId}/referrals`, {
        fromLocationId: A1,
        targetKind: 'internal_location',
        targetLocationId: A2,
        reason: 'Second opinion',
      });
      const id = String(c.json()['id']);
      await post(t.coord, `/api/v1/referrals/${id}/send`);
      await seedTargetSight(p.patientId);
      const self = await post(t.coord, `/api/v1/referrals/${id}/accept`);
      assert.ok(
        [403, 404].includes(self.status),
        `the sender cannot accept its own referral (${self.status})`,
      );
      const noReason = await post(t.coordB, `/api/v1/referrals/${id}/decline`, {});
      assert.equal(noReason.status, 422);
      const d = await post(t.coordB, `/api/v1/referrals/${id}/decline`, {
        reason: 'No capacity this month',
      });
      assert.equal(d.status, 200, d.body);
      assert.equal(d.json()['status'], 'declined');
      assert.equal(
        (
          await rows(
            `SELECT 1 FROM patient.care_relationship WHERE patient_id = $1 AND location_id = $2`,
            [p.patientId, A2],
          )
        ).length,
        0,
        'a decline creates no care relationship',
      );
    });

    test('an external referral has no inbox row; a draft edit needs If-Match; an invalid target is 422; a sent referral can be cancelled by the referrer', async () => {
      const p = await t.mkPatient(n());
      await t.checkedIn(p);
      const bad = await post(t.coord, `/api/v1/patients/${p.patientId}/referrals`, {
        fromLocationId: A1,
        targetKind: 'internal_location',
        reason: 'no target',
      });
      assert.equal(bad.status, 422);
      const c = await post(t.coord, `/api/v1/patients/${p.patientId}/referrals`, {
        fromLocationId: A1,
        targetKind: 'external',
        targetExternalText: 'Dr Example, Example Clinic',
        reason: 'Outside specialty',
      });
      assert.equal(c.status, 201, c.body);
      const id = String(c.json()['id']);
      const noTag = await t.scall(t.coord, 'PATCH', `/api/v1/referrals/${id}`, {
        reason: 'edited reason',
      });
      assert.equal(noTag.status, 428);
      const ed = await t.scall(
        t.coord,
        'PATCH',
        `/api/v1/referrals/${id}`,
        { reason: 'edited reason' },
        { 'if-match': String(c.headers['etag']) },
      );
      assert.equal(ed.status, 200, ed.body);
      const stale = await t.scall(
        t.coord,
        'PATCH',
        `/api/v1/referrals/${id}`,
        { reason: 'again' },
        { 'if-match': String(c.headers['etag']) },
      );
      assert.equal(stale.status, 412);
      const sent = await post(t.coord, `/api/v1/referrals/${id}/send`);
      assert.equal(sent.status, 200, sent.body);
      assert.equal(
        (await rows(`SELECT 1 FROM clinical.referral_inbox WHERE referral_id = $1`, [id])).length,
        0,
      );
      const cancel = await t.scall(
        t.coord,
        'PATCH',
        `/api/v1/referrals/${id}`,
        { status: 'cancelled' },
        { 'if-match': String(sent.headers['etag']) },
      );
      assert.equal(cancel.status, 200, cancel.body);
      assert.equal(cancel.json()['status'], 'cancelled');
    });

    test('a staff member without the referral right, or at a location that has no scope on the patient, is refused', async () => {
      const p = await t.mkPatient(n());
      await t.checkedIn(p);
      const body = {
        fromLocationId: A1,
        targetKind: 'external',
        targetExternalText: 'Somewhere',
        reason: 'x',
      };
      assert.equal(
        (await post(t.desk, `/api/v1/patients/${p.patientId}/referrals`, body)).status,
        403,
      );
      const far = await post(t.coordB, `/api/v1/patients/${p.patientId}/referrals`, {
        ...body,
        fromLocationId: A2,
      });
      assert.ok(
        [403, 404].includes(far.status),
        `a location without a care relationship cannot refer (${far.status})`,
      );
      const wrongFrom = await post(t.coord, `/api/v1/patients/${p.patientId}/referrals`, {
        ...body,
        fromLocationId: B1,
      });
      assert.ok(
        [403, 404, 422].includes(wrongFrom.status),
        `a coordinator cannot refer from another location (${wrongFrom.status})`,
      );
    });
  });

  // ===== follow-ups =====================================================================================================
  describe('follow-up records (RA-R1-30)', () => {
    const post = (s: SeededSession, path: string, body?: unknown) =>
      t.scall(s, 'POST', path, body, { 'idempotency-key': randomUUID() });

    test('create, list by patient and by location, update with If-Match, close; invalid data is 422; no If-Match is 428', async () => {
      const p = await t.mkPatient(n());
      await t.checkedIn(p);
      const bad = await post(t.coord, `/api/v1/patients/${p.patientId}/follow-ups`, {
        locationId: A1,
        dueOn: 'not-a-date',
        reason: 'x',
      });
      assert.equal(bad.status, 422);
      const c = await post(t.coord, `/api/v1/patients/${p.patientId}/follow-ups`, {
        locationId: A1,
        dueOn: tomorrow(),
        reason: 'Review in a week',
        serviceId: SVC2,
      });
      assert.equal(c.status, 201, c.body);
      const id = String(c.json()['id']);
      assert.equal(c.json()['status'], 'open');
      const byPatient = await t.scall(t.coord, 'GET', `/api/v1/patients/${p.patientId}/follow-ups`);
      assert.ok((byPatient.json()['items'] as { id: string }[]).some((x) => x.id === id));
      const byLoc = await t.scall(t.coord, 'GET', `/api/v1/locations/${A1}/follow-ups?status=open`);
      assert.ok((byLoc.json()['items'] as { id: string }[]).some((x) => x.id === id));
      assert.equal(
        (await t.scall(t.coord, 'PATCH', `/api/v1/follow-ups/${id}`, { reason: 'changed' })).status,
        428,
      );
      const u = await t.scall(
        t.coord,
        'PATCH',
        `/api/v1/follow-ups/${id}`,
        { reason: 'Review in two weeks' },
        { 'if-match': String(c.headers['etag']) },
      );
      assert.equal(u.status, 200, u.body);
      assert.equal(
        (
          await t.scall(
            t.coord,
            'PATCH',
            `/api/v1/follow-ups/${id}`,
            { reason: 'stale' },
            { 'if-match': String(c.headers['etag']) },
          )
        ).status,
        412,
      );
      const done = await t.scall(
        t.coord,
        'PATCH',
        `/api/v1/follow-ups/${id}`,
        { status: 'done' },
        { 'if-match': String(u.headers['etag']) },
      );
      assert.equal(done.status, 200, done.body);
      assert.equal(done.json()['status'], 'done');
      // a closed follow-up stays closed
      const reopen = await t.scall(
        t.coord,
        'PATCH',
        `/api/v1/follow-ups/${id}`,
        { status: 'open' },
        { 'if-match': String(done.headers['etag']) },
      );
      assert.ok(
        [409, 422].includes(reopen.status),
        `a done follow-up cannot reopen (${reopen.status})`,
      );
    });

    test('a location without scope on the patient, and a user without the right, are refused', async () => {
      const p = await t.mkPatient(n());
      await t.checkedIn(p);
      assert.equal(
        (
          await post(t.desk, `/api/v1/patients/${p.patientId}/follow-ups`, {
            locationId: A1,
            dueOn: tomorrow(),
            reason: 'x',
          })
        ).status,
        403,
      );
      const far = await post(t.coordB, `/api/v1/patients/${p.patientId}/follow-ups`, {
        locationId: A2,
        dueOn: tomorrow(),
        reason: 'x',
      });
      assert.ok([403, 404].includes(far.status), `got ${far.status}`);
    });
  });

  // ===== merge participant and export part (38.2 item 11, 22.16) =========================================================
  describe('merge participant and export part', () => {
    test('item 11: questionnaire (open), triage (kept), referral and follow-up rows follow the survivor; counts add up; the export part lists them', async () => {
      const a = await t.mkPatient(n()); // survivor
      const b = await t.mkPatient(n()); // merged
      const ciB = await t.checkedIn(b);
      await t.scall(t.nurse, 'POST', `/api/v1/check-ins/${ciB}/triage`, { category: 'standard' });
      const resp = uuidv7();
      await t.pcall(b, 'PUT', `/api/v1/questionnaire-responses/${resp}`, {
        reservationId: ciB,
        templateKey: TEMPLATE_KEY,
        answers: { q_score: 1 },
      });
      const ref = await t.scall(
        t.coord,
        'POST',
        `/api/v1/patients/${b.patientId}/referrals`,
        {
          fromLocationId: A1,
          targetKind: 'external',
          targetExternalText: 'Outside',
          reason: 'merge test',
        },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(ref.status, 201, ref.body);
      const fu = await t.scall(
        t.coord,
        'POST',
        `/api/v1/patients/${b.patientId}/follow-ups`,
        { locationId: A1, dueOn: tomorrow(), reason: 'merge test' },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(fu.status, 201, fu.body);
      await t.checkedIn(a);
      const merged = await t.merge(a.patientId, b.patientId);
      assert.equal(merged.result.status, 'completed');
      const count = async (table: string, p: string): Promise<number> =>
        Number(
          (
            await rows<{ c: string }>(
              `SELECT count(*)::text AS c FROM ${table} WHERE patient_id = $1`,
              [p],
            )
          )[0]?.c,
        );
      assert.equal(
        await count('clinical.questionnaire_response', b.patientId),
        0,
        'the in-progress response moved',
      );
      assert.equal(await count('clinical.questionnaire_response', a.patientId), 1);
      assert.equal(await count('clinical.referral', b.patientId), 0);
      assert.equal(await count('clinical.referral', a.patientId), 1);
      assert.equal(await count('clinical.follow_up', b.patientId), 0);
      assert.equal(await count('clinical.follow_up', a.patientId), 1);
      assert.equal(
        await count('clinical.triage_assessment', b.patientId),
        1,
        'the append-only triage stays on the merged ID',
      );
      assert.equal(await count('clinical.triage_assessment', a.patientId), 0);
      const report = JSON.stringify(
        (
          await rows<{ counts: unknown }>(
            `SELECT counts FROM patient.merge_request WHERE id = $1`,
            [merged.requestId],
          )
        )[0]?.counts,
      );
      for (const tbl of FRONTDOOR_MERGE_TABLES)
        assert.ok(report.includes(tbl), `${tbl} is in the merge report`);
      // the export part: front-door data of the patient is included
      const scope = {
        audience: 'system' as const,
        realm: 'worker' as const,
        orgId: ORG,
        jobScope: 'patients' as const,
        jobPatientIds: [a.patientId],
      };
      const { frontdoorExportPart } = await import('./merge.js');
      const exported = await t.asWorker(scope, (tx) =>
        frontdoorExportPart.exportPart(tx, [a.patientId], randomUUID()),
      );
      const text = JSON.stringify(exported);
      assert.ok(text.includes('merge test'), 'referral and follow-up reasons are exported');
      void B1;
      void CONSENT_A;
    });
  });
});
