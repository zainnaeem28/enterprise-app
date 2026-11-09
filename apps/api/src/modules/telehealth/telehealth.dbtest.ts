// Real-database tests of telehealth (BE-15): the licensing check at booking and at join, the session and its room, the waiting room, join
// tokens (single use, short life, never stored), the device check, the end of a visit, stale sessions, the merge and export participant,
// and the database rules under them (ARCHITECTURE 22.10, 22.16, 25.x, 29.2, 29.3, 38.2 items 2 and 11; TC-TH-03..08).
// PostgreSQL 17, the real migrations, the real booking core, the worker's real jobs and video adapter behind integration-core's real
// gateway. The VENDOR is an in-memory contract stub: TC-TH-01, 02, 04 and 05 against a real vendor sandbox are BLOCKED (C-10, C-11).
//   EHR_TEST_ADMIN_URL=postgres://postgres@host:5432/postgres node --test dist/src/modules/telehealth/telehealth.dbtest.js
import { newRegisteredRegistries } from '../../register-participants.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { A1, ORG, SVC, setupTelehealth, slotStart } from './testkit.js';
import type { Doctor, PatientKit, TelehealthKit } from './testkit.js';
import { TelehealthService } from './service.js';
import { telehealthExportContributor } from './merge.js';

let t: TelehealthKit;
before(async () => {
  t = await setupTelehealth('th');
});
after(async () => {
  await t?.close();
});

const meta = () => ({ requestId: randomUUID() });
const inMin = (m: number): Date => new Date(Date.now() + m * 60_000);
const q = <R = Record<string, unknown>>(sql: string, p?: unknown[]): Promise<R[]> =>
  t.f.k.q<R>(sql, p);
const one = async <R = Record<string, unknown>>(sql: string, p?: unknown[]): Promise<R> =>
  (await q<R>(sql, p))[0] as R;
const nrows = async (sql: string, p?: unknown[]): Promise<number> =>
  Number((await one<{ n: string }>(sql, p)).n);
const asP = <T>(p: PatientKit, fn: Parameters<typeof t.f.api.withScope<T>>[1]): Promise<T> =>
  t.f.api.withScope(p.scope, fn);
const asH = <T>(d: Doctor, fn: Parameters<typeof t.f.api.withScope<T>>[1]): Promise<T> =>
  t.f.api.withScope(t.hostScope(d), fn);
const rejectsWith = (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (e: { code?: string }) => {
    assert.equal(e.code, code);
    return true;
  });
const rejectsSqlState = (p: Promise<unknown>, state: string) =>
  assert.rejects(p, (e: { code?: string }) => {
    assert.equal(e.code, state);
    return true;
  });
/** A direct write as the superuser, in the organisation and audience the merge write guard reads (it refuses a write with no context). */
const sys = async (sql: string, p: unknown[] = [], replica = false) => {
  await t.f.k.sa.query('BEGIN');
  try {
    if (replica) await t.f.k.sa.query(`SET LOCAL session_replication_role = replica`);
    await t.f.k.sa.query(
      `SELECT set_config('app.org_id', $1, true), set_config('app.audience', 'system', true)`,
      [ORG],
    );
    const r = await t.f.k.sa.query(sql, p);
    await t.f.k.sa.query('COMMIT');
    return r;
  } catch (e) {
    await t.f.k.sa.query('ROLLBACK');
    throw e;
  }
};

let seq = 100;
/** A doctor licensed in NY and a registered patient with a confirmed VIDEO visit starting in `startInMin` minutes (window open at -10). */
async function visit(
  o: { startInMin?: number; minutes?: number; room?: boolean; states?: string[] } = {},
): Promise<{ d: Doctor; p: PatientKit; rid: string }> {
  const d = await t.f.doctor();
  await t.license(d.principalId, o.states ?? ['NY']);
  const p = await t.f.patient(++seq);
  const rid = await t.video_visit(p, d, inMin(o.startInMin ?? 5), {
    ...(o.minutes === undefined ? {} : { minutes: o.minutes }),
    ...(o.room === undefined ? {} : { room: o.room }),
  });
  return { d, p, rid };
}

/** Patient confirms NY, host admits, patient has an admitted seat: ready to join. */
async function admitted(v: { d: Doctor; p: PatientKit; rid: string }): Promise<void> {
  await asP(v.p, (tx) => t.telehealth.confirmLocation(tx, meta(), v.rid, { state: 'NY' }));
  await rejectsWith(t.telehealth.join(v.p.scope, meta(), v.rid), 'telehealth.not_admitted');
  await asH(v.d, (tx) => t.telehealth.admit(tx, meta(), v.rid, {}));
}

describe('licensing at booking (RA-R1-28, TL-1; TC-TH-06, placeholder states: NY allowed and licensed, CA allowed but not licensed, NJ not an operating state)', () => {
  test('a video booking with a stated state outside the clinician’s licensed states is refused; in-state is allowed; nothing is stored for a refusal', async () => {
    const d = await t.f.doctor();
    await t.license(d.principalId, ['NY', 'NJ']);
    const p = await t.f.patient(++seq);
    const hold = (state: string, slot: number) =>
      asP(p, (tx) =>
        t.f.core.hold(tx, meta(), {
          patientId: p.patientId,
          serviceId: SVC,
          locationId: A1,
          clinicianId: d.principalId,
          startsAt: slotStart(20, slot).toISOString(),
          mode: 'video',
          patientState: state,
        }),
      );
    await rejectsWith(hold('CA', 0), 'scheduling.licensing_refused');
    // licensed in NJ, but NJ is not an operating state (D-2 not answered for it): refused
    await rejectsWith(hold('NJ', 1), 'scheduling.licensing_refused');
    const before = await nrows(
      `SELECT count(*) AS n FROM scheduling.slot_reservation WHERE patient_id = $1`,
      [p.patientId],
    );
    assert.equal(before, 0);
    const ok = await hold('NY', 2);
    const row = await one<{ licensing_result: string }>(
      `SELECT licensing_result FROM scheduling.slot_reservation WHERE id = $1`,
      [ok.reservationId],
    );
    assert.equal(row.licensing_result, 'allowed');
  });

  test('flag mode: the booking is made and marked; the default mode refuses', async () => {
    const d = await t.f.doctor();
    await t.license(d.principalId, ['NY']);
    const p = await t.f.patient(++seq);
    await t.f.k.sa.query(
      `UPDATE kernel.setting SET value = '"flag"' WHERE key = 'telehealth_licensing_mode'`,
    );
    try {
      const h = await asP(p, (tx) =>
        t.f.core.hold(tx, meta(), {
          patientId: p.patientId,
          serviceId: SVC,
          locationId: A1,
          clinicianId: d.principalId,
          startsAt: slotStart(21).toISOString(),
          mode: 'video',
          patientState: 'CA',
        }),
      );
      const row = await one<{ licensing_result: string }>(
        `SELECT licensing_result FROM scheduling.slot_reservation WHERE id = $1`,
        [h.reservationId],
      );
      assert.equal(row.licensing_result, 'flagged');
    } finally {
      await t.f.k.sa.query(
        `UPDATE kernel.setting SET value = '"refuse"' WHERE key = 'telehealth_licensing_mode'`,
      );
    }
  });
});

