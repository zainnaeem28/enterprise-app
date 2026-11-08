// Real-database tests of the scheduling flow (BE-13): check-in (desk and QR), pre-visit flags, the arrivals board, the queue, the no-show
// decision and the sweep, and the database rules under them (ARCHITECTURE 22.8, 25.5; TC-PC-01..03, 05, 06, 09). PostgreSQL 17, the real
// Nest application and guard, the real migrations; synthetic data only. Waitlist and merge are in waitlist.dbtest.ts.
//   EHR_TEST_ADMIN_URL=postgres://postgres@host:5432/postgres node --test dist/src/modules/scheduling/flow/flow.dbtest.js
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import type { ScopeSettings } from '@ehr/kernel';
import {
  A1,
  A2,
  B1,
  ORG,
  ROOM1,
  ROOM2,
  SVC,
  SVC_IP,
  call,
  setupFlow,
  staffMember,
  workerJobs,
  writeHeaders,
} from './testkit.js';
import type { FlowKit, PatientKit, WorkerJobs } from './testkit.js';
import { qrToken, SCHEDULING_FLOW_JOBS } from './index.js';
import { CLINICIAN_PREDICATE, arrivalsSql } from './service.js';

let t: FlowKit;
let W: WorkerJobs;
before(async () => {
  t = await setupFlow('fl');
  W = await workerJobs();
});
after(async () => {
  await t?.close();
});

// A fixed day: the service's own clock is pinned, the appointments are written directly, so nothing depends on the time the suite runs.
const NOW = new Date('2031-03-04T15:00:00.000Z'); // 10:00 in New York (EST)
const APPT = new Date('2031-03-04T15:30:00.000Z');
const meta = () => ({ requestId: randomUUID() });
const q = <R = Record<string, unknown>>(sql: string, p?: unknown[]): Promise<R[]> =>
  t.k.q<R>(sql, p);
const one = async <R = Record<string, unknown>>(sql: string, p?: unknown[]): Promise<R> =>
  (await q<R>(sql, p))[0] as R;
const nrows = async (sql: string, p?: unknown[]): Promise<number> =>
  Number((await one<{ n: string }>(sql, p)).n);
const status = async (rid: string): Promise<string> =>
  (
    await one<{ status: string }>(`SELECT status FROM scheduling.slot_occupancy WHERE id = $1`, [
      rid,
    ])
  ).status;
const version = async (rid: string): Promise<number> =>
  Number(
    (
      await one<{ v: string }>(
        `SELECT (r.row_version + o.row_version) AS v FROM scheduling.slot_reservation r JOIN scheduling.slot_occupancy o ON o.id = r.id WHERE r.id = $1`,
        [rid],
      )
    ).v,
  );
/** A direct write as the superuser, inside the organisation and audience the merge write guard reads (it refuses a write with no context). */
const sys = async (sql: string, p: unknown[] = []) => {
  await t.k.sa.query('BEGIN');
  try {
    await t.k.sa.query(
      `SELECT set_config('app.org_id', $1, true), set_config('app.audience', 'system', true)`,
      [ORG],
    );
    const r = await t.k.sa.query(sql, p);
    await t.k.sa.query('COMMIT');
    return r;
  } catch (e) {
    await t.k.sa.query('ROLLBACK');
    throw e;
  }
};
const desk = (): Promise<ScopeSettings> => t.staffScope([A1], 'front_desk');
const rejectsWith = (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (e: { code?: string; status?: number }) => {
    assert.equal(e.code, code);
    return true;
  });
const rejectsSqlState = (p: Promise<unknown>, state: string) =>
  assert.rejects(p, (e: { code?: string }) => {
    assert.equal(e.code, state);
    return true;
  });

async function visit(
  n: number,
  over: { status?: string; mode?: 'in_person' | 'video'; start?: Date; serviceId?: string } = {},
): Promise<{ p: PatientKit; rid: string; doc: string }> {
  const p = await t.patient(n);
  const doc = (await t.doctor()).principalId;
  const rid = await t.seed(p, doc, over.start ?? APPT, {
    ...(over.status === undefined ? {} : { status: over.status }),
    ...(over.mode === undefined ? {} : { mode: over.mode }),
    ...(over.serviceId === undefined ? {} : { serviceId: over.serviceId }),
  });
  return { p, rid, doc };
}

