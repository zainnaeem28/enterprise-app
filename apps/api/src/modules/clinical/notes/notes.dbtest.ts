// Real-database tests for BE-17 (clinical notes: encounters, SOAP notes, sign and lock, addenda, co-sign) on PostgreSQL 17 with the
// real roles, migrations (1800-1802), RLS, queue, identity guard, sessions, alert service and booking/flow services, and a real HTTP
// server: TC-CL-01..07 (RA-R1-09, BR-11, BR-12, BQ-8, AC-10, AC-11, CN-07), the encounter start and completion (ST-01, BR-09), the
// reminder (33.1) and the merge participant and export part (38.2 item 11). Synthetic data only.
//   EHR_TEST_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres node --test dist/src/modules/clinical/notes/notes.dbtest.js
// The URL names a superuser on a throwaway server. Missing configuration FAILS; nothing skips.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { A1, A2, CONSENT_A, ORG, SVC2, adminUrl, setupNotes, staffMember } from './testkit.js';
import type { NotesKit, PatientKit, SeededSession } from './testkit.js';
import { authoredSource } from './assignment.js';
import { NOTES_MERGE_TABLES } from './merge.js';

let t: NotesKit;
let seed = 500;
const n = (): number => ++seed;

const rows = <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> =>
  t.k.q<T>(sql, p);
const one = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T> => {
  const r = (await rows<T>(sql, p))[0];
  assert.ok(r !== undefined, `no row for ${sql}`);
  return r;
};
const ifm = (v: unknown): Record<string, string> => ({ 'if-match': `W/"${String(v)}"` });
const code = (r: { json(): Record<string, unknown> }): unknown => r.json()['code'];
const SECTIONS = {
  subjective: 'SYNTHETIC-S headache for two days',
  objective: 'SYNTHETIC-O temp normal',
};

type Doc = Record<string, unknown>;