describe('the session and its room (33.1 telehealth.create_meeting, 22.10)', () => {
  test('a confirmed video visit gets a session at once and a create_meeting job for start minus 15 minutes; an in-person visit gets neither', async () => {
    const d = await t.f.doctor();
    const p = await t.f.patient(++seq);
    const start = slotStart(30, 1);
    const rid = await t.f.seed(p, d.principalId, start, { mode: 'video' });
    const payload = { reservationId: rid, patientId: p.patientId };
    assert.equal(await t.W.runOnReservationConfirmed(t.jobs, payload), 'scheduled');
    const s = await one<{
      status: string;
      vendor_meeting_id: string | null;
      recording_enabled: boolean;
    }>(
      `SELECT status, vendor_meeting_id, recording_enabled FROM telehealth.video_session WHERE reservation_id = $1`,
      [rid],
    );
    assert.equal(s.status, 'scheduled');
    assert.equal(s.vendor_meeting_id, null);
    assert.equal(s.recording_enabled, false);
    const jobs = (await t.f.jobsInQueue('telehealth.create_meeting')).filter(
      (j) => j.payload['reservationId'] === rid,
    );
    assert.equal(jobs.length, 1);
    assert.equal(
      new Date(jobs[0]?.run_at as Date).toISOString(),
      new Date(start.getTime() - 15 * 60_000).toISOString(),
    );
    // a repeat of the event changes nothing (one job per reservation)
    assert.equal(await t.W.runOnReservationConfirmed(t.jobs, payload), 'scheduled');
    assert.equal(
      (await t.f.jobsInQueue('telehealth.create_meeting')).filter(
        (j) => j.payload['reservationId'] === rid,
      ).length,
      1,
    );
    assert.equal(
      await nrows(`SELECT count(*) AS n FROM telehealth.video_session WHERE reservation_id = $1`, [
        rid,
      ]),
      1,
    );

    const ip = await t.f.seed(p, (await t.f.doctor()).principalId, slotStart(30, 5), {
      mode: 'in_person',
    });
    assert.equal(
      await t.W.runOnReservationConfirmed(t.jobs, { reservationId: ip, patientId: p.patientId }),
      'skipped',
    );
    assert.equal(
      await nrows(`SELECT count(*) AS n FROM telehealth.video_session WHERE reservation_id = $1`, [
        ip,
      ]),
      0,
    );
  });

  test('create_meeting makes one room, with recording off, and a second run makes none; the vendor is told recording false', async () => {
    const { rid, p } = await visit({ room: false });
    const payload = { reservationId: rid, patientId: p.patientId };
    assert.equal(await t.W.runCreateMeeting(t.jobs, payload), 'created');
    assert.equal(await t.W.runCreateMeeting(t.jobs, payload), 'exists');
    const s = (await t.sessionOf(rid)) as {
      vendor: string;
      vendor_meeting_id: string;
      recording_enabled: boolean;
      id: string;
    };
    assert.equal(s.vendor, 'sandboxvendor');
    assert.ok(s.vendor_meeting_id.startsWith('mtg-'));
    assert.equal(s.recording_enabled, false);
    const creates = t.video.calls.filter((c) => c.op === 'create' && c.externalId === s.id);
    assert.equal(creates.length, 1);
    assert.equal(creates[0]?.recording, false);
    // the room is set once: the database refuses another
    await rejectsSqlState(
      sys(`UPDATE telehealth.video_session SET vendor_meeting_id = 'other' WHERE id = $1`, [s.id]),
      'PS001',
    );
  });

  test('a vendor outage during create_meeting fails the job (the queue retries) and leaves no room recorded; the retry succeeds', async () => {
    const { rid, p } = await visit({ room: false });
    const payload = { reservationId: rid, patientId: p.patientId };
    t.video.unavailable = true;
    await assert.rejects(t.W.runCreateMeeting(t.jobs, payload));
    assert.equal(
      ((await t.sessionOf(rid)) as { vendor_meeting_id: string | null }).vendor_meeting_id,
      null,
    );
    t.video.unavailable = false;
    assert.equal(await t.W.runCreateMeeting(t.jobs, payload), 'created');
  });

  test('recording cannot be turned on: not by the table, not by the adapter', async () => {
    const { rid } = await visit();
    const s = (await t.sessionOf(rid)) as { id: string };
    await rejectsSqlState(
      sys(
        `UPDATE telehealth.video_session SET recording_enabled = true WHERE id = $1`,
        [s.id],
        true,
      ),
      '23514',
    );
  });

  test('a session exists only for a video reservation of the same patient and clinician', async () => {
    const d = await t.f.doctor();
    const p = await t.f.patient(++seq);
    const other = await t.f.patient(++seq);
    const ip = await t.f.seed(p, d.principalId, slotStart(31, 2), { mode: 'in_person' });
    await rejectsSqlState(
      sys(
        `INSERT INTO telehealth.video_session (id, organisation_id, reservation_id, patient_id, clinician_principal_id) VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), ORG, ip, p.patientId, d.principalId],
      ),
      'PS001',
    );
    const vid = await t.f.seed(p, d.principalId, slotStart(31, 4), { mode: 'video' });
    await rejectsSqlState(
      sys(
        `INSERT INTO telehealth.video_session (id, organisation_id, reservation_id, patient_id, clinician_principal_id) VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), ORG, vid, other.patientId, d.principalId],
      ),
      'PS001',
    );
  });
});