describe('check-in at the desk (25.5, TC-PC-01)', () => {
  test('moves the visit to checked in, writes the check-in and the queue entry together, audited, and the patient is in the queue', async () => {
    t.clock.at = NOW;
    const { p, rid } = await visit(1);
    const r = await t.as(await desk(), (tx) => t.flow.checkIn(tx, meta(), rid, { method: 'desk' }));
    assert.equal(r.method, 'desk');
    assert.equal(r.alreadyCheckedIn, false);
    assert.equal(r.reservationId, rid);
    assert.equal(r.queueEntryId, rid);
    assert.equal(await status(rid), 'checked_in');
    const ci = await one<{ method: string; patient_id: string; location_id: string }>(
      `SELECT method, patient_id, location_id FROM scheduling.check_in WHERE id = $1`,
      [rid],
    );
    assert.deepEqual([ci.method, ci.patient_id, ci.location_id], ['desk', p.patientId, A1]);
    const qe = await one<{ stage: string; triage_category: string | null }>(
      `SELECT stage, triage_category FROM scheduling.queue_entry WHERE id = $1`,
      [rid],
    );
    assert.deepEqual([qe.stage, qe.triage_category], ['waiting', null]);
    const a = await one<{ action: string; patient_id: string; location_id: string }>(
      `SELECT action, patient_id, location_id FROM audit.event WHERE resource_type = 'scheduling.check_in' AND resource_id = $1`,
      [rid],
    );
    assert.deepEqual([a.action, a.patient_id, a.location_id], ['create', p.patientId, A1]);
    t.clock.at = undefined;
    const queue = await t.as(await desk(), (tx) => t.flow.queue(tx, A1));
    assert.ok(queue.some((e) => e.id === rid && e.stage === 'waiting'));
  });

  test('repeating it changes nothing and returns the same result', async () => {
    t.clock.at = NOW;
    const { rid } = await visit(2);
    const s = await desk();
    const first = await t.as(s, (tx) => t.flow.checkIn(tx, meta(), rid, { method: 'desk' }));
    const again = await t.as(s, (tx) => t.flow.checkIn(tx, meta(), rid, { method: 'desk' }));
    assert.equal(again.alreadyCheckedIn, true);
    assert.equal(again.checkedInAt, first.checkedInAt);
    assert.equal(
      await nrows(`SELECT count(*) AS n FROM scheduling.check_in WHERE id = $1`, [rid]),
      1,
    );
    assert.equal(
      await nrows(
        `SELECT count(*) AS n FROM audit.event WHERE resource_type = 'scheduling.check_in' AND resource_id = $1`,
        [rid],
      ),
      1,
    );
  });

  test('not allowed: another day, a video visit, a cancelled or held or finished visit, another location (422 scheduling.check_in_not_allowed)', async () => {
    t.clock.at = NOW;
    const s = await desk();
    const tomorrow = await visit(3, { start: new Date(APPT.getTime() + 86_400_000) });
    await rejectsWith(
      t.as(s, (tx) => t.flow.checkIn(tx, meta(), tomorrow.rid, { method: 'desk' })),
      'scheduling.check_in_not_allowed',
    );
    const video = await visit(4, { mode: 'video' });
    await rejectsWith(
      t.as(s, (tx) => t.flow.checkIn(tx, meta(), video.rid, { method: 'desk' })),
      'scheduling.check_in_not_allowed',
    );
    for (const [i, st] of ['cancelled_patient', 'held', 'no_show', 'completed'].entries()) {
      const v = await visit(5 + i, { status: st });
      await rejectsWith(
        t.as(s, (tx) => t.flow.checkIn(tx, meta(), v.rid, { method: 'desk' })),
        'scheduling.check_in_not_allowed',
      );
      assert.equal(
        await nrows(`SELECT count(*) AS n FROM scheduling.check_in WHERE id = $1`, [v.rid]),
        0,
        st,
      );
    }
    // a desk at B1 cannot check in an A1 visit (the service refuses; the guard and the policies refuse it as well, below)
    const ok = await visit(10);
    await assert.rejects(
      t.as(await t.staffScope([B1]), (tx) =>
        t.flow.checkIn(tx, meta(), ok.rid, { method: 'desk' }),
      ),
      (e: { code?: string }) => e.code === 'kernel.not_found' || e.code === 'auth.forbidden',
    );
    assert.equal(await status(ok.rid), 'confirmed');
  });

  test('the staff route: guard, If-Match, idempotency, the registry codes (29.3)', async () => {
    t.clock.at = NOW;
    const { rid } = await visit(11);
    const path = `/api/v1/appointments/${rid}/check-in`;
    const v = await version(rid);
    const post = (key: string, ifMatch: string | undefined, who = t.deskA1) =>
      call(t.k.base, 'POST', path, {
        cookie: who.cookie,
        headers: {
          ...writeHeaders(who, undefined, key),
          ...(ifMatch === undefined ? {} : { 'if-match': ifMatch }),
        },
        body: {},
      });
    assert.equal((await post(randomUUID(), undefined)).status, 428);
    assert.equal((await post(randomUUID(), `W/"${v + 7}"`)).status, 412);
    assert.equal(
      (await post(randomUUID(), `W/"${v}"`, t.deskB1)).status,
      404,
      'a desk at another location does not see the visit (CN-04)',
    );
    const key = randomUUID();
    const r1 = await post(key, `W/"${v}"`);
    assert.equal(r1.status, 200, r1.body);
    assert.equal(r1.json()['method'], 'desk');
    const prev = r1.json()['previsit'] as Record<string, unknown>;
    assert.deepEqual(Object.keys(prev).sort(), ['consents', 'insurance', 'questionnaire']);
    assert.ok(Object.values(prev).every((x) => typeof x === 'boolean'));
    const r2 = await post(key, `W/"${v}"`);
    assert.equal(r2.status, 200);
    assert.equal(r2.headers['idempotent-replay'], 'true');
    assert.equal((await post(key, `W/"${v}"`)).status, 200);
    assert.equal(
      await nrows(`SELECT count(*) AS n FROM scheduling.check_in WHERE id = $1`, [rid]),
      1,
    );
    // a role without the permission is refused by the guard (a medical-records user holds no scheduling.check_in)
    assert.equal((await post(randomUUID(), `W/"${v}"`, t.mr)).status, 403);
  });
});

describe('check-in by QR (25.5, 22.8 note, TC-PC-02)', () => {
  test("the staff screen shows today's token; the patient checks in with it; a wrong, stale or other-day token and another patient's visit fail", async () => {
    t.clock.at = NOW;
    const { p, rid } = await visit(20);
    const qrRes = await call(t.k.base, 'GET', `/api/v1/locations/${A1}/check-in-qr`, {
      cookie: t.deskA1.cookie,
    });
    assert.equal(qrRes.status, 200, qrRes.body);
    assert.equal(qrRes.json()['localDate'], '2031-03-04');
    const token = qrRes.json()['token'] as string;
    assert.equal(
      token,
      qrToken(Buffer.from('qr-key-for-tests-0123456789abcdef0123'), A1, '2031-03-04'),
    );
    assert.equal(Buffer.from(token, 'base64url').length, 16, '128 bits');
    // a desk at another location cannot read this location's token
    assert.equal(
      (
        await call(t.k.base, 'GET', `/api/v1/locations/${A1}/check-in-qr`, {
          cookie: t.deskB1.cookie,
        })
      ).status,
      403,
    );

    const post = (who: PatientKit, body: unknown) =>
      call(t.k.base, 'POST', '/api/v1/check-ins', {
        host: 'my.example.test',
        cookie: who.session.cookie,
        headers: writeHeaders(who.session, 'my.example.test', randomUUID()),
        body,
      });
    assert.equal(
      (await post(p, { reservationId: rid, qrToken: 'AAAAAAAAAAAAAAAAAAAAAA' })).status,
      422,
      'wrong token',
    );
    assert.equal((await post(p, { reservationId: rid })).status, 422, 'no token');
    assert.equal(
      (
        await post(p, {
          reservationId: rid,
          qrToken: qrToken(Buffer.from('qr-key-for-tests-0123456789abcdef0123'), A1, '2031-03-03'),
        })
      ).status,
      422,
      "yesterday's token",
    );
    assert.equal(
      (
        await post(p, {
          reservationId: rid,
          qrToken: qrToken(Buffer.from('another-key-another-key-another-key'), A1, '2031-03-04'),
        })
      ).status,
      422,
      'a token made with another key',
    );
    assert.equal(
      (
        await post(p, {
          reservationId: rid,
          qrToken: qrToken(Buffer.from('qr-key-for-tests-0123456789abcdef0123'), A2, '2031-03-04'),
        })
      ).status,
      422,
      "another location's token",
    );
    assert.equal(await status(rid), 'confirmed');
    // another patient's visit is not visible to this patient: 404 (CN-04), whatever the token
    const other = await t.bare(21);
    assert.equal((await post(other, { reservationId: rid, qrToken: token })).status, 404);
    assert.equal(await status(rid), 'confirmed');

    const ok = await post(p, { reservationId: rid, qrToken: token });
    assert.equal(ok.status, 200, ok.body);
    assert.equal(ok.json()['method'], 'qr');
    assert.equal(await status(rid), 'checked_in');
    assert.equal(
      (
        await one<{ by_principal_id: string }>(
          `SELECT by_principal_id FROM scheduling.check_in WHERE id = $1`,
          [rid],
        )
      ).by_principal_id,
      p.scope.principalId,
    );
    assert.equal(
      (
        await one<{ stage: string }>(`SELECT stage FROM scheduling.queue_entry WHERE id = $1`, [
          rid,
        ])
      ).stage,
      'waiting',
    );
    // used again (a second tap): the same answer, nothing new
    const again = await post(p, { reservationId: rid, qrToken: token });
    assert.equal(again.status, 200);
    assert.equal(again.json()['alreadyCheckedIn'], true);
    assert.equal(
      await nrows(`SELECT count(*) AS n FROM scheduling.check_in WHERE id = $1`, [rid]),
      1,
    );
    // the next day the same QR no longer works for a visit that day
    t.clock.at = new Date(NOW.getTime() + 86_400_000);
    const tomorrow = await visit(22, { start: new Date(APPT.getTime() + 86_400_000) });
    assert.equal(
      (await post(tomorrow.p, { reservationId: tomorrow.rid, qrToken: token })).status,
      422,
    );
  });

  test('the QR path belongs to the patient audience and the desk path to staff: the other combinations are refused', async () => {
    t.clock.at = NOW;
    const { p, rid } = await visit(23);
    await rejectsWith(
      t.as(p.scope, (tx) => t.flow.checkIn(tx, meta(), rid, { method: 'desk' })),
      'auth.forbidden',
    );
    await rejectsWith(
      t.as(await desk(), (tx) => t.flow.checkIn(tx, meta(), rid, { method: 'qr', qrToken: 'x' })),
      'auth.forbidden',
    );
    assert.equal(await status(rid), 'confirmed');
  });

  test('a desk check-in and a QR check-in at the same moment: one check-in row, both callers get an answer, never two', async () => {
    t.clock.at = NOW;
    const { p, rid } = await visit(24);
    const s = await desk();
    const token = qrToken(Buffer.from('qr-key-for-tests-0123456789abcdef0123'), A1, '2031-03-04');
    const results = await Promise.allSettled([
      ...Array.from({ length: 4 }, () =>
        t.as(s, (tx) => t.flow.checkIn(tx, meta(), rid, { method: 'desk' })),
      ),
      ...Array.from({ length: 4 }, () =>
        t.as(p.scope, (tx) => t.flow.checkIn(tx, meta(), rid, { method: 'qr', qrToken: token })),
      ),
    ]);
    assert.ok(
      results.every((r) => r.status === 'fulfilled'),
      JSON.stringify(results.filter((r) => r.status === 'rejected')),
    );
    assert.equal(
      results.filter(
        (r) =>
          r.status === 'fulfilled' && !(r.value as { alreadyCheckedIn: boolean }).alreadyCheckedIn,
      ).length,
      1,
    );
    assert.equal(
      await nrows(`SELECT count(*) AS n FROM scheduling.check_in WHERE id = $1`, [rid]),
      1,
    );
    assert.equal(
      await nrows(`SELECT count(*) AS n FROM scheduling.queue_entry WHERE id = $1`, [rid]),
      1,
    );
  });

  test('a cancel and a check-in at the same moment: whichever wins, the database never holds a check-in of a cancelled visit', async () => {
    t.clock.at = NOW;
    for (let round = 0; round < 6; round++) {
      const { p, rid } = await visit(30 + round);
      const s = await desk();
      const results = await Promise.allSettled([
        t.as(s, (tx) => t.flow.checkIn(tx, meta(), rid, { method: 'desk' })),
        t.as(p.scope, (tx) => t.core.cancel(tx, meta(), rid, { reason: 'cannot come' })),
      ]);
      const st = await status(rid);
      const ci = await nrows(`SELECT count(*) AS n FROM scheduling.check_in WHERE id = $1`, [rid]);
      if (st === 'checked_in') assert.equal(ci, 1);
      else assert.deepEqual([st, ci], ['cancelled_patient', 0], JSON.stringify(results));
    }
  });
});