describe('clinical notes (BE-17) on PostgreSQL 17', () => {
  let doctor: SeededSession;
  const consultAs = async (
    by: SeededSession = doctor,
  ): Promise<{ p: PatientKit; reservationId: string; encounterId: string }> => {
    const p = await t.mkPatient(n());
    return { p, ...(await t.consult(p, by)) };
  };
  const draft = async (encounterId: string, by: SeededSession = doctor): Promise<Doc> => {
    const r = await t.scall(by, 'POST', `/api/v1/encounters/${encounterId}/notes`, {});
    assert.equal(r.status, 201, r.body);
    return r.json();
  };
  const signed = async (encounterId: string, by: SeededSession = doctor): Promise<Doc> => {
    const d = await draft(encounterId, by);
    const s = await t.scall(
      by,
      'POST',
      `/api/v1/notes/${String(d['id'])}/sign`,
      undefined,
      ifm(d['version']),
    );
    assert.equal(s.status, 200, s.body);
    return s.json();
  };
  const hash = async (id: string): Promise<string> =>
    (await one<{ h: string }>(`SELECT md5(n::text) AS h FROM clinical.note n WHERE id = $1`, [id]))
      .h;

  before(async () => {
    assert.ok(
      adminUrl,
      'EHR_TEST_ADMIN_URL must name a throwaway PostgreSQL 17 server (a missing configuration fails, it does not skip)',
    );
    t = await setupNotes('be17');
    doctor = t.doctor;
    await t.publishConsent(CONSENT_A, 1);
  });
  after(async () => {
    await t?.close();
  });

  // ===== encounters (ST-01, BR-09) =====================================================================================
  describe('encounter start and completion', () => {
    test('start: the visit must be checked in, the caller must be its clinician; the occupancy moves to in_consultation; a second start is refused', async () => {
      const p = await t.mkPatient(n());
      const confirmedOnly = await t.confirmed(p, undefined, doctor);
      const early = await t.scall(doctor, 'POST', '/api/v1/encounters', {
        reservationId: confirmedOnly,
      });
      assert.equal(early.status, 409, early.body);
      assert.equal(code(early), 'clinical.invalid_transition');

      const rid = await t.checkedIn(p, { clinician: doctor });
      const other = await t.scall(t.doctor2, 'POST', '/api/v1/encounters', { reservationId: rid });
      assert.equal(other.status, 403, "another doctor is not the visit's clinician");
      const desk = await t.scall(t.desk, 'POST', '/api/v1/encounters', { reservationId: rid });
      assert.equal(desk.status, 403, 'the front desk holds no clinical.consultation.start');
      assert.equal(
        (await one(`SELECT status FROM scheduling.slot_occupancy WHERE id = $1`, [rid]))['status'],
        'checked_in',
      );

      const key = randomUUID();
      const ok = await t.scall(
        doctor,
        'POST',
        '/api/v1/encounters',
        { reservationId: rid },
        { 'idempotency-key': key },
      );
      assert.equal(ok.status, 201, ok.body);
      const e = ok.json();
      assert.equal(e['status'], 'in_consultation');
      assert.equal(e['clinicianPrincipalId'], doctor.seeded.principalId);
      assert.equal(e['reservationId'], rid);
      assert.ok(e['patientBanner'], 'x-banner: the patient banner is in the response');
      assert.equal(e['consentExceptionId'], null);
      assert.ok(ok.headers['etag']);
      assert.equal(
        (await one(`SELECT status FROM scheduling.slot_occupancy WHERE id = $1`, [rid]))['status'],
        'in_consultation',
      );
      const replay = await t.scall(
        doctor,
        'POST',
        '/api/v1/encounters',
        { reservationId: rid },
        { 'idempotency-key': key },
      );
      assert.equal(replay.status, 201);
      assert.equal(replay.headers['idempotent-replay'], 'true');
      assert.equal(replay.json()['id'], e['id']);
      const again = await t.scall(doctor, 'POST', '/api/v1/encounters', { reservationId: rid });
      assert.equal(again.status, 409, 'a second start (new key) is refused');
      assert.equal(
        Number(
          (
            await one(
              `SELECT count(*)::int AS c FROM clinical.encounter WHERE reservation_id = $1`,
              [rid],
            )
          )['c'],
        ),
        1,
      );
      const aud = await rows(
        `SELECT change FROM audit.event WHERE resource_type = 'clinical.encounter' AND resource_id = $1 AND action = 'create'`,
        [e['id']],
      );
      assert.equal(aud.length, 1);
    });

    test('consent gate (BR-09): missing required consent refuses and writes nothing; an emergency exception with a reason starts and is recorded once', async () => {
      await t.requireConsents(SVC2, [CONSENT_A]);
      const p = await t.mkPatient(n());
      const rid = await t.checkedIn(p, { clinician: doctor, serviceId: SVC2 });
      const refused = await t.scall(doctor, 'POST', '/api/v1/encounters', { reservationId: rid });
      assert.equal(refused.status, 409, refused.body);
      assert.equal(code(refused), 'clinical.consents_missing');
      assert.ok(refused.body.includes(CONSENT_A), 'the missing template KEY is named');
      assert.equal(
        Number(
          (
            await one(
              `SELECT count(*)::int AS c FROM clinical.encounter WHERE reservation_id = $1`,
              [rid],
            )
          )['c'],
        ),
        0,
        'nothing was written',
      );
      assert.equal(
        (await one(`SELECT status FROM scheduling.slot_occupancy WHERE id = $1`, [rid]))['status'],
        'checked_in',
      );
      const short = await t.scall(doctor, 'POST', '/api/v1/encounters', {
        reservationId: rid,
        emergencyException: { reason: 'too short' },
      });
      assert.equal(short.status, 422);
      const ok = await t.scall(doctor, 'POST', '/api/v1/encounters', {
        reservationId: rid,
        emergencyException: { reason: 'Synthetic emergency: patient unable to sign' },
      });
      assert.equal(ok.status, 201, ok.body);
      assert.ok(ok.json()['consentExceptionId']);
      const ex = await rows(
        `SELECT missing_templates, encounter_id FROM clinical.consent_exception WHERE encounter_id = $1`,
        [ok.json()['id']],
      );
      assert.equal(ex.length, 1);
      assert.deepEqual(ex[0]?.['missing_templates'], [CONSENT_A]);
      await rows(`DELETE FROM organisation.service_required_consent WHERE service_id = $1`, [SVC2]);
    });

    test('complete: refused without a note or a deferral (note_unsigned); If-Match 428/412; a deferral completes, moves the occupancy and schedules the 24 h reminder', async () => {
      const { p, reservationId, encounterId } = await consultAs();
      const e0 = await one<{ row_version: string }>(
        `SELECT row_version FROM clinical.encounter WHERE id = $1`,
        [encounterId],
      );
      const path = `/api/v1/encounters/${encounterId}/complete`;
      const noMatch = await t.scall(doctor, 'POST', path, {});
      assert.equal(noMatch.status, 428, noMatch.body);
      assert.equal(code(noMatch), 'kernel.precondition_required');
      const stale = await t.scall(doctor, 'POST', path, {}, ifm(Number(e0.row_version) + 5));
      assert.equal(stale.status, 412);
      const unsigned = await t.scall(doctor, 'POST', path, {}, ifm(e0.row_version));
      assert.equal(unsigned.status, 409, unsigned.body);
      assert.equal(code(unsigned), 'clinical.note_unsigned');
      const shortReason = await t.scall(
        doctor,
        'POST',
        path,
        { deferNoteReason: 'short' },
        ifm(e0.row_version),
      );
      assert.equal(shortReason.status, 422);
      const other = await t.scall(
        t.doctor2,
        'POST',
        path,
        { deferNoteReason: 'Synthetic deferral by another doctor' },
        ifm(e0.row_version),
      );
      assert.equal(other.status, 403, "only the encounter's clinician completes it");
      const done = await t.scall(
        doctor,
        'POST',
        path,
        { deferNoteReason: 'Synthetic: note written after clinic' },
        ifm(e0.row_version),
      );
      assert.equal(done.status, 200, done.body);
      assert.equal(done.json()['status'], 'completed');
      assert.equal(done.json()['noteDeferredReason'], 'Synthetic: note written after clinic');
      assert.equal(
        (await one(`SELECT status FROM scheduling.slot_occupancy WHERE id = $1`, [reservationId]))[
          'status'
        ],
        'completed',
      );
      const job = await one<{ run_at: Date; payload: Record<string, unknown> }>(
        `SELECT j.run_at, j.payload FROM queue._private_jobs j JOIN queue._private_tasks tk ON tk.id = j.task_id
          WHERE tk.identifier = 'clinical.note_sign_reminder' AND j.payload->>'encounterId' = $1`,
        [encounterId],
      );
      const ended = new Date(String(done.json()['endedAt'])).getTime();
      assert.ok(
        Math.abs(job.run_at.getTime() - (ended + 24 * 3_600_000)) < 1500,
        'the reminder is due 24 h after the encounter',
      );
      assert.deepEqual(Object.keys(job.payload).sort(), ['encounterId', 'patientId']);
      assert.equal(job.payload['patientId'], p.patientId);
      const again = await t.scall(
        doctor,
        'POST',
        path,
        { deferNoteReason: 'Synthetic: second try' },
        ifm(done.json()['version']),
      );
      assert.equal(again.status, 409, 'a completed encounter is final');
    });

    test('complete with a signed note needs no deferral and schedules no reminder; a note submitted for co-signature counts too', async () => {
      const { encounterId } = await consultAs();
      await signed(encounterId);
      const e = await one<{ row_version: string }>(
        `SELECT row_version FROM clinical.encounter WHERE id = $1`,
        [encounterId],
      );
      const done = await t.scall(
        doctor,
        'POST',
        `/api/v1/encounters/${encounterId}/complete`,
        {},
        ifm(e.row_version),
      );
      assert.equal(done.status, 200, done.body);
      assert.equal(done.json()['noteDeferredReason'], null);
      const jobs = await rows(
        `SELECT 1 FROM queue._private_jobs j JOIN queue._private_tasks tk ON tk.id = j.task_id WHERE tk.identifier = 'clinical.note_sign_reminder' AND j.payload->>'encounterId' = $1`,
        [encounterId],
      );
      assert.equal(jobs.length, 0);
    });

    test('the database holds the completion rule and finality for any writer (trigger, not route)', async () => {
      const { encounterId } = await consultAs();
      const scope = t.staffScope(doctor);
      await assert.rejects(
        t.as(scope, (tx) =>
          tx.query(
            `UPDATE clinical.encounter SET status = 'completed', ended_at = now() WHERE id = $1`,
            [encounterId],
          ),
        ),
        (e: { code?: string }) => e.code === 'PS001',
      );
      await assert.rejects(
        t.as(scope, (tx) =>
          tx.query(`DELETE FROM clinical.encounter WHERE id = $1`, [encounterId]),
        ),
        (e: { code?: string }) => e.code === '42501',
      );
      // an administrator-level superuser is refused by the trigger as well
      await assert.rejects(
        rows(`UPDATE clinical.encounter SET clinician_principal_id = $2 WHERE id = $1`, [
          encounterId,
          t.doctor2.seeded.principalId,
        ]),
        (e: { code?: string }) => e.code === 'PS001',
      );
    });
  });

  // ===== TC-CL-01: write from a template, sign, lock ====================================================================
  describe('TC-CL-01 write from a template, sign, edit', () => {
    test('a draft from the SOAP template; autosave with If-Match; sign locks; edit then fails with note_locked; audit holds no text', async () => {
      const { encounterId } = await consultAs();
      const d = await draft(encounterId);
      assert.equal(d['status'], 'draft');
      assert.equal(d['templateId'], 'soap');
      assert.deepEqual(Object.keys((d['body'] as Doc)['sections'] as Doc), [
        'subjective',
        'objective',
        'assessment',
        'plan',
      ]);
      assert.equal(d['authorPrincipalId'], doctor.seeded.principalId);
      const id = String(d['id']);

      const noIfMatch = await t.scall(doctor, 'PATCH', `/api/v1/notes/${id}`, {
        sections: SECTIONS,
      });
      assert.equal(noIfMatch.status, 428, noIfMatch.body);
      assert.equal(code(noIfMatch), 'kernel.precondition_required');
      const saved = await t.scall(
        doctor,
        'PATCH',
        `/api/v1/notes/${id}`,
        { sections: SECTIONS },
        ifm(d['version']),
      );
      assert.equal(saved.status, 200, saved.body);
      assert.equal((saved.json()['body'] as Doc)['sections' as never] !== undefined, true);
      assert.equal(
        ((saved.json()['body'] as Doc)['sections'] as Doc)['subjective'],
        SECTIONS.subjective,
      );
      assert.equal(Number(saved.json()['version']), Number(d['version']) + 1);
      assert.equal(saved.headers['etag'], `W/"${Number(d['version']) + 1}"`);
      // a partial save keeps the other sections
      const p2 = await t.scall(
        doctor,
        'PATCH',
        `/api/v1/notes/${id}`,
        { sections: { plan: 'SYNTHETIC-P rest' } },
        ifm(saved.json()['version']),
      );
      assert.equal(p2.status, 200);
      const sec = (p2.json()['body'] as Doc)['sections'] as Doc;
      assert.equal(sec['subjective'], SECTIONS.subjective);
      assert.equal(sec['plan'], 'SYNTHETIC-P rest');

      const bad = await t.scall(
        doctor,
        'PATCH',
        `/api/v1/notes/${id}`,
        { sections: { nonsense: 'x' } },
        ifm(p2.json()['version']),
      );
      assert.equal(bad.status, 422);
      const big = await t.scall(
        doctor,
        'PATCH',
        `/api/v1/notes/${id}`,
        { sections: { plan: 'x'.repeat(50_001) } },
        ifm(p2.json()['version']),
      );
      assert.equal(big.status, 422);
      const tpl = await t.scall(doctor, 'POST', `/api/v1/encounters/${encounterId}/notes`, {
        templateId: 'nope',
      });
      assert.equal(tpl.status, 422);

      const sign = await t.scall(
        doctor,
        'POST',
        `/api/v1/notes/${id}/sign`,
        undefined,
        ifm(p2.json()['version']),
      );
      assert.equal(sign.status, 200, sign.body);
      assert.equal(sign.json()['status'], 'signed');
      assert.equal(sign.json()['signedBy'], doctor.seeded.principalId);
      assert.ok(sign.json()['signedAt']);
      const after = await hash(id);

      const edit = await t.scall(
        doctor,
        'PATCH',
        `/api/v1/notes/${id}`,
        { sections: { plan: 'changed after signing' } },
        ifm(sign.json()['version']),
      );
      assert.equal(edit.status, 409, edit.body);
      assert.equal(code(edit), 'clinical.note_locked');
      const resign = await t.scall(
        doctor,
        'POST',
        `/api/v1/notes/${id}/sign`,
        undefined,
        ifm(sign.json()['version']),
      );
      assert.equal(resign.status, 409);
      assert.equal(code(resign), 'clinical.note_locked');
      assert.equal(await hash(id), after, 'the signed note is unchanged');

      const aud = await rows<{ action: string; change: unknown }>(
        `SELECT action, change FROM audit.event WHERE resource_type = 'clinical.note' AND resource_id = $1 ORDER BY occurred_at, event_id`,
        [id],
      );
      assert.deepEqual(
        aud.map((a) => a.action).filter((a, i, all) => all.indexOf(a) === i),
        ['create', 'update', 'sign'],
      );
      assert.ok(!JSON.stringify(aud).includes('SYNTHETIC'), 'the audit trail holds no note text');
    });

    test('authorization: only the author saves; a user without clinical.note.write, another doctor and another location are refused', async () => {
      const { encounterId } = await consultAs();
      const d = await draft(encounterId);
      const id = String(d['id']);
      const path = `/api/v1/notes/${id}`;
      assert.equal(
        (await t.scall(t.doctor2, 'PATCH', path, { sections: SECTIONS }, ifm(d['version']))).status,
        403,
        'another doctor is not the author',
      );
      assert.equal(
        (await t.scall(t.nurse, 'PATCH', path, { sections: SECTIONS }, ifm(d['version']))).status,
        403,
        'a nurse holds no note permission',
      );
      assert.equal(
        (await t.scall(t.doctor2, 'POST', `${path}/sign`, undefined, ifm(d['version']))).status,
        403,
        "neither author nor the encounter's clinician",
      );
      assert.equal(
        (await t.scall(t.desk, 'POST', `/api/v1/encounters/${encounterId}/notes`, {})).status,
        403,
      );
      const farDoctor = await staffMember(t.k, 'doctor', A2, 'Doctor A2');
      const far = await t.scall(
        farDoctor,
        'PATCH',
        path,
        { sections: SECTIONS },
        ifm(d['version']),
      );
      assert.ok(
        [403, 404].includes(far.status),
        `a doctor of another location cannot reach the note (${far.status})`,
      );
      assert.equal(
        (
          await t.scall(
            doctor,
            'PATCH',
            `/api/v1/notes/${randomUUID()}`,
            { sections: SECTIONS },
            ifm(1),
          )
        ).status,
        404,
      );
      // nothing leaked into the row
      assert.equal(
        (
          await one<{ body: { sections: Doc } }>(`SELECT body FROM clinical.note WHERE id = $1`, [
            id,
          ])
        ).body.sections['subjective'],
        '',
      );
    });
  });

  // ===== BQ-8: the recent sign-in rule ==================================================================================
  describe('signing needs a recent sign-in (BQ-8, note_sign_max_auth_age)', () => {
    test('older than 12 h: 401 auth.reauth_required and nothing written; after signing in again the same request (same key) succeeds', async () => {
      const { encounterId } = await consultAs();
      const d = await draft(encounterId);
      const path = `/api/v1/notes/${String(d['id'])}/sign`;
      const key = randomUUID();
      await t.ageSignIn(doctor, 13);
      const stale = await t.scall(doctor, 'POST', path, undefined, {
        ...ifm(d['version']),
        'idempotency-key': key,
      });
      assert.equal(stale.status, 401, stale.body);
      assert.equal(code(stale), 'auth.reauth_required');
      assert.equal(
        (await one(`SELECT status FROM clinical.note WHERE id = $1`, [d['id']]))['status'],
        'draft',
      );
      await t.ageSignIn(doctor, 0);
      const ok = await t.scall(doctor, 'POST', path, undefined, {
        ...ifm(d['version']),
        'idempotency-key': key,
      });
      assert.equal(ok.status, 200, ok.body);
      assert.equal(ok.json()['status'], 'signed');
    });

    test('inside the limit signs; the check also guards the co-signature', async () => {
      const { encounterId } = await consultAs();
      const d = await draft(encounterId);
      await t.ageSignIn(doctor, 11.9);
      const ok = await t.scall(
        doctor,
        'POST',
        `/api/v1/notes/${String(d['id'])}/sign`,
        undefined,
        ifm(d['version']),
      );
      assert.equal(ok.status, 200, ok.body);
      await t.ageSignIn(doctor, 0);

      const tr = await consultAs(t.trainee);
      const td = await draft(tr.encounterId, t.trainee);
      const sub = await t.scall(
        t.trainee,
        'POST',
        `/api/v1/notes/${String(td['id'])}/sign`,
        undefined,
        ifm(td['version']),
      );
      assert.equal(sub.status, 200, sub.body);
      await t.ageSignIn(t.supervisor, 13);
      const stale = await t.scall(
        t.supervisor,
        'POST',
        `/api/v1/notes/${String(td['id'])}/cosign`,
        {},
      );
      assert.equal(stale.status, 401, stale.body);
      assert.equal(code(stale), 'auth.reauth_required');
      await t.ageSignIn(t.supervisor, 0);
      const done = await t.scall(
        t.supervisor,
        'POST',
        `/api/v1/notes/${String(td['id'])}/cosign`,
        {},
      );
      assert.equal(done.status, 200, done.body);
    });
  });

  // ===== TC-CL-02 / TC-CL-07: addenda and the lock ======================================================================
  describe('TC-CL-02 addendum, TC-CL-07 a signed note cannot be changed', () => {
    test('TC-CL-02: an addendum has author and time; the original is unchanged; a draft takes none', async () => {
      const { encounterId } = await consultAs();
      const dr = await draft(encounterId);
      const early = await t.scall(doctor, 'POST', `/api/v1/notes/${String(dr['id'])}/addenda`, {
        body: 'too early',
      });
      assert.equal(early.status, 409, 'a draft is edited, not amended');
      const s = await signed(encounterId);
      const id = String(s['id']);
      const before = await hash(id);
      const r = await t.scall(doctor, 'POST', `/api/v1/notes/${id}/addenda`, {
        body: 'SYNTHETIC: dose corrected to 5 mg',
      });
      assert.equal(r.status, 201, r.body);
      assert.equal(r.json()['authorPrincipalId'], doctor.seeded.principalId);
      assert.ok(r.json()['signedAt']);
      assert.equal(r.json()['patientId'], s['patientId']);
      assert.equal(await hash(id), before, 'the original note is unchanged');
      for (const bad of [
        {},
        { body: '' },
        { body: '   ' },
        { body: 'x'.repeat(51_201) },
        { body: 5 },
      ]) {
        const b = await t.scall(doctor, 'POST', `/api/v1/notes/${id}/addenda`, bad);
        assert.equal(b.status, 422, JSON.stringify(bad).slice(0, 30));
      }
      assert.equal(
        (await t.scall(t.nurse, 'POST', `/api/v1/notes/${id}/addenda`, { body: 'x' })).status,
        403,
      );
      // a second doctor with access (the encounter's clinician is the first) may not add either: not assigned
      const second = await t.scall(t.doctor2, 'POST', `/api/v1/notes/${id}/addenda`, {
        body: 'unassigned',
      });
      assert.equal(second.status, 403, second.body);
      assert.equal(
        Number(
          (
            await one(`SELECT count(*)::int AS c FROM clinical.note_addendum WHERE note_id = $1`, [
              id,
            ])
          )['c'],
        ),
        1,
      );
    });

    test('TC-CL-07: PATCH with a valid If-Match, DELETE, an edit through the addendum route and SQL as app_api all fail; the note hash is unchanged', async () => {
      const { encounterId } = await consultAs();
      const s = await signed(encounterId);
      const id = String(s['id']);
      const add = await t.scall(doctor, 'POST', `/api/v1/notes/${id}/addenda`, {
        body: 'SYNTHETIC addendum',
      });
      assert.equal(add.status, 201);
      const h0 = await hash(id);

      const patch = await t.scall(
        doctor,
        'PATCH',
        `/api/v1/notes/${id}`,
        { sections: { plan: 'edit' } },
        ifm(s['version']),
      );
      assert.equal(patch.status, 409);
      assert.equal(code(patch), 'clinical.note_locked');
      const del = await t.scall(doctor, 'DELETE', `/api/v1/notes/${id}`);
      assert.ok([404, 405].includes(del.status), `no DELETE route exists (${del.status})`);
      const put = await t.scall(
        doctor,
        'PUT',
        `/api/v1/notes/${id}`,
        { sections: { plan: 'edit' } },
        ifm(s['version']),
      );
      assert.ok([404, 405].includes(put.status), `no PUT route exists (${put.status})`);
      const viaAddendum = await t.scall(doctor, 'POST', `/api/v1/notes/${id}/addenda`, {
        sections: { plan: 'edit' },
        status: 'draft',
      });
      assert.equal(viaAddendum.status, 422, 'the addendum route takes text only');

      const scope = t.staffScope(doctor);
      const refuse = (sql: string, code2: string) =>
        assert.rejects(
          t.as(scope, (tx) => tx.query(sql, [id])),
          (e: { code?: string }) => e.code === code2,
          sql,
        );
      await refuse(
        `UPDATE clinical.note SET body = '{"sections":{}}'::jsonb WHERE id = $1`,
        'PS001',
      );
      await refuse(
        `UPDATE clinical.note SET status = 'draft', signed_at = NULL, signed_by = NULL WHERE id = $1`,
        'PS001',
      );
      await refuse(`DELETE FROM clinical.note WHERE id = $1`, '42501');
      await refuse(
        `UPDATE clinical.note_addendum SET body = 'changed' WHERE note_id = $1`,
        '42501',
      );
      await refuse(`DELETE FROM clinical.note_addendum WHERE note_id = $1`, '42501');
      // the table owner (a superuser here) is refused by the triggers too: the lock does not depend on the role
      await assert.rejects(
        rows(`UPDATE clinical.note SET body = '{"sections":{}}'::jsonb WHERE id = $1`, [id]),
        (e: { code?: string }) => e.code === 'PS001',
      );
      await assert.rejects(
        rows(`DELETE FROM clinical.note WHERE id = $1`, [id]),
        (e: { code?: string }) => e.code === 'PS001',
      );
      await assert.rejects(
        rows(`UPDATE clinical.note_addendum SET body = 'x' WHERE note_id = $1`, [id]),
        (e: { code?: string }) => e.code === 'PS001',
      );
      assert.equal(await hash(id), h0, 'the note is unchanged (hash equal before and after)');
      assert.equal(
        Number(
          (
            await one(`SELECT count(*)::int AS c FROM clinical.note_addendum WHERE note_id = $1`, [
              id,
            ])
          )['c'],
        ),
        1,
        'only the new addendum exists',
      );
    });
  });

  // ===== TC-CL-03: trainee and co-sign; assistants =====================================================================
  describe('TC-CL-03 trainee notes need a co-signature (BR-12); assistants cannot sign', () => {
    test('trainee: sign submits for co-signature and locks; no release without it; author and non-supervisors cannot co-sign; the supervisor releases', async () => {
      const { encounterId } = await consultAs(t.trainee);
      const d = await draft(encounterId, t.trainee);
      const id = String(d['id']);
      await t.scall(
        t.trainee,
        'PATCH',
        `/api/v1/notes/${id}`,
        { sections: SECTIONS },
        ifm(d['version']),
      );
      const cur = await one<{ row_version: string }>(
        `SELECT row_version FROM clinical.note WHERE id = $1`,
        [id],
      );
      const sub = await t.scall(
        t.trainee,
        'POST',
        `/api/v1/notes/${id}/sign`,
        undefined,
        ifm(cur.row_version),
      );
      assert.equal(sub.status, 200, sub.body);
      assert.equal(sub.json()['status'], 'pending_cosign');
      assert.equal(sub.json()['cosignRequiredFrom'], t.supervisor.seeded.principalId);
      assert.equal(sub.json()['signedAt'], null);
      assert.ok(sub.json()['submittedForCosignAt']);

      // 1. release without co-signature is refused: the trainee cannot sign again or edit
      const again = await t.scall(
        t.trainee,
        'POST',
        `/api/v1/notes/${id}/sign`,
        undefined,
        ifm(sub.json()['version']),
      );
      assert.equal(again.status, 409);
      assert.equal(code(again), 'clinical.note_locked');
      const edit = await t.scall(
        t.trainee,
        'PATCH',
        `/api/v1/notes/${id}`,
        { sections: { plan: 'x' } },
        ifm(sub.json()['version']),
      );
      assert.equal(edit.status, 409);
      // ... and the database refuses the release without the co-signature row, for any writer, even in the supervisor's name
      await assert.rejects(
        t.as(t.staffScope(t.supervisor), (tx) =>
          tx.query(
            `UPDATE clinical.note SET status = 'signed', signed_at = now(), signed_by = $2 WHERE id = $1`,
            [id, t.supervisor.seeded.principalId],
          ),
        ),
        (e: { code?: string }) => e.code === 'PS001',
      );
      await assert.rejects(
        t.as(t.staffScope(t.trainee), (tx) =>
          tx.query(
            `UPDATE clinical.note SET status = 'signed', signed_at = now(), signed_by = $2 WHERE id = $1`,
            [id, t.trainee.seeded.principalId],
          ),
        ),
        (e: { code?: string }) => e.code === 'PS001',
      );
      assert.equal(
        (await one(`SELECT status FROM clinical.note WHERE id = $1`, [id]))['status'],
        'pending_cosign',
      );
      const body0 = (await one(`SELECT body FROM clinical.note WHERE id = $1`, [id]))['body'];

      // the author and any other doctor are not the supervisor
      const byAuthor = await t.scall(t.trainee, 'POST', `/api/v1/notes/${id}/cosign`, {});
      assert.equal(byAuthor.status, 403, byAuthor.body);
      const byOther = await t.scall(t.doctor2, 'POST', `/api/v1/notes/${id}/cosign`, {});
      assert.equal(byOther.status, 403);
      assert.equal(code(byOther), 'clinical.cosign_not_supervisor');
      assert.equal(
        Number(
          (
            await one(`SELECT count(*)::int AS c FROM clinical.note_cosign WHERE note_id = $1`, [
              id,
            ])
          )['c'],
        ),
        0,
      );

      // 2. the supervisor co-signs; 3. the note is released
      const ok = await t.scall(t.supervisor, 'POST', `/api/v1/notes/${id}/cosign`, {});
      assert.equal(ok.status, 200, ok.body);
      assert.equal(ok.json()['status'], 'signed');
      assert.equal(ok.json()['signedBy'], t.supervisor.seeded.principalId);
      assert.equal(ok.json()['authorPrincipalId'], t.trainee.seeded.principalId);
      assert.ok(ok.json()['cosignedAt']);
      assert.deepEqual(
        (await one(`SELECT body FROM clinical.note WHERE id = $1`, [id]))['body'],
        body0,
        'co-signing does not change the content',
      );
      const cs = await one<{ supervisor_principal_id: string }>(
        `SELECT supervisor_principal_id FROM clinical.note_cosign WHERE note_id = $1`,
        [id],
      );
      assert.equal(cs.supervisor_principal_id, t.supervisor.seeded.principalId);
      const aud = await rows<{ action: string; actor_principal_id: string }>(
        `SELECT action, actor_principal_id FROM audit.event WHERE resource_type = 'clinical.note' AND resource_id = $1 AND action = 'cosign'`,
        [id],
      );
      assert.equal(aud.length, 1, 'the co-signature is audited');
      assert.equal(aud[0]?.actor_principal_id, t.supervisor.seeded.principalId);
      const twice = await t.scall(t.supervisor, 'POST', `/api/v1/notes/${id}/cosign`, {});
      assert.equal(twice.status, 409);
      // the co-signature row is append-only
      await assert.rejects(
        rows(`UPDATE clinical.note_cosign SET supervisor_principal_id = $2 WHERE note_id = $1`, [
          id,
          t.doctor2.seeded.principalId,
        ]),
        (e: { code?: string }) => e.code === 'PS001',
      );
      // the released note takes addenda, not edits
      // having co-signed makes the supervisor assigned to the patient (27.4 `authored`), so an addendum is allowed
      const add = await t.scall(t.supervisor, 'POST', `/api/v1/notes/${id}/addenda`, {
        body: 'SYNTHETIC supervisor addendum',
      });
      assert.equal(add.status, 201, add.body);
      assert.equal(add.json()['authorPrincipalId'], t.supervisor.seeded.principalId);
      // BE17-F1: the trainee who wrote the released note holds no clinical.note.sign, so cannot append a signed addendum, in the route or in SQL
      const byTrainee = await t.scall(t.trainee, 'POST', `/api/v1/notes/${id}/addenda`, {
        body: 'SYNTHETIC trainee addendum',
      });
      assert.equal(byTrainee.status, 403, byTrainee.body);
      await assert.rejects(
        t.as(t.staffScope(t.trainee), (tx) =>
          tx.query(
            `INSERT INTO clinical.note_addendum (id, organisation_id, note_id, patient_id, author_principal_id, body, created_by)
             SELECT gen_random_uuid(), organisation_id, id, patient_id, $2::uuid, 'x', $2::uuid FROM clinical.note WHERE id = $1`,
            [id, t.trainee.seeded.principalId],
          ),
        ),
        (e: { code?: string }) => e.code === 'PS001',
        'the database refuses a trainee addendum too',
      );
    });

    test('a trainee with no supervisor on file cannot submit (422); the encounter of a trainee completes with the note submitted', async () => {
      const bare = await staffMember(t.k, 'trainee_doctor', A1, 'Trainee without supervisor');
      const { encounterId } = await consultAs(bare);
      const d = await draft(encounterId, bare);
      const r = await t.scall(
        bare,
        'POST',
        `/api/v1/notes/${String(d['id'])}/sign`,
        undefined,
        ifm(d['version']),
      );
      assert.equal(r.status, 422, r.body);
      assert.equal(
        (await one(`SELECT status FROM clinical.note WHERE id = $1`, [d['id']]))['status'],
        'draft',
      );

      const tr = await consultAs(t.trainee);
      const td = await draft(tr.encounterId, t.trainee);
      assert.equal(
        (
          await t.scall(
            t.trainee,
            'POST',
            `/api/v1/notes/${String(td['id'])}/sign`,
            undefined,
            ifm(td['version']),
          )
        ).status,
        200,
      );
      const e = await one<{ row_version: string }>(
        `SELECT row_version FROM clinical.encounter WHERE id = $1`,
        [tr.encounterId],
      );
      const done = await t.scall(
        t.trainee,
        'POST',
        `/api/v1/encounters/${tr.encounterId}/complete`,
        {},
        ifm(e.row_version),
      );
      assert.equal(done.status, 200, done.body);
    });

    test("assistants prepare drafts but cannot sign; the encounter's doctor signs the assistant's draft", async () => {
      const { p, encounterId } = await consultAs(doctor);
      const d = await draft(encounterId, t.assistant);
      assert.equal(d['authorPrincipalId'], t.assistant.seeded.principalId);
      const saved = await t.scall(
        t.assistant,
        'PATCH',
        `/api/v1/notes/${String(d['id'])}`,
        { sections: SECTIONS },
        ifm(d['version']),
      );
      assert.equal(saved.status, 200, saved.body);
      const sign = await t.scall(
        t.assistant,
        'POST',
        `/api/v1/notes/${String(d['id'])}/sign`,
        undefined,
        ifm(saved.json()['version']),
      );
      assert.equal(sign.status, 403, sign.body);
      assert.equal(
        (await one(`SELECT status FROM clinical.note WHERE id = $1`, [d['id']]))['status'],
        'draft',
      );
      await assert.rejects(
        t.as(t.staffScope(t.assistant), (tx) =>
          tx.query(
            `UPDATE clinical.note SET status = 'signed', signed_at = now(), signed_by = $2 WHERE id = $1`,
            [d['id'], t.assistant.seeded.principalId],
          ),
        ),
        (e: { code?: string }) => e.code === 'PS001',
        "the database refuses an assistant's signature too",
      );
      const byDoctor = await t.scall(
        doctor,
        'POST',
        `/api/v1/notes/${String(d['id'])}/sign`,
        undefined,
        ifm(saved.json()['version']),
      );
      assert.equal(byDoctor.status, 200, byDoctor.body);
      assert.equal(byDoctor.json()['signedBy'], doctor.seeded.principalId);
      assert.equal(byDoctor.json()['authorPrincipalId'], t.assistant.seeded.principalId);
      // BE17-F1: the assistant who prepared the draft (assigned through `authored`) cannot append a signed addendum to the locked note
      const byAssistant = await t.scall(
        t.assistant,
        'POST',
        `/api/v1/notes/${String(d['id'])}/addenda`,
        { body: 'SYNTHETIC assistant addendum' },
      );
      assert.equal(byAssistant.status, 403, byAssistant.body);
      await assert.rejects(
        t.as(t.staffScope(t.assistant), (tx) =>
          tx.query(
            `INSERT INTO clinical.note_addendum (id, organisation_id, note_id, patient_id, author_principal_id, body, created_by)
             SELECT gen_random_uuid(), organisation_id, id, patient_id, $2::uuid, 'x', $2::uuid FROM clinical.note WHERE id = $1`,
            [d['id'], t.assistant.seeded.principalId],
          ),
        ),
        (e: { code?: string }) => e.code === 'PS001',
        'the database refuses an assistant addendum too',
      );
      const byDoctorAdd = await t.scall(
        doctor,
        'POST',
        `/api/v1/notes/${String(d['id'])}/addenda`,
        { body: 'SYNTHETIC doctor addendum' },
      );
      assert.equal(byDoctorAdd.status, 201, byDoctorAdd.body);
      // an assistant of nobody (not assigned) cannot even prepare a draft for this patient
      const lone = await staffMember(t.k, 'assistant', A1, 'Assistant of nobody');
      const refused = await t.scall(lone, 'POST', `/api/v1/encounters/${encounterId}/notes`, {});
      assert.equal(refused.status, 403, refused.body);
      void p;
    });
  });

  // ===== TC-CL-05: concurrent edits =====================================================================================
  describe('TC-CL-05 concurrency', () => {
    test('two sessions edit the same draft: the second save is 412 and the first edit is what is stored; the draft stays recoverable', async () => {
      const { encounterId } = await consultAs();
      const d = await draft(encounterId);
      const path = `/api/v1/notes/${String(d['id'])}`;
      const a = await t.scall(
        doctor,
        'PATCH',
        path,
        { sections: { subjective: 'SYNTHETIC first session' } },
        ifm(d['version']),
      );
      assert.equal(a.status, 200);
      const b = await t.scall(
        doctor,
        'PATCH',
        path,
        { sections: { subjective: 'SYNTHETIC second session' } },
        ifm(d['version']),
      );
      assert.equal(b.status, 412, b.body);
      assert.equal(code(b), 'kernel.precondition_failed');
      const stored = await one<{ body: { sections: Doc } }>(
        `SELECT body FROM clinical.note WHERE id = $1`,
        [d['id']],
      );
      assert.equal(stored.body.sections['subjective'], 'SYNTHETIC first session');
    });

    test('simultaneous saves of one version: exactly one wins; simultaneous signs: exactly one signs', async () => {
      const { encounterId } = await consultAs();
      const d = await draft(encounterId);
      const path = `/api/v1/notes/${String(d['id'])}`;
      const saves = await Promise.all(
        [1, 2, 3, 4].map((i) =>
          t.scall(
            doctor,
            'PATCH',
            path,
            { sections: { plan: `SYNTHETIC save ${i}` } },
            ifm(d['version']),
          ),
        ),
      );
      assert.equal(
        saves.filter((r) => r.status === 200).length,
        1,
        saves.map((r) => r.status).join(','),
      );
      assert.equal(saves.filter((r) => r.status === 412).length, 3);
      const cur = await one<{ row_version: string }>(
        `SELECT row_version FROM clinical.note WHERE id = $1`,
        [d['id']],
      );
      const signs = await Promise.all(
        [1, 2, 3].map(() =>
          t.scall(doctor, 'POST', `${path}/sign`, undefined, ifm(cur.row_version)),
        ),
      );
      assert.equal(
        signs.filter((r) => r.status === 200).length,
        1,
        signs.map((r) => r.status).join(','),
      );
      assert.ok(
        signs
          .filter((r) => r.status !== 200)
          .every((r) => r.status === 409 && code(r) === 'clinical.note_locked'),
      );
      assert.equal(
        Number(
          (
            await one(
              `SELECT count(*)::int AS c FROM audit.event WHERE resource_type = 'clinical.note' AND resource_id = $1 AND action = 'sign'`,
              [d['id']],
            )
          )['c'],
        ),
        1,
      );
    });
  });

  // ===== TC-CL-06: the reminder ==========================================================================================
  describe('TC-CL-06 unsigned-note reminder', () => {
    const runReminder = async (pid: string, eid: string) =>
      t.asWorker(
        {
          audience: 'system',
          realm: 'worker',
          orgId: ORG,
          jobScope: 'patients',
          jobPatientIds: [pid],
        },
        (tx) => t.notes.reminder.run(tx, { encounterId: eid, patientId: pid }),
      );

    test('a deferred, still unsigned encounter raises one note_unsigned alert for the clinician with IDs only; a signed one raises none', async () => {
      const { p, encounterId } = await consultAs();
      const e = await one<{ row_version: string }>(
        `SELECT row_version FROM clinical.encounter WHERE id = $1`,
        [encounterId],
      );
      const dr = await draft(encounterId);
      const done = await t.scall(
        doctor,
        'POST',
        `/api/v1/encounters/${encounterId}/complete`,
        { deferNoteReason: 'Synthetic: finishing after clinic' },
        ifm(e.row_version),
      );
      assert.equal(done.status, 200, done.body);
      const out = await runReminder(p.patientId, encounterId);
      assert.equal(out.outcome, 'raised');
      const alerts = await rows<Record<string, unknown>>(
        `SELECT * FROM notifications.staff_alert WHERE resource_id = $1`,
        [encounterId],
      );
      assert.equal(alerts.length, 1);
      const al = alerts[0] as Record<string, unknown>;
      assert.equal(al['type'], 'note_unsigned');
      assert.equal(al['patient_id'], p.patientId);
      assert.deepEqual(al['target_principal_ids'], [doctor.seeded.principalId]);
      assert.equal(al['resource_type'], 'encounter');
      assert.ok(
        !JSON.stringify(al).includes('SYNTHETIC'),
        'no note text, no name in the alert row',
      );
      // once the note is signed the next run finds nothing to remind
      const s = await t.scall(
        doctor,
        'POST',
        `/api/v1/notes/${String(dr['id'])}/sign`,
        undefined,
        ifm(dr['version']),
      );
      assert.equal(s.status, 200, s.body);
      const later = await runReminder(p.patientId, encounterId);
      assert.deepEqual(later, { outcome: 'skipped', reason: 'note_present' });
      assert.equal(
        Number(
          (
            await one(
              `SELECT count(*)::int AS c FROM notifications.staff_alert WHERE resource_id = $1`,
              [encounterId],
            )
          )['c'],
        ),
        1,
      );
    });

    test('an encounter still in consultation, an unknown one and a malformed payload raise nothing', async () => {
      const { p, encounterId } = await consultAs();
      assert.deepEqual(await runReminder(p.patientId, encounterId), {
        outcome: 'skipped',
        reason: 'not_completed',
      });
      assert.deepEqual(await runReminder(p.patientId, randomUUID()), {
        outcome: 'skipped',
        reason: 'not_visible',
      });
      await assert.rejects(
        t.asWorker(
          {
            audience: 'system',
            realm: 'worker',
            orgId: ORG,
            jobScope: 'patients',
            jobPatientIds: [p.patientId],
          },
          (tx) => t.notes.reminder.run(tx, { encounterId: 'nope', patientId: p.patientId }),
        ),
      );
    });
  });

  // ===== assignment source ===============================================================================================
  describe('the `authored` assignment source (27.4)', () => {
    test("true for the encounter's clinician and a note's author, false for anyone else", async () => {
      const { p, encounterId } = await consultAs();
      await draft(encounterId, t.assistant);
      const check = (who: SeededSession): Promise<boolean> =>
        t.as(t.staffScope(who), (tx) =>
          authoredSource(tx, who.seeded.principalId, p.patientId, { lookbackMonths: 24 }),
        );
      assert.equal(await check(doctor), true);
      assert.equal(await check(t.assistant), true);
      assert.equal(await check(t.doctor2), false);
      assert.equal(await check(t.nurse), false);
    });
  });

  // ===== merge participant and export part (38.2 item 11, 22.16) ========================================================
  describe('merge participant and export part (38.2 item 11)', () => {
    test('item 11: R encounters and notes follow the survivor, K rows stay, counts add up; a later addendum carries the survivor ID; the export lists them', async () => {
      const a = await t.mkPatient(n()); // survivor
      const b = await t.mkPatient(n()); // merged
      await t.checkedIn(a);
      // b: encounter 1 completed with a signed note (K) + an addendum (K); encounter 2 in consultation with a draft (R);
      //    encounter 3 (trainee) in consultation with a note waiting for co-signature (R); encounter 4 (trainee) cosigned (K note, K cosign)
      const e1 = await t.consult(b);
      const n1 = await signed(e1.encounterId);
      const ad = await t.scall(doctor, 'POST', `/api/v1/notes/${String(n1['id'])}/addenda`, {
        body: 'SYNTHETIC addendum before merge',
      });
      assert.equal(ad.status, 201, ad.body);
      const ev1 = await one<{ row_version: string }>(
        `SELECT row_version FROM clinical.encounter WHERE id = $1`,
        [e1.encounterId],
      );
      assert.equal(
        (
          await t.scall(
            doctor,
            'POST',
            `/api/v1/encounters/${e1.encounterId}/complete`,
            {},
            ifm(ev1.row_version),
          )
        ).status,
        200,
      );
      const e2 = await t.consult(b);
      const n2 = await draft(e2.encounterId);
      await t.scall(
        doctor,
        'PATCH',
        `/api/v1/notes/${String(n2['id'])}`,
        { sections: { plan: 'SYNTHETIC-DRAFT-PLAN' } },
        ifm(n2['version']),
      );
      const e3 = await t.consult(b, t.trainee);
      const n3 = await draft(e3.encounterId, t.trainee);
      assert.equal(
        (
          await t.scall(
            t.trainee,
            'POST',
            `/api/v1/notes/${String(n3['id'])}/sign`,
            undefined,
            ifm(n3['version']),
          )
        ).status,
        200,
      );
      const e4 = await t.consult(b, t.trainee);
      const n4 = await draft(e4.encounterId, t.trainee);
      assert.equal(
        (
          await t.scall(
            t.trainee,
            'POST',
            `/api/v1/notes/${String(n4['id'])}/sign`,
            undefined,
            ifm(n4['version']),
          )
        ).status,
        200,
      );
      assert.equal(
        (await t.scall(t.supervisor, 'POST', `/api/v1/notes/${String(n4['id'])}/cosign`, {}))
          .status,
        200,
      );
      const ev4 = await one<{ row_version: string }>(
        `SELECT row_version FROM clinical.encounter WHERE id = $1`,
        [e4.encounterId],
      );
      assert.equal(
        (
          await t.scall(
            t.trainee,
            'POST',
            `/api/v1/encounters/${e4.encounterId}/complete`,
            {},
            ifm(ev4.row_version),
          )
        ).status,
        200,
      );
      const signedBefore = await hash(String(n1['id']));

      const merged = await t.merge(a.patientId, b.patientId);
      assert.equal(merged.result.status, 'completed');

      const where = async (table: string, id: string, statusCol = 'status'): Promise<string> =>
        String(
          (
            await one(
              `SELECT patient_id FROM ${table} WHERE ${statusCol === 'note_id' ? 'note_id' : 'id'} = $1`,
              [id],
            )
          )['patient_id'],
        );
      assert.equal(
        await where('clinical.encounter', e1.encounterId),
        b.patientId,
        'completed encounter is K',
      );
      assert.equal(
        await where('clinical.encounter', e2.encounterId),
        a.patientId,
        'in-consultation encounter is R',
      );
      assert.equal(await where('clinical.encounter', e3.encounterId), a.patientId);
      assert.equal(await where('clinical.encounter', e4.encounterId), b.patientId);
      assert.equal(
        await where('clinical.note', String(n1['id'])),
        b.patientId,
        'signed note is K and never re-pointed',
      );
      assert.equal(await where('clinical.note', String(n2['id'])), a.patientId, 'draft is R');
      assert.equal(
        await where('clinical.note', String(n3['id'])),
        a.patientId,
        'note waiting for co-signature is R',
      );
      assert.equal(await where('clinical.note', String(n4['id'])), b.patientId);
      assert.equal(
        await where('clinical.note_cosign', String(n4['id']), 'note_id'),
        b.patientId,
        'append-only rows are kept',
      );
      assert.equal(
        String(
          (
            await one(`SELECT patient_id FROM clinical.note_addendum WHERE note_id = $1`, [
              n1['id'],
            ])
          )['patient_id'],
        ),
        b.patientId,
      );
      assert.equal(
        await hash(String(n1['id'])),
        signedBefore,
        'the signed note is byte-for-byte unchanged by the merge',
      );
      assert.deepEqual(
        (
          await one<{ body: { sections: Doc } }>(`SELECT body FROM clinical.note WHERE id = $1`, [
            n2['id'],
          ])
        ).body.sections['plan'],
        'SYNTHETIC-DRAFT-PLAN',
        'the re-pointed draft keeps its content',
      );
      const counts = (
        await one<{ counts: unknown }>(`SELECT counts FROM patient.merge_request WHERE id = $1`, [
          merged.requestId,
        ])
      ).counts;
      const entryOf = (tbl: string): Record<string, unknown> | undefined =>
        (counts as Record<string, Record<string, unknown>>)[tbl];
      const num = (tbl: string, k: string): number => Number(entryOf(tbl)?.[k]);
      for (const tbl of NOTES_MERGE_TABLES)
        assert.ok(entryOf(tbl) !== undefined, `${tbl} is in the merge report`);
      assert.deepEqual(
        [
          num('clinical.encounter', 'found'),
          num('clinical.encounter', 'repointed'),
          num('clinical.encounter', 'kept'),
        ],
        [4, 2, 2],
      );
      assert.deepEqual(
        [
          num('clinical.note', 'found'),
          num('clinical.note', 'repointed'),
          num('clinical.note', 'kept'),
        ],
        [4, 2, 2],
      );
      assert.deepEqual(
        [
          num('clinical.note_cosign', 'found'),
          num('clinical.note_cosign', 'repointed'),
          num('clinical.note_cosign', 'kept'),
        ],
        [1, 0, 1],
      );
      assert.deepEqual(
        [
          num('clinical.note_addendum', 'found'),
          num('clinical.note_addendum', 'repointed'),
          num('clinical.note_addendum', 'kept'),
        ],
        [1, 0, 1],
      );

      // the pending note now sits on the survivor and is co-signed there
      const co = await t.scall(
        t.supervisor,
        'POST',
        `/api/v1/notes/${String(n3['id'])}/cosign`,
        {},
      );
      assert.equal(co.status, 200, co.body);
      assert.equal(co.json()['patientId'], a.patientId);
      assert.equal(
        String(
          (await one(`SELECT patient_id FROM clinical.note_cosign WHERE note_id = $1`, [n3['id']]))[
            'patient_id'
          ],
        ),
        a.patientId,
      );

      // a new addendum to the signed note of the merged patient carries the survivor's patient ID; the note stays as it was
      const late = await t.scall(doctor, 'POST', `/api/v1/notes/${String(n1['id'])}/addenda`, {
        body: 'SYNTHETIC addendum after merge',
      });
      assert.equal(late.status, 201, late.body);
      assert.equal(
        late.json()['patientId'],
        a.patientId,
        'the addendum carries the survivor ID (TC-CL-02)',
      );
      assert.equal(await hash(String(n1['id'])), signedBefore);
      // writing to the merged patient directly is refused by the guard
      const direct = t.as(t.staffScope(doctor), (tx) =>
        tx.query(
          `INSERT INTO clinical.note_addendum (id, organisation_id, note_id, patient_id, author_principal_id, body, created_by)
           VALUES ($1, $2, $3, $4, $5, 'x', $5)`,
          [randomUUID(), ORG, n1['id'], b.patientId, doctor.seeded.principalId],
        ),
      );
      await assert.rejects(
        direct,
        (e: { code?: string }) => e.code === 'PM001' || e.code === 'PS001',
      );

      // the export part lists everything of the survivor and of the merged ID
      const scope = {
        audience: 'system' as const,
        realm: 'worker' as const,
        orgId: ORG,
        jobScope: 'patients' as const,
        jobPatientIds: [a.patientId, b.patientId],
      };
      const { notesExportPart } = await import('./merge.js');
      const exported = (await t.asWorker(scope, (tx) =>
        notesExportPart.exportPart(tx, [a.patientId, b.patientId], randomUUID()),
      )) as Record<string, unknown[]>;
      assert.equal(exported['encounters']?.length, 4);
      assert.equal(exported['notes']?.length, 4);
      assert.equal(exported['noteCosigns']?.length, 2);
      assert.equal(exported['noteAddenda']?.length, 2);
      assert.ok(
        JSON.stringify(exported).includes('SYNTHETIC-DRAFT-PLAN'),
        'note content is exported',
      );
    });

    test('a signed note racing the merge is either moved (draft first) or kept (sign first), never lost or edited', async () => {
      const a = await t.mkPatient(n());
      const b = await t.mkPatient(n());
      await t.checkedIn(a);
      const { encounterId } = await t.consult(b);
      const d = await draft(encounterId);
      const [sign, merged] = await Promise.all([
        t.scall(
          doctor,
          'POST',
          `/api/v1/notes/${String(d['id'])}/sign`,
          undefined,
          ifm(d['version']),
        ),
        t.merge(a.patientId, b.patientId).catch((e: unknown) => e),
      ]);
      const row = await one<{ patient_id: string; status: string }>(
        `SELECT patient_id, status FROM clinical.note WHERE id = $1`,
        [d['id']],
      );
      assert.ok([200, 409].includes(sign.status), `sign ended ${sign.status}: ${sign.body}`);
      if (sign.status === 200) assert.equal(row.status, 'signed');
      assert.ok(row.patient_id === a.patientId || row.patient_id === b.patientId);
      // sign first: the note is K and stays on the merged ID; merge first: the draft moved and was signed on the survivor
      if (row.status === 'signed' && !(merged instanceof Error))
        assert.ok([a.patientId, b.patientId].includes(row.patient_id));
      if (row.status === 'draft')
        assert.equal(row.patient_id, a.patientId, 'an unsigned note followed the merge');
    });
  });
});