describe('the waiting room, admit and the join token (SEC-D-14, 29.2, 29.3; TC-TH-05 data half)', () => {
  test('TC-TH-05: before the window opens the join is refused with the start; after the slot it is closed', async () => {
    const early = await visit({ startInMin: 60 });
    await asP(early.p, (tx) =>
      t.telehealth.confirmLocation(tx, meta(), early.rid, { state: 'NY' }),
    );
    await assert.rejects(
      t.telehealth.join(early.p.scope, meta(), early.rid),
      (e: { code?: string; extras?: { errors?: { path: string; code: string }[] } }) => {
        assert.equal(e.code, 'telehealth.not_admitted');
        assert.equal(e.extras?.errors?.[0]?.path, '/joinOpensAt');
        return true;
      },
    );
    const view = await asP(early.p, (tx) => t.telehealth.patientView(tx, early.rid));
    assert.equal(
      new Date(view.joinOpensAt).getTime(),
      new Date(view.startsAt).getTime() - 10 * 60_000,
    );
    assert.equal(view.status, 'scheduled');

    const late = await visit({ startInMin: -120, minutes: 30 });
    await asP(late.p, (tx) => t.telehealth.confirmLocation(tx, meta(), late.rid, { state: 'NY' }));
    await rejectsWith(
      t.telehealth.join(late.p.scope, meta(), late.rid),
      'telehealth.session_closed',
    );
    // nothing was created for either
    assert.equal(
      await nrows(
        `SELECT count(*) AS n FROM telehealth.join_token WHERE session_id IN (SELECT id FROM telehealth.video_session WHERE reservation_id = ANY($1))`,
        [[early.rid, late.rid]],
      ),
      0,
    );
  });

  test('a patient who has not said where they are cannot join; the answer comes first, then the waiting room, then the host lets them in', async () => {
    const v = await visit();
    await rejectsWith(t.telehealth.join(v.p.scope, meta(), v.rid), 'telehealth.location_required');
    assert.equal(
      (await asP(v.p, (tx) => t.telehealth.patientView(tx, v.rid))).needsLocationConfirmation,
      true,
    );
    await asP(v.p, (tx) => t.telehealth.confirmLocation(tx, meta(), v.rid, { state: 'NY' }));
    assert.equal(
      (await asP(v.p, (tx) => t.telehealth.patientView(tx, v.rid))).needsLocationConfirmation,
      false,
    );
    // into the waiting room: refused as not admitted, and the trace is kept
    await rejectsWith(t.telehealth.join(v.p.scope, meta(), v.rid), 'telehealth.not_admitted');
    const part = await one<{ admission: string; waiting_since: Date | null; role: string }>(
      `SELECT p.admission, p.waiting_since, p.role FROM telehealth.participant p JOIN telehealth.video_session s ON s.id = p.session_id WHERE s.reservation_id = $1 AND p.role <> 'clinician'`,
      [v.rid],
    );
    assert.equal(part.admission, 'waiting');
    assert.notEqual(part.waiting_since, null);
    assert.equal(part.role, 'patient');
    const hostView = await asH(v.d, (tx) => t.telehealth.hostView(tx, v.rid));
    assert.equal(hostView.waiting.length, 1);
    assert.equal(hostView.waiting[0]?.patientId, v.p.patientId);
    assert.equal(hostView.meetingReady, true);
    // the patient's view says waiting
    assert.equal(
      (await asP(v.p, (tx) => t.telehealth.patientView(tx, v.rid))).admission,
      'waiting',
    );
    // admit (twice: the second changes nothing)
    const a1 = await asH(v.d, (tx) => t.telehealth.admit(tx, meta(), v.rid, {}));
    assert.equal(a1.waiting.length, 0);
    await asH(v.d, (tx) => t.telehealth.admit(tx, meta(), v.rid, {}));
    assert.equal(
      (await asP(v.p, (tx) => t.telehealth.patientView(tx, v.rid))).admission,
      'admitted',
    );
    const grant = await t.telehealth.join(v.p.scope, meta(), v.rid);
    assert.equal(grant.vendor, 'sandboxvendor');
    assert.ok(grant.meetingId.startsWith('mtg-'));
    assert.ok(t.video.tokens.has(grant.attendeeToken));
  });

  test('the host must admit by participant ID; an unknown one is 404, and the patient cannot admit themselves (database rule)', async () => {
    const v = await visit();
    await asP(v.p, (tx) => t.telehealth.confirmLocation(tx, meta(), v.rid, { state: 'NY' }));
    await rejectsWith(t.telehealth.join(v.p.scope, meta(), v.rid), 'telehealth.not_admitted');
    await rejectsWith(
      asH(v.d, (tx) => t.telehealth.admit(tx, meta(), v.rid, { participantId: randomUUID() })),
      'kernel.not_found',
    );
    await rejectsWith(
      asH(v.d, (tx) => t.telehealth.admit(tx, meta(), v.rid, { participantId: 'nope' })),
      'kernel.validation_failed',
    );
    // a patient session writing its own admission straight to the table is refused by the trigger, whatever the column grant says
    await rejectsSqlState(
      asP(v.p, (tx) =>
        tx.query(
          `UPDATE telehealth.participant SET admission = 'admitted', admitted_at = now() WHERE principal_id = $1`,
          [v.p.scope.principalId],
        ),
      ),
      'PS001',
    );
    // another doctor (not the host) cannot admit, view or end
    const stranger = await t.f.doctor();
    await rejectsWith(
      asH(stranger, (tx) => t.telehealth.admit(tx, meta(), v.rid, {})),
      'auth.forbidden',
    );
    await rejectsWith(
      asH(stranger, (tx) => t.telehealth.hostView(tx, v.rid)),
      'auth.forbidden',
    );
    await rejectsWith(
      asH(stranger, (tx) => t.telehealth.end(tx, meta(), v.rid)),
      'auth.forbidden',
    );
    // a patient cannot use the host's methods
    await rejectsWith(
      asP(v.p, (tx) => t.telehealth.admit(tx, meta(), v.rid, {})),
      'auth.forbidden',
    );
  });

  test('a join token is never stored: not in any telehealth table, the audit, the queue or the call log', async () => {
    const v = await visit();
    await admitted(v);
    const grant = await t.telehealth.join(v.p.scope, meta(), v.rid);
    const needle = grant.attendeeToken;
    for (const table of ['video_session', 'participant', 'join_token', 'location_confirmation'])
      assert.equal(
        await nrows(
          `SELECT count(*) AS n FROM telehealth.${table} x WHERE x::text LIKE '%' || $1 || '%'`,
          [needle],
        ),
        0,
        table,
      );
    assert.equal(
      await nrows(`SELECT count(*) AS n FROM audit.event x WHERE x::text LIKE '%' || $1 || '%'`, [
        needle,
      ]),
      0,
    );
    assert.equal(
      await nrows(
        `SELECT count(*) AS n FROM queue._private_jobs x WHERE x::text LIKE '%' || $1 || '%'`,
        [needle],
      ),
      0,
    );
    assert.equal(
      await nrows(
        `SELECT count(*) AS n FROM integration_core.outbound_call x WHERE x::text LIKE '%' || $1 || '%'`,
        [needle],
      ),
      0,
    );
    // the call log does record the call (IDs and outcome)
    assert.ok(
      (await nrows(
        `SELECT count(*) AS n FROM integration_core.outbound_call WHERE operation = 'join_token' AND outcome = 'ok'`,
      )) >= 1,
    );
    // the issue is audited without the token
    assert.ok(
      (await nrows(
        `SELECT count(*) AS n FROM audit.event WHERE resource_type = 'telehealth.join_token'`,
      )) >= 1,
    );
  });

  test('single use, short life: a second join supersedes the first token; at most one is live; each lives at most 15 minutes', async () => {
    const v = await visit();
    await admitted(v);
    const g1 = await t.telehealth.join(v.p.scope, meta(), v.rid);
    const g2 = await t.telehealth.join(v.p.scope, meta(), v.rid);
    assert.notEqual(g1.attendeeToken, g2.attendeeToken);
    const rows = await q<{ status: string; revoke_reason: string | null; life: string }>(
      `SELECT j.status, j.revoke_reason, extract(epoch FROM (j.expires_at - j.issued_at))::text AS life
         FROM telehealth.join_token j JOIN telehealth.video_session s ON s.id = j.session_id WHERE s.reservation_id = $1 ORDER BY j.issued_at, j.id`,
      [v.rid],
    );
    assert.deepEqual(
      rows.map((r) => `${r.status}/${r.revoke_reason}`),
      ['revoked/superseded', 'issued/null'],
    );
    for (const r of rows) assert.ok(Number(r.life) > 0 && Number(r.life) <= 900);
    // the partial unique index backs it: a second live token for the participant is refused by the database
    const part = await one<{
      id: string;
      session_id: string;
      patient_id: string;
      principal_id: string;
    }>(
      `SELECT p.id, p.session_id, p.patient_id, p.principal_id FROM telehealth.participant p JOIN telehealth.video_session s ON s.id = p.session_id WHERE s.reservation_id = $1 AND p.role <> 'clinician'`,
      [v.rid],
    );
    await rejectsSqlState(
      sys(
        `INSERT INTO telehealth.join_token (id, organisation_id, session_id, participant_id, patient_id, principal_id, status, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'issued', now() + interval '5 minutes')`,
        [randomUUID(), ORG, part.session_id, part.id, part.patient_id, part.principal_id],
      ),
      '23505',
    );
    // longer than 15 minutes is refused by the table
    await sys(
      `UPDATE telehealth.join_token SET status = 'revoked', revoke_reason = 'superseded' WHERE participant_id = $1 AND status = 'issued'`,
      [part.id],
    );
    await rejectsSqlState(
      sys(
        `INSERT INTO telehealth.join_token (id, organisation_id, session_id, participant_id, patient_id, principal_id, status, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'issued', now() + interval '16 minutes')`,
        [randomUUID(), ORG, part.session_id, part.id, part.patient_id, part.principal_id],
      ),
      '23514',
    );
  });

  test('two joins at once leave exactly one live token', async () => {
    const v = await visit();
    await admitted(v);
    const r = await Promise.allSettled([
      t.telehealth.join(v.p.scope, meta(), v.rid),
      t.telehealth.join(v.p.scope, meta(), v.rid),
      t.telehealth.join(v.p.scope, meta(), v.rid),
    ]);
    assert.ok(
      r.some((x) => x.status === 'fulfilled'),
      'at least one join succeeds',
    );
    for (const x of r)
      if (x.status === 'rejected')
        assert.equal((x.reason as { code?: string }).code, 'telehealth.vendor_unavailable');
    assert.equal(
      await nrows(
        `SELECT count(*) AS n FROM telehealth.join_token j JOIN telehealth.video_session s ON s.id = j.session_id WHERE s.reservation_id = $1 AND j.status = 'issued'`,
        [v.rid],
      ),
      1,
    );
  });

  test('TC-TH-04 (data half, stub vendor): an outage is a visible 503 with retry, no token is left live, and the join works once the vendor is back', async () => {
    const v = await visit();
    await admitted(v);
    t.video.unavailable = true;
    try {
      await assert.rejects(
        t.telehealth.join(v.p.scope, meta(), v.rid),
        (e: { code?: string; status?: number; retryable?: boolean }) => {
          assert.equal(e.code, 'telehealth.vendor_unavailable');
          assert.equal(e.status, 503);
          assert.equal(e.retryable, true);
          return true;
        },
      );
    } finally {
      t.video.unavailable = false;
    }
    assert.equal(
      await nrows(
        `SELECT count(*) AS n FROM telehealth.join_token j JOIN telehealth.video_session s ON s.id = j.session_id WHERE s.reservation_id = $1 AND j.status = 'issued'`,
        [v.rid],
      ),
      0,
    );
    assert.equal(
      (
        await one<{ revoke_reason: string }>(
          `SELECT j.revoke_reason FROM telehealth.join_token j JOIN telehealth.video_session s ON s.id = j.session_id WHERE s.reservation_id = $1`,
          [v.rid],
        )
      ).revoke_reason,
      'vendor_failed',
    );
    await t.telehealth.join(v.p.scope, meta(), v.rid);
  });

  test('a missing room asks the worker for one and answers 503 retryable; the host joins and the session opens', async () => {
    const v = await visit({ room: false });
    await admitted(v);
    await rejectsWith(t.telehealth.join(v.p.scope, meta(), v.rid), 'telehealth.vendor_unavailable');
    assert.ok(
      (await t.f.jobsInQueue('telehealth.create_meeting')).some(
        (j) => j.payload['reservationId'] === v.rid,
      ),
    );
    await t.W.runCreateMeeting(t.jobs, { reservationId: v.rid, patientId: v.p.patientId });
    await t.telehealth.join(v.p.scope, meta(), v.rid);
    // the host: no location check, no waiting room, the session opens
    const hg = await t.telehealth.join(t.hostScope(v.d), meta(), v.rid);
    assert.ok(t.video.tokens.has(hg.attendeeToken));
    assert.equal(((await t.sessionOf(v.rid)) as { status: string }).status, 'open');
    assert.notEqual(((await t.sessionOf(v.rid)) as { opened_at: Date | null }).opened_at, null);
  });

  test('a device check keeps pass or fail for camera, microphone and bandwidth and nothing else', async () => {
    const v = await visit();
    const ok = await asP(v.p, (tx) =>
      t.telehealth.deviceCheck(tx, meta(), v.rid, {
        camera: 'pass',
        mic: 'pass',
        bandwidth: 'fail',
      }),
    );
    assert.deepEqual(ok, { camera: 'pass', mic: 'pass', bandwidth: 'fail' });
    const stored = await one<{ device_check: Record<string, string> }>(
      `SELECT p.device_check FROM telehealth.participant p JOIN telehealth.video_session s ON s.id = p.session_id WHERE s.reservation_id = $1 AND p.role <> 'clinician'`,
      [v.rid],
    );
    assert.deepEqual(stored.device_check, { camera: 'pass', mic: 'pass', bandwidth: 'fail' });
    for (const bad of [
      { camera: 'pass', mic: 'pass', bandwidth: 'pass', label: 'Cam X' },
      { camera: 'ok', mic: 'pass', bandwidth: 'pass' },
      null,
      'pass',
    ])
      await rejectsWith(
        asP(v.p, (tx) => t.telehealth.deviceCheck(tx, meta(), v.rid, bad)),
        'kernel.validation_failed',
      );
    // the table refuses a device report with extra content, whoever writes it
    await rejectsSqlState(
      sys(
        `UPDATE telehealth.participant SET device_check = '{"camera":"pass","mic":"pass","bandwidth":"pass","name":"x"}'::jsonb WHERE session_id = (SELECT id FROM telehealth.video_session WHERE reservation_id = $1)`,
        [v.rid],
      ),
      '23514',
    );
    // the check puts the patient in the list but NOT in the waiting room (they have not asked to join)
    assert.equal((await asH(v.d, (tx) => t.telehealth.hostView(tx, v.rid))).waiting.length, 0);
    // the device check shows to the host only once they ask to join
    await asP(v.p, (tx) => t.telehealth.confirmLocation(tx, meta(), v.rid, { state: 'NY' }));
    await rejectsWith(t.telehealth.join(v.p.scope, meta(), v.rid), 'telehealth.not_admitted');
    const w = await asH(v.d, (tx) => t.telehealth.hostView(tx, v.rid));
    assert.deepEqual(w.waiting[0]?.deviceCheck, { camera: 'pass', mic: 'pass', bandwidth: 'fail' });
  });

  test('TC-TH-03: nobody reaches another patient’s session: 404 for every patient-side call and the participant rows stay invisible', async () => {
    const v = await visit();
    await admitted(v);
    const other = await t.f.bare(++seq);
    await rejectsWith(
      asP(other, (tx) => t.telehealth.patientView(tx, v.rid)),
      'kernel.not_found',
    );
    await rejectsWith(
      asP(other, (tx) =>
        t.telehealth.deviceCheck(tx, meta(), v.rid, {
          camera: 'pass',
          mic: 'pass',
          bandwidth: 'pass',
        }),
      ),
      'kernel.not_found',
    );
    await rejectsWith(
      asP(other, (tx) => t.telehealth.confirmLocation(tx, meta(), v.rid, { state: 'NY' })),
      'kernel.not_found',
    );
    await rejectsWith(t.telehealth.join(other.scope, meta(), v.rid), 'kernel.not_found');
    for (const table of ['video_session', 'participant', 'join_token', 'location_confirmation'])
      assert.equal(
        (await asP(other, (tx) => tx.query(`SELECT 1 FROM telehealth.${table}`))).rows.length,
        0,
        table,
      );
    // and a row cannot be written for somebody else: RLS hides the reservation, so a copy of it yields no row to insert ...
    const ins = await asP(other, (tx) =>
      tx.query(
        `INSERT INTO telehealth.location_confirmation (id, organisation_id, reservation_id, patient_id, principal_id, stated_state, result, created_by)
         SELECT gen_random_uuid(), kernel.uuid1('app.org_id'), r.id, r.patient_id, $1::uuid, 'NY', 'allowed', $1::uuid FROM scheduling.slot_reservation r WHERE r.id = $2::uuid`,
        [other.scope.principalId, v.rid],
      ),
    );
    assert.equal(ins.rowCount, 0);
    // ... and naming the reservation outright is refused by the database (it belongs to its own patient)
    await rejectsSqlState(
      asP(other, (tx) =>
        tx.query(
          `INSERT INTO telehealth.location_confirmation (id, organisation_id, reservation_id, patient_id, principal_id, stated_state, result, created_by)
           VALUES (gen_random_uuid(), kernel.uuid1('app.org_id'), $2::uuid, $3::uuid, $1::uuid, 'NY', 'allowed', $1::uuid)`,
          [other.scope.principalId, v.rid, other.patientId],
        ),
      ),
      'PS001',
    );
    assert.equal(
      await nrows(
        `SELECT count(*) AS n FROM telehealth.location_confirmation WHERE principal_id = $1`,
        [other.scope.principalId],
      ),
      0,
    );
  });
});