describe('pre-visit status (AC-09, F-PC-02, TC-PC-03)', () => {
  test('three booleans: the required consents, the questionnaire and the insurance; the desk sees flags, never content', async () => {
    t.clock.at = NOW;
    const { p, rid } = await visit(40);
    const s = await desk();
    t.previsit.consents.set(SVC, [{ key: 'telehealth', version: 1 }]);
    const flags = () =>
      t.as(
        s,
        async (tx) =>
          (await t.flow.arrivals(tx, A1, '2031-03-04')).find((a) => a.reservationId === rid)
            ?.previsit,
      );
    assert.deepEqual(await flags(), { questionnaire: false, consents: false, insurance: false });
    t.previsit.questionnaire.add(rid);
    assert.deepEqual(await flags(), { questionnaire: true, consents: false, insurance: false });
    await sys(
      `INSERT INTO patient.insurance_coverage (id, organisation_id, patient_id, payer_name, member_id, active) VALUES (gen_random_uuid(), $1, $2, 'Payer', 'M-1', true)`,
      [ORG, p.patientId],
    );
    assert.deepEqual(await flags(), { questionnaire: true, consents: false, insurance: true });
    await sys(
      `INSERT INTO patient.consent (id, organisation_id, patient_id, template_key, template_version, status, signed_at, signer_principal_id, signer_relationship, signed_name)
       VALUES (gen_random_uuid(), $1, $2, 'telehealth', 1, 'signed', now(), $3, 'self', 'Pat Ient')`,
      [ORG, p.patientId, p.scope.principalId],
    );
    assert.deepEqual(await flags(), { questionnaire: true, consents: true, insurance: true });
    t.previsit.consents.delete(SVC);
    // the snapshot stored at check-in is the same three booleans
    const r = await t.as(s, (tx) => t.flow.checkIn(tx, meta(), rid, { method: 'desk' }));
    assert.deepEqual(Object.keys(r.previsit).sort(), ['consents', 'insurance', 'questionnaire']);
    const stored = (
      await one<{ previsit_status: Record<string, unknown> }>(
        `SELECT previsit_status FROM scheduling.check_in WHERE id = $1`,
        [rid],
      )
    ).previsit_status;
    assert.deepEqual(stored, r.previsit);
    // the database refuses a snapshot that holds anything but the three booleans
    await rejectsSqlState(
      sys(
        `UPDATE scheduling.check_in SET previsit_status = '{"questionnaire": true, "consents": true, "insurance": true, "note": "x"}' WHERE id = $1`,
        [rid],
      ),
      '23514',
    );
    // the patient's own view: the same flags, only for their own visit
    const own = await t.as(p.scope, (tx) => t.flow.previsitFor(tx, rid));
    assert.equal(own.reservationId, rid);
    const stranger = await t.bare(41);
    await rejectsWith(
      t.as(stranger.scope, (tx) => t.flow.previsitFor(tx, rid)),
      'kernel.not_found',
    );
    const http = await call(t.k.base, 'GET', `/api/v1/appointments/${rid}/previsit`, {
      host: 'my.example.test',
      cookie: p.session.cookie,
    });
    assert.equal(http.status, 200, http.body);
    assert.deepEqual(Object.keys(http.json()).sort(), [
      'consents',
      'insurance',
      'questionnaire',
      'reservationId',
    ]);
    assert.equal(
      (
        await call(t.k.base, 'GET', `/api/v1/appointments/${rid}/previsit`, {
          host: 'my.example.test',
          cookie: stranger.session.cookie,
        })
      ).status,
      404,
    );
  });
});

describe('arrivals board and queue (29.3, TC-PC-05, TC-PC-06)', () => {
  test('four patients arrive: every one is in the queue, first in first out, with category and wait time; nobody is dropped (PM-confirm-2: category order not asserted)', async () => {
    t.clock.at = NOW;
    const s = await desk();
    const people: { rid: string; minutes: number }[] = [];
    for (const [i, minutes] of [15, 10, 5, 0].entries()) {
      const v = await visit(50 + i);
      await t.as(s, (tx) => t.flow.checkIn(tx, meta(), v.rid, { method: 'desk' }));
      await t.ageEntry(v.rid, minutes);
      people.push({ rid: v.rid, minutes });
    }
    t.clock.at = undefined;
    // the categories: "urgent" for the third, "routine" (standard) for the rest
    for (const [i, x] of people.entries())
      await t.as(s, (tx) =>
        t.flow.setTriageCategory(tx, meta(), x.rid, i === 2 ? 'urgent' : 'standard'),
      );
    const queue = (await t.as(s, (tx) => t.flow.queue(tx, A1))).filter((e) =>
      people.some((x) => x.rid === e.id),
    );
    assert.equal(queue.length, 4);
    assert.deepEqual(
      queue.map((e) => e.id),
      people.map((x) => x.rid),
      'arrival order',
    );
    for (const [i, e] of queue.entries()) {
      const expected = (people[i] as { minutes: number }).minutes * 60;
      assert.ok(
        e.waitSeconds >= expected && e.waitSeconds < expected + 30,
        `wait ${e.waitSeconds} vs ${expected}`,
      );
      assert.equal(e.triageCategory, i === 2 ? 'urgent' : 'standard');
      assert.equal(e.stage, 'waiting');
    }
    // a category outside the list is refused
    await rejectsWith(
      t.as(s, (tx) => t.flow.setTriageCategory(tx, meta(), people[0]?.rid as string, 'whenever')),
      'kernel.validation_failed',
    );
    // done leaves the queue and is final
    const first = queue[0] as (typeof queue)[number];
    const done = await t.as(s, (tx) =>
      t.flow.setStage(tx, meta(), first.id, 'done', first.version),
    );
    assert.equal(done.stage, 'done');
    const after = (await t.as(s, (tx) => t.flow.queue(tx, A1))).filter((e) =>
      people.some((x) => x.rid === e.id),
    );
    assert.equal(after.length, 3);
    await rejectsWith(
      t.as(s, (tx) => t.flow.setStage(tx, meta(), first.id, 'waiting', done.version)),
      'scheduling.invalid_transition',
    );
    await rejectsSqlState(
      sys(`UPDATE scheduling.queue_entry SET stage = 'waiting' WHERE id = $1`, [first.id]),
      'PS001',
    );
  });

  test('the arrivals board lists the day with who has arrived, the queue stage and the flags; a desk sees its own location only', async () => {
    t.clock.at = NOW;
    const s = await desk();
    const a = await visit(60);
    const b = await visit(61);
    await t.as(s, (tx) => t.flow.checkIn(tx, meta(), a.rid, { method: 'desk' }));
    const board = await t.as(s, (tx) => t.flow.arrivals(tx, A1, '2031-03-04'));
    const ra = board.find((x) => x.reservationId === a.rid);
    const rb = board.find((x) => x.reservationId === b.rid);
    assert.equal(ra?.status, 'checked_in');
    assert.equal(ra?.queueStage, 'waiting');
    assert.equal(ra?.method, 'desk');
    assert.equal(rb?.status, 'confirmed');
    assert.equal(rb?.checkedInAt, null);
    assert.equal(rb?.patientName, 'Given61 Family61');
    assert.equal(rb?.noShowCandidate, false);
    // other days are empty for these two
    assert.equal(
      (await t.as(s, (tx) => t.flow.arrivals(tx, A1, '2031-03-05'))).filter((x) =>
        [a.rid, b.rid].includes(x.reservationId),
      ).length,
      0,
    );
    // HTTP: the route, the guard's location check
    const ok = await call(t.k.base, 'GET', `/api/v1/locations/${A1}/arrivals?date=2031-03-04`, {
      cookie: t.deskA1.cookie,
    });
    assert.equal(ok.status, 200, ok.body);
    assert.ok(
      (ok.json()['items'] as { reservationId: string }[]).some((x) => x.reservationId === a.rid),
    );
    assert.equal(
      (
        await call(t.k.base, 'GET', `/api/v1/locations/${A1}/arrivals?date=2031-03-04`, {
          cookie: t.deskB1.cookie,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await call(t.k.base, 'GET', `/api/v1/locations/${A1}/arrivals?date=nonsense`, {
          cookie: t.deskA1.cookie,
        })
      ).status,
      422,
    );
    // the desk at B1 does not see A1's queue even through the service (row-level security)
    const other = await t.as(await t.staffScope([B1]), (tx) => t.flow.queue(tx, A1));
    assert.equal(other.length, 0);
  });

  test('two staff move the same queue entry with the same ETag: the second gets 412 and nothing is overwritten (TC-PC-06, CN-07); a stale or missing If-Match, a bad stage', async () => {
    t.clock.at = NOW;
    const { rid } = await visit(70);
    await t.as(await desk(), (tx) => t.flow.checkIn(tx, meta(), rid, { method: 'desk' }));
    const v0 = Number(
      (
        await one<{ row_version: string }>(
          `SELECT row_version FROM scheduling.queue_entry WHERE id = $1`,
          [rid],
        )
      ).row_version,
    );
    const put = (who: typeof t.deskA1, stage: unknown, ifMatch?: string) =>
      call(t.k.base, 'PUT', `/api/v1/queue-entries/${rid}/stage`, {
        cookie: who.cookie,
        headers: {
          ...writeHeaders(who),
          ...(ifMatch === undefined ? {} : { 'if-match': ifMatch }),
        },
        body: { stage },
      });
    assert.equal((await put(t.deskA1, 'vitals')).status, 428);
    assert.equal((await put(t.deskA1, 'bogus', `W/"${v0}"`)).status, 422);
    const a = await put(t.deskA1, 'vitals', `W/"${v0}"`);
    assert.equal(a.status, 200, a.body);
    assert.equal(a.json()['stage'], 'vitals');
    assert.equal(a.headers['etag'], `W/"${v0 + 1}"`);
    const b = await put(t.lead, 'triage', `W/"${v0}"`);
    assert.equal(b.status, 412);
    assert.equal(
      (
        await one<{ stage: string }>(`SELECT stage FROM scheduling.queue_entry WHERE id = $1`, [
          rid,
        ])
      ).stage,
      'vitals',
    );
    assert.equal(
      (await put(t.deskB1, 'triage', `W/"${v0 + 1}"`)).status,
      404,
      'a desk at another location does not see the entry',
    );
    const c = await put(t.lead, 'triage', `W/"${v0 + 1}"`);
    assert.equal(c.status, 200);
    assert.ok(
      Number(
        (
          await one<{ stage_changed_at: Date }>(
            `SELECT stage_changed_at FROM scheduling.queue_entry WHERE id = $1`,
            [rid],
          )
        ).stage_changed_at,
      ) > 0,
    );
    // twenty racing moves with the same version: exactly one wins
    const v1 = Number(
      (
        await one<{ row_version: string }>(
          `SELECT row_version FROM scheduling.queue_entry WHERE id = $1`,
          [rid],
        )
      ).row_version,
    );
    const race = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        put(i % 2 === 0 ? t.deskA1 : t.lead, i % 2 === 0 ? 'ready' : 'with_clinician', `W/"${v1}"`),
      ),
    );
    assert.equal(race.filter((r) => r.status === 200).length, 1);
    assert.ok(race.filter((r) => r.status !== 200).every((r) => r.status === 412));
  });

  test('assignment: the doctor and room of the queue entry; a room or doctor already booked for that time is 409 scheduling.slot_taken', async () => {
    t.clock.at = NOW;
    const { rid, p } = await visit(80);
    await t.as(await desk(), (tx) => t.flow.checkIn(tx, meta(), rid, { method: 'desk' }));
    const other = await t.patient(81);
    const doc2 = (await t.doctor()).principalId;
    const busyDoc = (await t.doctor()).principalId;
    await t.seed(other, doc2, APPT, { roomId: ROOM2 });
    await t.seed(await t.patient(82), busyDoc, APPT);
    const put = async (body: Record<string, unknown>) => {
      const v = Number(
        (
          await one<{ row_version: string }>(
            `SELECT row_version FROM scheduling.queue_entry WHERE id = $1`,
            [rid],
          )
        ).row_version,
      );
      return call(t.k.base, 'PUT', `/api/v1/appointments/${rid}/assignment`, {
        cookie: t.deskA1.cookie,
        headers: { ...writeHeaders(t.deskA1), 'if-match': `W/"${v}"` },
        body,
      });
    };
    assert.equal((await put({ roomId: ROOM2 })).status, 409, 'room booked by another visit');
    assert.equal(
      (await put({ clinicianId: busyDoc })).status,
      409,
      'doctor booked by another visit',
    );
    assert.equal((await put({ roomId: randomUUID() })).status, 422, 'a room that does not exist');
    const free = (await t.doctor()).principalId;
    const ok = await put({ roomId: ROOM1, clinicianId: free });
    assert.equal(ok.status, 200, ok.body);
    assert.deepEqual([ok.json()['roomId'], ok.json()['assignedClinicianId']], [ROOM1, free]);
    const cleared = await put({ roomId: null });
    assert.equal(cleared.json()['roomId'], null);
    // the booked slot itself is untouched
    assert.equal(
      (
        await one<{ clinician_principal_id: string }>(
          `SELECT clinician_principal_id FROM scheduling.slot_occupancy WHERE id = $1`,
          [rid],
        )
      ).clinician_principal_id,
      (
        await one<{ c: string }>(
          `SELECT clinician_principal_id AS c FROM scheduling.slot_reservation WHERE id = $1`,
          [rid],
        )
      ).c,
    );
    void p;
  });
});