describe('licensing at join (RA-R1-28, TL-1; TC-TH-07, TC-TH-08)', () => {
  test('TC-TH-07: outside the licensed states the join is refused and the answer is kept; inside, the join goes on', async () => {
    const v = await visit({ states: ['NY'] });
    const out = await asP(v.p, (tx) =>
      t.telehealth.confirmLocation(tx, meta(), v.rid, { state: 'ca' }),
    );
    assert.equal(out.result, 'refused_not_licensed');
    assert.equal(out.flagged, false);
    assert.throws(() => TelehealthService.assertAllowed(out), {
      code: 'telehealth.licensing_refused',
    });
    // a refusal is a K row, not rolled back
    const k1 = await one<{ result: string; stated_state: string; override_reason: string | null }>(
      `SELECT result, stated_state, override_reason FROM telehealth.location_confirmation WHERE reservation_id = $1`,
      [v.rid],
    );
    assert.deepEqual(k1, {
      result: 'refused_not_licensed',
      stated_state: 'CA',
      override_reason: null,
    });
    // not operating: NJ
    const nj = await asP(v.p, (tx) =>
      t.telehealth.confirmLocation(tx, meta(), v.rid, { state: 'NJ' }),
    );
    assert.equal(nj.result, 'refused_not_operating');
    // the join is refused while the latest answer fails the rule
    await rejectsWith(t.telehealth.join(v.p.scope, meta(), v.rid), 'telehealth.licensing_refused');
    // "I am in X": allowed, and the join goes on
    const ok = await asP(v.p, (tx) =>
      t.telehealth.confirmLocation(tx, meta(), v.rid, { state: 'NY' }),
    );
    assert.equal(ok.result, 'allowed');
    await rejectsWith(t.telehealth.join(v.p.scope, meta(), v.rid), 'telehealth.not_admitted');
    await asH(v.d, (tx) => t.telehealth.admit(tx, meta(), v.rid, {}));
    const g = await t.telehealth.join(v.p.scope, meta(), v.rid);
    assert.ok(g.attendeeToken.length > 0);
    // bad input is a validation error naming the field only
    for (const bad of [undefined, '', 'N', 'NYC', 5, '1!']) {
      await rejectsWith(
        asP(v.p, (tx) => t.telehealth.confirmLocation(tx, meta(), v.rid, { state: bad })),
        'kernel.validation_failed',
      );
    }
    // every attempt is kept and audited, without the state in the audit change
    assert.equal(
      await nrows(
        `SELECT count(*) AS n FROM telehealth.location_confirmation WHERE reservation_id = $1`,
        [v.rid],
      ),
      3,
    );
    assert.ok(
      (await nrows(
        `SELECT count(*) AS n FROM audit.event WHERE resource_type = 'telehealth.location_confirmation'`,
      )) >= 3,
    );
    assert.equal(
      await nrows(
        `SELECT count(*) AS n FROM audit.event WHERE resource_type = 'telehealth.location_confirmation' AND change::text LIKE '%CA%'`,
      ),
      0,
    );
  });

  test('the confirmation rows are append-only for every role', async () => {
    const v = await visit();
    await asP(v.p, (tx) => t.telehealth.confirmLocation(tx, meta(), v.rid, { state: 'NY' }));
    await rejectsSqlState(
      sys(
        `UPDATE telehealth.location_confirmation SET stated_state = 'CA' WHERE reservation_id = $1`,
        [v.rid],
      ),
      'PS001',
    );
    await rejectsSqlState(
      sys(`DELETE FROM telehealth.location_confirmation WHERE reservation_id = $1`, [v.rid]),
      'PS001',
    );
    await rejectsSqlState(
      asP(v.p, (tx) => tx.query(`UPDATE telehealth.location_confirmation SET result = 'allowed'`)),
      '42501',
    );
  });

  test('flag mode: the rule says no, the visit goes on, and the row says so', async () => {
    const v = await visit({ states: ['NY'] });
    await t.f.k.sa.query(
      `UPDATE kernel.setting SET value = '"flag"' WHERE key = 'telehealth_licensing_mode'`,
    );
    try {
      const out = await asP(v.p, (tx) =>
        t.telehealth.confirmLocation(tx, meta(), v.rid, { state: 'CA' }),
      );
      assert.deepEqual(out, { result: 'refused_not_licensed', flagged: true });
      TelehealthService.assertAllowed(out);
      assert.equal(
        (
          await one<{ override_reason: string }>(
            `SELECT override_reason FROM telehealth.location_confirmation WHERE reservation_id = $1`,
            [v.rid],
          )
        ).override_reason,
        'licensing_mode_flag',
      );
      assert.equal(
        (await asP(v.p, (tx) => t.telehealth.patientView(tx, v.rid))).needsLocationConfirmation,
        false,
      );
      await rejectsWith(t.telehealth.join(v.p.scope, meta(), v.rid), 'telehealth.not_admitted');
      await asH(v.d, (tx) => t.telehealth.admit(tx, meta(), v.rid, {}));
      await t.telehealth.join(v.p.scope, meta(), v.rid);
    } finally {
      await t.f.k.sa.query(
        `UPDATE kernel.setting SET value = '"refuse"' WHERE key = 'telehealth_licensing_mode'`,
      );
    }
  });

  test('TC-TH-08: a licence removed after the answer refuses the join again with a safe message; re-adding it allows it', async () => {
    const v = await visit({ states: ['NY'] });
    await admitted(v);
    await t.telehealth.join(v.p.scope, meta(), v.rid);
    await t.license(v.d.principalId, []); // X removed from the clinician's licensed states
    assert.equal(
      (await asP(v.p, (tx) => t.telehealth.patientView(tx, v.rid))).needsLocationConfirmation,
      true,
    );
    await assert.rejects(
      t.telehealth.join(v.p.scope, meta(), v.rid),
      (e: { code?: string; status?: number; message?: string; extras?: unknown }) => {
        assert.equal(e.code, 'telehealth.licensing_refused');
        assert.equal(e.status, 422);
        // a safe message: the code only, no state, no name, no clinician
        assert.ok(!/NY|New York|Doctor/i.test(JSON.stringify({ m: e.message, x: e.extras })));
        return true;
      },
    );
    await t.license(v.d.principalId, ['NY']);
    assert.equal(
      (await asP(v.p, (tx) => t.telehealth.patientView(tx, v.rid))).needsLocationConfirmation,
      false,
    );
    await t.telehealth.join(v.p.scope, meta(), v.rid);
  });

  test('an answer older than 12 hours is not good enough', async () => {
    const v = await visit();
    await admitted(v);
    await sys(
      `UPDATE telehealth.location_confirmation SET confirmed_at = now() - interval '13 hours' WHERE reservation_id = $1`,
      [v.rid],
      true,
    );
    assert.equal(
      (await asP(v.p, (tx) => t.telehealth.patientView(tx, v.rid))).needsLocationConfirmation,
      true,
    );
    await rejectsWith(t.telehealth.join(v.p.scope, meta(), v.rid), 'telehealth.location_required');
  });
});