describe('no-show (29.3, 33.1, TC-PC-09)', () => {
  test('staff mark it only after the grace period (15 min, video 10); never a checked-in visit; audited', async () => {
    const s = await desk();
    const a = await visit(90);
    const v = await version(a.rid);
    t.clock.at = new Date(APPT.getTime() + 14 * 60_000);
    await rejectsWith(
      t.as(s, (tx) => t.flow.markNoShow(tx, meta(), a.rid, v)),
      'scheduling.grace_not_elapsed',
    );
    assert.equal(await status(a.rid), 'confirmed');
    t.clock.at = new Date(APPT.getTime() + 16 * 60_000);
    await rejectsWith(
      t.as(s, (tx) => t.flow.markNoShow(tx, meta(), a.rid, v + 5)),
      'kernel.precondition_failed',
    );
    const r = await t.as(s, (tx) => t.flow.markNoShow(tx, meta(), a.rid, v));
    assert.deepEqual(r, { reservationId: a.rid, status: 'no_show' });
    assert.equal(await status(a.rid), 'no_show');
    assert.equal(
      (
        await one<{ action: string }>(
          `SELECT action FROM audit.event WHERE resource_type = 'scheduling.slot_reservation' AND resource_id = $1 AND change ->> 'status' = 'no_show'`,
          [a.rid],
        )
      ).action,
      'update',
    );
    // a second time: it is final
    await rejectsWith(
      t.as(s, (tx) => t.flow.markNoShow(tx, meta(), a.rid, v + 1)),
      'scheduling.invalid_transition',
    );
    // a checked-in visit is not a no-show
    const b = await visit(91);
    t.clock.at = APPT;
    await t.as(s, (tx) => t.flow.checkIn(tx, meta(), b.rid, { method: 'desk' }));
    t.clock.at = new Date(APPT.getTime() + 60 * 60_000);
    const bv = await version(b.rid);
    await rejectsWith(
      t.as(s, (tx) => t.flow.markNoShow(tx, meta(), b.rid, bv)),
      'scheduling.invalid_transition',
    );
    // video has its own, shorter grace
    const c = await visit(92, { mode: 'video' });
    t.clock.at = new Date(APPT.getTime() + 11 * 60_000);
    assert.equal(
      await t
        .as(s, (tx) => t.flow.markNoShow(tx, meta(), c.rid, 0))
        .catch((e: { code: string }) => e.code),
      'kernel.precondition_failed',
    );
    assert.deepEqual(
      await t.as(s, async (tx) => t.flow.markNoShow(tx, meta(), c.rid, await version(c.rid))),
      { reservationId: c.rid, status: 'no_show' },
    );
    // the HTTP route
    const d = await visit(93);
    t.clock.at = undefined; // the route runs on the real clock: the visit is years ahead, so the grace has not elapsed
    const res = await call(t.k.base, 'POST', `/api/v1/appointments/${d.rid}/no-show`, {
      cookie: t.deskA1.cookie,
      headers: {
        ...writeHeaders(t.deskA1, undefined, randomUUID()),
        'if-match': `W/"${await version(d.rid)}"`,
      },
      body: {},
    });
    assert.equal(res.status, 422);
    assert.equal(res.json()['code'], 'scheduling.grace_not_elapsed');
  });

  test('the sweep flags for staff where automatic no-show is not allowed (the default), once, and the arrivals board shows it', async () => {
    const a = await visit(100);
    const early = await visit(101);
    t.clock.at = new Date(APPT.getTime() + 16 * 60_000);
    // the early visit is not due: its start is later than the others' grace window
    await sys(`UPDATE scheduling.slot_occupancy SET status = status WHERE id = $1`, [early.rid]); // (no-op: keeps the fixture explicit)
    const jobs = () => ({ ...t.jobs, now: () => t.clock.at as Date });
    const r1 = await W.runNoShowSweep(jobs());
    assert.ok(r1.flagged >= 2);
    assert.equal(r1.marked, 0);
    assert.equal(await status(a.rid), 'confirmed', 'a flag changes no status');
    assert.equal(
      await nrows(`SELECT count(*) AS n FROM scheduling.no_show_flag WHERE reservation_id = $1`, [
        a.rid,
      ]),
      1,
    );
    const r2 = await W.runNoShowSweep(jobs());
    assert.equal(r2.flagged, 0, 'idempotent');
    assert.equal(
      await nrows(`SELECT count(*) AS n FROM scheduling.no_show_flag WHERE reservation_id = $1`, [
        a.rid,
      ]),
      1,
    );
    const row = (await t.as(await desk(), (tx) => t.flow.arrivals(tx, A1, '2031-03-04'))).find(
      (x) => x.reservationId === a.rid,
    );
    assert.equal(row?.flaggedForStaff, true);
    assert.equal(row?.noShowCandidate, true);
    // the flag is insert-only, whoever asks
    await rejectsSqlState(
      sys(`DELETE FROM scheduling.no_show_flag WHERE reservation_id = $1`, [a.rid]),
      'PS001',
    );
    await rejectsSqlState(
      sys(`UPDATE scheduling.no_show_flag SET flagged_at = now() WHERE reservation_id = $1`, [
        a.rid,
      ]),
      'PS001',
    );
    // staff can still mark it by hand
    t.clock.at = new Date(APPT.getTime() + 20 * 60_000);
    await t.as(await desk(), async (tx) =>
      t.flow.markNoShow(tx, meta(), a.rid, await version(a.rid)),
    );
    assert.equal(await status(a.rid), 'no_show');
  });

  test('the sweep marks no-show only at a location whose setting allows it, only after the grace (video 10, in person 15), never a visit that arrived', async () => {
    t.clock.at = NOW;
    const arrived = await visit(110);
    await t.as(await desk(), (tx) => t.flow.checkIn(tx, meta(), arrived.rid, { method: 'desk' }));
    const inPerson = await visit(111);
    const video = await visit(112, { mode: 'video' });
    // the setting is per location: A1 allows it
    await t.k.sa
      .query(
        `INSERT INTO kernel.setting (id, organisation_id, key, value, value_schema, location_id) VALUES (gen_random_uuid(), $1, 'no_show_auto', 'true'::jsonb, 'bool', $2)`,
        [ORG, A1],
      )
      .catch(async () => {
        await t.k.sa.query(
          `INSERT INTO kernel.setting (id, organisation_id, key, value, value_schema) VALUES (gen_random_uuid(), $1, 'no_show_auto', 'true'::jsonb, 'bool')`,
          [ORG],
        );
      });
    const jobs = () => ({ ...t.jobs, now: () => t.clock.at as Date });
    t.clock.at = new Date(APPT.getTime() + 12 * 60_000); // past the video grace, inside the in-person one
    await W.runNoShowSweep(jobs());
    assert.equal(await status(video.rid), 'no_show');
    assert.equal(await status(inPerson.rid), 'confirmed');
    assert.equal(await status(arrived.rid), 'checked_in');
    t.clock.at = new Date(APPT.getTime() + 16 * 60_000);
    const r = await W.runNoShowSweep(jobs());
    assert.ok(r.marked >= 1);
    assert.equal(await status(inPerson.rid), 'no_show');
    assert.equal(await status(arrived.rid), 'checked_in');
    assert.equal(
      await nrows(
        `SELECT count(*) AS n FROM scheduling.no_show_flag WHERE reservation_id = ANY($1)`,
        [[video.rid, inPerson.rid, arrived.rid]],
      ),
      0,
      'marked visits are not flagged',
    );
    const a = await one<{ action: string; job_id: string | null }>(
      `SELECT action, job_id FROM audit.event WHERE resource_type = 'scheduling.slot_reservation' AND resource_id = $1 AND change ->> 'automatic' = 'true'`,
      [inPerson.rid],
    );
    assert.equal(a.action, 'update');
    assert.ok((a.job_id ?? '').startsWith('scheduling.no_show_sweep'));
    // the setting must be exactly true: a string "true" does not allow it
    await t.k.sa.query(`DELETE FROM kernel.setting WHERE key = 'no_show_auto'`);
    await t.k.sa
      .query(
        `INSERT INTO kernel.setting (id, organisation_id, key, value, value_schema) VALUES (gen_random_uuid(), $1, 'no_show_auto', '"true"'::jsonb, 'bool')`,
        [ORG],
      )
      .catch(() => undefined);
    const late = await visit(113);
    t.clock.at = new Date(APPT.getTime() + 40 * 60_000);
    await W.runNoShowSweep(jobs());
    assert.equal(await status(late.rid), 'confirmed');
    await t.k.sa.query(`DELETE FROM kernel.setting WHERE key = 'no_show_auto'`);
  });
});