describe('the end of a visit and stale sessions (25.x, 33.1 telehealth.end_stale; ST-4)', () => {
  test('ending revokes every live token first, then the session; repeating changes nothing; a joined visit is closed to everybody', async () => {
    const v = await visit();
    await admitted(v);
    await t.telehealth.join(v.p.scope, meta(), v.rid);
    await t.telehealth.join(t.hostScope(v.d), meta(), v.rid);
    const r1 = await asH(v.d, (tx) => t.telehealth.end(tx, meta(), v.rid));
    assert.equal(r1.view.status, 'ended');
    assert.ok(r1.vendorClose !== undefined);
    assert.equal(await t.telehealth.closeAtVendor(r1.vendorClose as never), true);
    assert.equal(
      await nrows(
        `SELECT count(*) AS n FROM telehealth.join_token j JOIN telehealth.video_session s ON s.id = j.session_id WHERE s.reservation_id = $1 AND j.status = 'issued'`,
        [v.rid],
      ),
      0,
    );
    assert.equal(
      await nrows(
        `SELECT count(*) AS n FROM telehealth.join_token j JOIN telehealth.video_session s ON s.id = j.session_id WHERE s.reservation_id = $1 AND j.revoke_reason = 'session_ended'`,
        [v.rid],
      ),
      2,
    );
    const s = (await t.sessionOf(v.rid)) as { status: string; ended_at: Date | null };
    assert.equal(s.status, 'ended');
    assert.notEqual(s.ended_at, null);
    assert.equal(
      await nrows(
        `SELECT count(*) AS n FROM telehealth.participant p JOIN telehealth.video_session s ON s.id = p.session_id WHERE s.reservation_id = $1 AND p.left_at IS NULL AND p.joined_at IS NOT NULL`,
        [v.rid],
      ),
      0,
    );
    // again: the same answer, no second vendor close
    const r2 = await asH(v.d, (tx) => t.telehealth.end(tx, meta(), v.rid));
    assert.equal(r2.view.status, 'ended');
    assert.equal(r2.vendorClose, undefined);
    assert.ok(t.video.meetings.get(((await t.sessionOf(v.rid)) as { id: string }).id)?.ended);
    // closed to the patient and the host
    await rejectsWith(t.telehealth.join(v.p.scope, meta(), v.rid), 'telehealth.session_closed');
    await rejectsWith(
      t.telehealth.join(t.hostScope(v.d), meta(), v.rid),
      'telehealth.session_closed',
    );
    await rejectsWith(
      asP(v.p, (tx) =>
        t.telehealth.deviceCheck(tx, meta(), v.rid, {
          camera: 'pass',
          mic: 'pass',
          bandwidth: 'pass',
        }),
      ),
      'telehealth.session_closed',
    );
  });

  test('38.2 item 2: an ended session accepts no change for any role, nor do its participants and tokens; a session cannot end while it holds a live token', async () => {
    const v = await visit();
    await admitted(v);
    await t.telehealth.join(v.p.scope, meta(), v.rid);
    const sid = ((await t.sessionOf(v.rid)) as { id: string }).id;
    // a live token blocks the end
    await rejectsSqlState(
      sys(`UPDATE telehealth.video_session SET status = 'ended' WHERE id = $1`, [sid]),
      'PS001',
    );
    await asH(v.d, (tx) => t.telehealth.end(tx, meta(), v.rid));
    // K: the session, its participants, its tokens
    await rejectsSqlState(
      sys(`UPDATE telehealth.video_session SET status = 'open' WHERE id = $1`, [sid]),
      'PS001',
    );
    await rejectsSqlState(
      sys(`UPDATE telehealth.participant SET left_at = now() WHERE session_id = $1`, [sid]),
      'PS001',
    );
    await rejectsSqlState(
      sys(`UPDATE telehealth.join_token SET revoke_reason = 'kill_switch' WHERE session_id = $1`, [
        sid,
      ]),
      'PS001',
    );
    // and for the worker role as well (a data_repair job is no exception, TDR-03)
    await rejectsSqlState(
      t.f.worker.withScope(t.f.workerScope, (tx) =>
        tx.query(`UPDATE telehealth.video_session SET vendor = 'x' WHERE id = $1`, [sid]),
      ),
      'PS001',
    );
    // no new participant, no new token in a finished session
    const part = await one<{ patient_id: string; principal_id: string }>(
      `SELECT patient_id, principal_id FROM telehealth.participant WHERE session_id = $1 AND role <> 'clinician'`,
      [sid],
    );
    await rejectsSqlState(
      sys(
        `INSERT INTO telehealth.participant (id, organisation_id, session_id, patient_id, role, principal_id) VALUES ($1, $2, $3, $4, 'proxy', $5)`,
        [randomUUID(), ORG, sid, part.patient_id, v.d.principalId],
      ),
      'PS001',
    );
  });

  test('end_stale ends a session two hours after its slot (tokens revoked first, the vendor told), marks one with no room failed, and leaves a recent one', async () => {
    const stale = await visit({ startInMin: -200, minutes: 30 });
    const recent = await visit({ startInMin: -100, minutes: 30 }); // ended 70 minutes ago: not yet
    const noRoom = await visit({ startInMin: -200, minutes: 30, room: false });
    const sid = ((await t.sessionOf(stale.rid)) as { id: string }).id;
    // a live token on the stale one: write it as the join would (the slot is long over, so go direct)
    const part = await sys(
      `INSERT INTO telehealth.participant (id, organisation_id, session_id, patient_id, role, principal_id)
       VALUES ($1, $2, $3, $4, 'patient', $5) RETURNING id`,
      [randomUUID(), ORG, sid, stale.p.patientId, stale.p.scope.principalId],
    );
    await sys(
      `UPDATE telehealth.participant SET admission = 'admitted', admitted_at = now(), admitted_by = $2 WHERE id = $1`,
      [(part.rows[0] as { id: string }).id, stale.d.principalId],
    );
    await sys(
      `INSERT INTO telehealth.join_token (id, organisation_id, session_id, participant_id, patient_id, principal_id, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'issued', now() + interval '5 minutes')`,
      [
        randomUUID(),
        ORG,
        sid,
        (part.rows[0] as { id: string }).id,
        stale.p.patientId,
        stale.p.scope.principalId,
      ],
    );
    const r = await t.W.runEndStale(t.jobs);
    assert.ok(r.listed >= 2);
    assert.equal(((await t.sessionOf(stale.rid)) as { status: string }).status, 'ended');
    assert.equal(((await t.sessionOf(noRoom.rid)) as { status: string }).status, 'failed');
    assert.equal(((await t.sessionOf(recent.rid)) as { status: string }).status, 'scheduled');
    assert.equal(
      await nrows(
        `SELECT count(*) AS n FROM telehealth.join_token WHERE session_id = $1 AND status = 'issued'`,
        [sid],
      ),
      0,
    );
    assert.ok(t.video.meetings.get(sid)?.ended);
    // a second run finds nothing more for these
    const again = await t.W.runEndStale(t.jobs);
    assert.equal(again.ended + again.failed, 0);
    assert.equal(((await t.sessionOf(stale.rid)) as { status: string }).status, 'ended');
  });
});

describe('merge participant and export (22.16, 38.2 item 11; HEAAA-88 registry)', () => {
  test('the count test: sessions, participants and tokens in R are re-pointed, K rows stay, found = re-pointed + resolved + kept, no R row is left', async () => {
    const d1 = await t.f.doctor();
    const d2 = await t.f.doctor();
    await t.license(d1.principalId, ['NY']);
    await t.license(d2.principalId, ['NY']);
    const merged = await t.f.patient(++seq);
    const survivor = await t.f.patient(++seq);
    const live = await t.video_visit(merged, d1, inMin(5));
    const done = await t.video_visit(merged, d2, inMin(5));
    // live: the patient asked, was admitted and holds a token
    const v1 = { d: d1, p: merged, rid: live };
    await admitted(v1);
    await t.telehealth.join(merged.scope, meta(), live);
    // done: the host joined and ended (K session, K participant, K token)
    await t.telehealth.join(t.hostScope(d2), meta(), done);
    await asH(d2, (tx) => t.telehealth.end(tx, meta(), done));
    await asP(merged, (tx) =>
      t.telehealth.confirmLocation(tx, meta(), done, { state: 'NY' }),
    ).catch(() => undefined);

    const { result } = await t.f.merge(survivor.patientId, merged.patientId);
    assert.equal(result.status, 'completed', JSON.stringify(result));
    if (result.status !== 'completed') return;
    const c = result.counts;
    assert.deepEqual(c['telehealth.video_session'], {
      found: 2,
      repointed: 1,
      resolved: 0,
      kept: 1,
    });
    // live: the patient's row (R); done: the host's row (K, its session ended)
    assert.deepEqual(c['telehealth.participant'], { found: 2, repointed: 1, resolved: 0, kept: 1 });
    assert.deepEqual(c['telehealth.join_token'], { found: 2, repointed: 1, resolved: 0, kept: 1 });
    const loc = c['telehealth.location_confirmation'];
    assert.equal(loc?.repointed, 0);
    assert.equal(loc?.found, loc?.kept);
    for (const k of Object.keys(c).filter((x) => x.startsWith('telehealth.')) as string[]) {
      const x = c[k] as { found: number; repointed: number; resolved: number; kept: number };
      assert.equal(x.found, x.repointed + x.resolved + x.kept, k);
    }
    // no R row left on the merged ID; the live visit is the survivor's; the finished one stays where it was
    assert.equal(
      await nrows(
        `SELECT count(*) AS n FROM telehealth.video_session WHERE patient_id = $1 AND status IN ('scheduled', 'open')`,
        [merged.patientId],
      ),
      0,
    );
    assert.equal(
      await nrows(
        `SELECT count(*) AS n FROM telehealth.participant p JOIN telehealth.video_session s ON s.id = p.session_id WHERE p.patient_id = $1 AND s.status IN ('scheduled', 'open')`,
        [merged.patientId],
      ),
      0,
    );
    assert.equal(
      await nrows(
        `SELECT count(*) AS n FROM telehealth.join_token WHERE patient_id = $1 AND status = 'issued'`,
        [merged.patientId],
      ),
      0,
    );
    assert.equal(
      ((await t.sessionOf(live)) as { patient_id: string }).patient_id,
      survivor.patientId,
    );
    assert.equal(
      ((await t.sessionOf(done)) as { patient_id: string }).patient_id,
      merged.patientId,
    );
    assert.equal(
      await nrows(
        `SELECT count(*) AS n FROM telehealth.join_token WHERE patient_id = $1 AND status = 'issued'`,
        [survivor.patientId],
      ),
      1,
    );
  });

  test('a module that holds patient data and has no participant fails the merge before anything is written', async () => {
    const d = await t.f.doctor();
    await t.license(d.principalId, ['NY']);
    const merged = await t.f.patient(++seq);
    const survivor = await t.f.patient(++seq);
    const rid = await t.video_visit(merged, d, inMin(5));
    const regs = newRegisteredRegistries({ without: ['telehealth'] }); // negative control: telehealth alone is missing
    const { result } = await t.f.merge(survivor.patientId, merged.patientId, { registries: regs });
    assert.equal(result.status, 'failed');
    if (result.status === 'failed') assert.equal(result.code, 'patient.merge_participant_missing');
    assert.equal(((await t.sessionOf(rid)) as { patient_id: string }).patient_id, merged.patientId);
  });

  test('the privacy export part: identifiers, states, times and the pass/fail device check; no token, no vendor reference', async () => {
    const v = await visit();
    await asP(v.p, (tx) =>
      t.telehealth.deviceCheck(tx, meta(), v.rid, {
        camera: 'pass',
        mic: 'pass',
        bandwidth: 'pass',
      }),
    );
    await admitted(v);
    const g = await t.telehealth.join(v.p.scope, meta(), v.rid);
    const part = (await t.f.worker.withScope(t.f.workerScope, (tx) =>
      telehealthExportContributor.exportPart(tx, [v.p.patientId], randomUUID()),
    )) as {
      videoSessions: Record<string, unknown>[];
      videoParticipants: Record<string, unknown>[];
      locationConfirmations: Record<string, unknown>[];
    };
    assert.equal(part.videoSessions.length, 1);
    assert.equal(part.videoSessions[0]?.['reservationId'], v.rid);
    assert.equal(part.locationConfirmations.length, 1);
    assert.ok(part.videoParticipants.length >= 1);
    const text = JSON.stringify(part);
    assert.ok(!text.includes(g.attendeeToken));
    assert.ok(!text.includes(g.meetingId));
    assert.ok(!/vendor/i.test(Object.keys(part.videoSessions[0] ?? {}).join(',')));
  });
});