describe('the database rules under the flow (1300-1302)', () => {
  test('every flow table forces row-level security, and every policy names its roles', async () => {
    const tables = ['check_in', 'queue_entry', 'waitlist_entry', 'waitlist_offer', 'no_show_flag'];
    for (const tb of tables) {
      const r = await one<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = ('scheduling.' || $1)::regclass`,
        [tb],
      );
      assert.deepEqual([r.relrowsecurity, r.relforcerowsecurity], [true, true], tb);
    }
    const open = await q(
      `SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'scheduling' AND tablename = ANY($1) AND roles = '{public}'`,
      [tables],
    );
    assert.deepEqual(open, []);
    const owned = await q<{ owner: string }>(
      `SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid = ANY($1::regclass[])`,
      [tables.map((x) => `scheduling.${x}`)],
    );
    assert.ok(owned.every((x) => x.owner === 'app_owner'));
  });

  test('a check-in belongs to its reservation: wrong patient, wrong place, a visit that is not checked in; the application roles cannot write what the policies do not allow', async () => {
    t.clock.at = NOW;
    const { p, rid } = await visit(120);
    const other = await t.patient(121);
    const ins = (patient: string, loc: string, rid2 = rid) =>
      sys(
        `INSERT INTO scheduling.check_in (id, organisation_id, patient_id, location_id, method, by_principal_id, previsit_status)
         VALUES ($1, $5, $2, $3, 'desk', $4, '{"questionnaire": false, "consents": false, "insurance": false}')`,
        [rid2, patient, loc, p.scope.principalId, ORG],
      );
    // not checked in yet
    await rejectsSqlState(ins(p.patientId, A1), 'PS001');
    await t.as(await desk(), (tx) => t.flow.checkIn(tx, meta(), rid, { method: 'desk' }));
    await sys(`DELETE FROM scheduling.queue_entry WHERE id = $1`, [rid]);
    await sys(`DELETE FROM scheduling.check_in WHERE id = $1`, [rid]);
    await rejectsSqlState(ins(other.patientId, A1), 'PS001'); // somebody else's visit
    await rejectsSqlState(ins(p.patientId, A2), 'PS001'); // another place
    // a patient cannot check in by desk, cannot write the queue's stage, and cannot read it
    await assert.rejects(
      t.as(p.scope, (tx) =>
        tx.query(
          `INSERT INTO scheduling.check_in (id, organisation_id, patient_id, location_id, method, by_principal_id, previsit_status, created_by) VALUES ($1, $2, $3, $4, 'desk', $5, '{"questionnaire": false, "consents": false, "insurance": false}', $5)`,
          [rid, ORG, p.patientId, A1, p.scope.principalId],
        ),
      ),
      (e: { code?: string }) => e.code === '42501' || e.code === 'PS001',
    );
    assert.deepEqual(
      await t.as(
        p.scope,
        async (tx) => (await tx.query(`SELECT 1 FROM scheduling.queue_entry`)).rows,
      ),
      [],
    );
    // staff of another location see nothing of this one
    assert.deepEqual(
      await t.as(
        await t.staffScope([B1]),
        async (tx) => (await tx.query(`SELECT 1 FROM scheduling.check_in`)).rows,
      ),
      [],
    );
  });

  test('queue entries: the place and the arrival time never change; waitlist entries and offers: the transition tables and K states', async () => {
    t.clock.at = NOW;
    const { rid, p } = await visit(125);
    await t.as(await desk(), (tx) => t.flow.checkIn(tx, meta(), rid, { method: 'desk' }));
    await rejectsSqlState(
      sys(`UPDATE scheduling.queue_entry SET entered_at = now() WHERE id = $1`, [rid]),
      'PS001',
    );
    await rejectsSqlState(
      sys(`UPDATE scheduling.queue_entry SET location_id = $2 WHERE id = $1`, [rid, A2]),
      'PS001',
    );
    await rejectsSqlState(
      sys(`UPDATE scheduling.queue_entry SET stage = 'sideways' WHERE id = $1`, [rid]),
      '23514',
    );
    await rejectsSqlState(
      sys(`UPDATE scheduling.check_in SET method = 'qr' WHERE id = $1`, [rid]),
      'PS001',
    );
    // a check-in is K once the visit moved on
    // (BE-18 starts the consultation; here the status is moved directly, as the clinical module will through set_status)
    await t.k.sa.query('BEGIN');
    await t.k.sa.query(`SET LOCAL session_replication_role = replica`);
    await t.k.sa.query(
      `UPDATE scheduling.slot_occupancy SET status = 'in_consultation' WHERE id = $1`,
      [rid],
    );
    await t.k.sa.query('COMMIT');
    await rejectsSqlState(
      sys(`UPDATE scheduling.check_in SET previsit_status = previsit_status WHERE id = $1`, [rid]),
      'PS001',
    );
    await rejectsSqlState(
      sys(`UPDATE scheduling.queue_entry SET stage = 'ready' WHERE id = $1`, [rid])
        .then(() => sys(`UPDATE scheduling.queue_entry SET stage = 'done' WHERE id = $1`, [rid]))
        .then(() => sys(`UPDATE scheduling.queue_entry SET stage = 'ready' WHERE id = $1`, [rid])),
      'PS001',
    );
    // waitlist entry: the transition table
    const eid = randomUUID();
    await sys(
      `INSERT INTO scheduling.waitlist_entry (id, organisation_id, patient_id, service_id, "window") VALUES ($1, $2, $3, $4, tstzrange(now() + interval '1 day', now() + interval '9 days'))`,
      [eid, ORG, p.patientId, SVC],
    );
    await rejectsSqlState(
      sys(`UPDATE scheduling.waitlist_entry SET status = 'fulfilled' WHERE id = $1`, [eid]),
      'PS001',
    );
    await rejectsSqlState(
      sys(`UPDATE scheduling.waitlist_entry SET position_at = now() WHERE id = $1`, [eid]),
      'PS001',
    );
    await rejectsSqlState(
      sys(`UPDATE scheduling.waitlist_entry SET status = 'cancelled' WHERE id = $1`, [eid]),
      '23514',
    ); // needs its reason
    await sys(
      `UPDATE scheduling.waitlist_entry SET status = 'cancelled', cancel_reason = 'patient' WHERE id = $1`,
      [eid],
    );
    await rejectsSqlState(
      sys(
        `UPDATE scheduling.waitlist_entry SET status = 'active', cancel_reason = NULL WHERE id = $1`,
        [eid],
      ),
      'PS001',
    );
    // an unbounded window is refused
    await rejectsSqlState(
      sys(
        `INSERT INTO scheduling.waitlist_entry (id, organisation_id, patient_id, service_id, "window") VALUES (gen_random_uuid(), $1, $2, $3, tstzrange(now(), NULL))`,
        [ORG, p.patientId, SVC],
      ),
      '23514',
    );
  });

  test('the job lists of the API and the worker are the same, and every job that carries patient IDs declares on_merged', async () => {
    assert.deepEqual(W.SCHEDULING_FLOW_JOBS, SCHEDULING_FLOW_JOBS);
    assert.equal(W.SCHEDULING_FLOW_CRONTAB, '*/5 * * * * scheduling.no_show_sweep');
    for (const j of SCHEDULING_FLOW_JOBS)
      if (j.carriesPatientIds) assert.ok(j.onMerged === 'resolve' || j.onMerged === 'fail', j.name);
    assert.deepEqual(SCHEDULING_FLOW_JOBS.map((j) => j.name).sort(), [
      'scheduling.expire_offer',
      'scheduling.no_show_sweep',
      'scheduling.offer_waitlist',
      'scheduling.on_reservation_cancelled',
      'scheduling.on_reservation_confirmed',
      'scheduling.on_reservation_rescheduled',
      'scheduling.on_slot_freed',
      'scheduling.send_previsit',
    ]);
  });
});

/** SQL text of every statement a transaction opened through the API's `withScope` ran while `fn` ran. */
const traced = async <T>(fn: () => Promise<T>): Promise<{ res: T; sql: string[] }> => {
  const db = t.k.db as unknown as { withScope: (...a: never[]) => unknown };
  const orig = db.withScope as (...a: unknown[]) => unknown;
  const sql: string[] = [];
  db.withScope = ((scope: unknown, body: (tx: object) => unknown, ...rest: unknown[]) =>
    orig.call(
      t.k.db,
      scope,
      (tx: Record<string, unknown>) =>
        body(
          new Proxy(tx, {
            get: (target, prop) => {
              if (prop === 'query')
                return (...a: unknown[]) => {
                  sql.push(typeof a[0] === 'string' ? a[0] : JSON.stringify(a[0]));
                  return (target['query'] as (...x: unknown[]) => unknown)(...a);
                };
              const v = Reflect.get(target, prop);
              return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v;
            },
          }),
        ),
      ...rest,
    )) as never;
  try {
    return { res: await fn(), sql };
  } finally {
    db.withScope = orig as never;
  }
};

// ===== the doctor's role (HEAAA-286, draft 8.3, 38.2 items 24, 25, 29) =====================================================
describe('the seeded doctor: front-desk writes are refused (38.2 item 24)', () => {
  test('POST /appointments/{id}/check-in, …/no-show and GET /locations/{id}/check-in-qr are 403 auth.forbidden', async () => {
    t.clock.at = NOW;
    const dr = await staffMember(t.k, 'doctor', A1, 'Doctor no desk');
    const { rid } = await visit(900);
    const v = await version(rid);
    for (const path of [
      `/api/v1/appointments/${rid}/check-in`,
      `/api/v1/appointments/${rid}/no-show`,
    ]) {
      const r = await call(t.k.base, 'POST', path, {
        cookie: dr.cookie,
        headers: { ...writeHeaders(dr, undefined, randomUUID()), 'if-match': `W/"${v}"` },
        body: {},
      });
      assert.equal(r.status, 403, `${path} ${r.body}`);
      assert.equal(r.json()['code'], 'auth.forbidden');
    }
    const qr = await call(t.k.base, 'GET', `/api/v1/locations/${A1}/check-in-qr`, {
      cookie: dr.cookie,
    });
    assert.equal(qr.status, 403, qr.body);
    assert.equal(qr.json()['code'], 'auth.forbidden');
    assert.equal(await status(rid), 'confirmed', 'nothing changed');
    t.clock.at = undefined;
  });
});

describe('GET /clinicians/{id}/schedule (38.2 items 25 and 29)', () => {
  const sched = (who: { cookie: string }, id: string, qs: string) =>
    call(t.k.base, 'GET', `/api/v1/clinicians/${id}/schedule${qs}`, { cookie: who.cookie });
  const KEYS = [
    'checkedInAt',
    'endsAt',
    'mode',
    'mrn',
    'patientId',
    'patientName',
    'queueStage',
    'reservationId',
    'serviceId',
    'startsAt',
    'status',
  ];

  test("(a) only the caller's own reservations, the clinician predicate is in the SQL, items carry no front-desk field; (e) the date is read in the location time zone; one view event per call", async () => {
    t.clock.at = NOW;
    const dr = await staffMember(t.k, 'doctor', A1, 'Doctor own schedule');
    const me = dr.seeded.principalId;
    const otherDoc = (await t.doctor()).principalId;
    const p1 = await t.patient(910);
    const p2 = await t.patient(911);
    const p3 = await t.patient(912);
    const mine = await t.seed(p1, me, APPT);
    const theirs = await t.seed(p2, otherDoc, new Date(APPT.getTime() + 3_600_000));
    // 22:30 EST on 03-04 is 03:30Z on 03-05: it belongs to the 4th at New York
    const lateEvening = await t.seed(p3, me, new Date('2031-03-05T03:30:00.000Z'));
    assert.ok(arrivalsSql(true).includes(CLINICIAN_PREDICATE));
    assert.ok(!arrivalsSql(false).includes(CLINICIAN_PREDICATE));
    const beforeEvents = await nrows(
      `SELECT count(*)::text AS n FROM audit.event WHERE action = 'view' AND resource_type = 'scheduling.reservation' AND actor_principal_id = $1`,
      [me],
    );
    const { res, sql } = await traced(() => sched(dr, me, `?locationId=${A1}&date=2031-03-04`));
    assert.equal(res.status, 200, res.body);
    const body = res.json() as { items: Record<string, unknown>[]; timeZone: string };
    assert.equal(body.timeZone, 'America/New_York');
    const ids = body.items.map((x) => x['reservationId']);
    assert.ok(ids.includes(mine));
    assert.ok(
      !ids.includes(theirs),
      "another clinician's reservation at the same location-day is not returned",
    );
    assert.ok(ids.includes(lateEvening), 'the date is the location-local date');
    for (const item of body.items) assert.deepEqual(Object.keys(item).sort(), KEYS);
    assert.ok(
      sql.some((q) => q.includes(CLINICIAN_PREDICATE)),
      'the SQL carries the clinician predicate',
    );
    assert.equal(sql.filter((q) => /previsit/i.test(q)).length, 0, 'no per-row pre-visit lookups');
    const next = await sched(dr, me, `?locationId=${A1}&date=2031-03-05`);
    assert.equal(
      (next.json()['items'] as { reservationId: string }[]).some(
        (x) => x.reservationId === lateEvening,
      ),
      false,
    );
    // item 29: one view event per call, patient IDs only
    const afterEvents = await nrows(
      `SELECT count(*)::text AS n FROM audit.event WHERE action = 'view' AND resource_type = 'scheduling.reservation' AND actor_principal_id = $1`,
      [me],
    );
    assert.equal(afterEvents - beforeEvents, 2);
    const ev = await one<{ change: { patientIds: string[] } }>(
      `SELECT change FROM audit.event WHERE action = 'view' AND resource_type = 'scheduling.reservation' AND actor_principal_id = $1 ORDER BY occurred_at LIMIT 1`,
      [me],
    );
    assert.deepEqual(ev.change.patientIds.sort(), [p1.patientId, p3.patientId].sort());
    t.clock.at = undefined;
  });

  test("(b)(c)(d) another clinician's id, an unknown id and a disabled principal give the same 403 before any scheduling query; a non-UUID id is 404; a location outside the grant is 403", async () => {
    const dr = await staffMember(t.k, 'doctor', A1, 'Doctor refusals');
    const gone = await t.doctor();
    await t.k.sa.query(`SET session_replication_role = replica`);
    try {
      await t.k.sa.query(`UPDATE identity.principal SET status = 'disabled' WHERE id = $1`, [
        gone.principalId,
      ]);
    } finally {
      await t.k.sa.query(`SET session_replication_role = DEFAULT`);
    }
    const flowSvc = t.flow as unknown as Record<string, (...a: unknown[]) => unknown>;
    const orig = flowSvc['clinicianSchedule'] as (...a: unknown[]) => unknown;
    let calls = 0;
    flowSvc['clinicianSchedule'] = (...a: unknown[]) => {
      calls += 1;
      return orig.apply(t.flow, a);
    };
    const bodies: string[] = [];
    try {
      for (const id of [(await t.doctor()).principalId, randomUUID(), gone.principalId]) {
        const { res, sql } = await traced(() => sched(dr, id, `?locationId=${A1}&date=2031-03-04`));
        assert.equal(res.status, 403, res.body);
        assert.equal(res.json()['code'], 'auth.forbidden');
        assert.equal(
          sql.some((q) => /scheduling\.|patient\./.test(q)),
          false,
          'no scheduling or patient query before the refusal',
        );
        bodies.push(res.body.replace(/"requestId":"[^"]*"/, ''));
      }
      assert.equal(new Set(bodies).size, 1, 'the body is identical in every case');
      assert.equal(calls, 0, 'the flow service was not called');
      // (d) a location outside the grant
      const far = await traced(() =>
        sched(dr, dr.seeded.principalId, `?locationId=${A2}&date=2031-03-04`),
      );
      assert.equal(far.res.status, 403, far.res.body);
      assert.equal(calls, 0);
    } finally {
      flowSvc['clinicianSchedule'] = orig;
    }
    assert.equal((await sched(dr, 'not-a-uuid', `?locationId=${A1}`)).status, 404);
    assert.equal(
      (await sched(dr, dr.seeded.principalId, `?locationId=${A1}&date=nonsense`)).json()['code'],
      'kernel.validation_failed',
    );
    assert.equal(
      (await sched(dr, dr.seeded.principalId, '')).json()['code'],
      'kernel.validation_failed',
      'locationId is required',
    );
    const denied = await nrows(
      `SELECT count(*)::text AS n FROM audit.event WHERE action = 'denied' AND resource_type = 'scheduling.route' AND actor_principal_id = $1`,
      [dr.seeded.principalId],
    );
    assert.ok(denied >= 4);
  });
});

void SVC_IP;
