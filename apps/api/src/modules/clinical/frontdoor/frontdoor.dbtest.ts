// Real-database tests for BE-18 (clinical front door) on PostgreSQL 17 with the real roles, migrations (1700-1702), RLS, queue,
// identity guard, sessions, alert service and booking/flow services, and a real HTTP server:
//   TC-PC-01..12 mechanics (RA-R1-06, RA-R1-29, RA-R1-30) and TC-SAF-01..08 MECHANICS ONLY. The acceptance of RA-R1-07 and
//   RA-R1-08 (the rule text, the timing) is BLOCKED by D-12a / C-03 / PM-confirm-1: these are ordinary test evidence over SYNTHETIC
//   rules and never count as the safety reviewer's review.
//   EHR_TEST_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres node --test dist/src/modules/clinical/frontdoor/frontdoor.dbtest.js
// The URL names a superuser on a throwaway server (synthetic data only). Missing configuration FAILS; nothing skips.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import {
  A1,
  A2,
  ADVICE,
  CONSENT_A,
  CONSENT_B,
  TEMPLATE_KEY,
  adminUrl,
  setupFrontdoor,
  staffMember,
  uuidv7,
  ORG,
} from './testkit.js';
import type { FrontdoorKit, PatientKit, SeededSession } from './testkit.js';

let t: FrontdoorKit;
let seed = 100;
const n = (): number => ++seed;

const rows = <T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> =>
  t.k.q<T>(sql, p);
const meta = (): { requestId: string } => ({ requestId: randomUUID() });
const SPO2 = '59408-5';
const nowIso = (): string => new Date().toISOString();

const auditCount = async (resource: string, patientId: string, action?: string): Promise<number> =>
  Number(
    (
      await rows<{ c: string }>(
        `SELECT count(*)::text AS c FROM audit.event WHERE resource_type = $1 AND patient_id = $2 AND ($3::text IS NULL OR action = $3)`,
        [resource, patientId, action ?? null],
      )
    )[0]?.c,
  );

describe('clinical front door (BE-18) on PostgreSQL 17', () => {
  before(async () => {
    assert.ok(
      adminUrl,
      'EHR_TEST_ADMIN_URL must name a throwaway PostgreSQL 17 server (a missing configuration fails, it does not skip)',
    );
    t = await setupFrontdoor('be18');
    await t.publishTemplate();
    await t.publishConsent(CONSENT_A, 2);
    await t.publishConsent(CONSENT_B, 2);
    await t.publishConsent(CONSENT_A, 1);
  });
  after(async () => {
    await t?.close();
  });

  // ===== vitals (TC-PC-04, AC-09) ======================================================================================
  describe('vitals with out-of-range flags (TC-PC-04)', () => {
    let ci: string;
    let pat: PatientKit;
    before(async () => {
      pat = await t.mkPatient(n());
      ci = await t.checkedIn(pat);
      // A range is clinical content (D-12a): this one is SYNTHETIC, entered through the admin route with the reviewer-note field filled.
      const r = await t.scall(t.admin, 'POST', '/api/v1/admin/vital-ranges', {
        loincCode: SPO2,
        unit: '%',
        sex: 'any',
        ageYears: { from: 0 },
        low: 90,
        high: 100,
        approvedByNote: 'Synthetic test range, not a clinical value',
      });
      assert.equal(r.status, 201, r.body);
    });
    const vit = (value: number, extra: Record<string, unknown> = {}) => ({
      loincCode: SPO2,
      value,
      unit: '%',
      measuredAt: nowIso(),
      ...extra,
    });

    test('below the low bound is out of range; in range is not; exactly at the bound is in range (inclusive); never refused', async () => {
      const below = await t.scall(t.nurse, 'POST', `/api/v1/check-ins/${ci}/vitals`, {
        vitals: [vit(89)],
      });
      assert.equal(below.status, 201, below.body);
      assert.deepEqual(below.json()['outOfRange'], [SPO2]);
      const v0 = (below.json()['vitals'] as Record<string, unknown>[])[0];
      assert.equal(v0?.['rangeStatus'], 'out_of_range');
      assert.equal(v0?.['rangeLow'], 90);
      assert.ok(below.json()['patientBanner'], 'banner: true route');
      const inRange = await t.scall(t.nurse, 'POST', `/api/v1/check-ins/${ci}/vitals`, {
        vitals: [vit(97)],
      });
      assert.deepEqual(inRange.json()['outOfRange'], []);
      assert.equal(
        ((inRange.json()['vitals'] as Record<string, unknown>[])[0] ?? {})['rangeStatus'],
        'in_range',
      );
      for (const edge of [90, 100]) {
        const r = await t.scall(t.nurse, 'POST', `/api/v1/check-ins/${ci}/vitals`, {
          vitals: [vit(edge)],
        });
        assert.equal(
          ((r.json()['vitals'] as Record<string, unknown>[])[0] ?? {})['rangeStatus'],
          'in_range',
          `value ${edge}`,
        );
      }
      const above = await t.scall(t.nurse, 'POST', `/api/v1/check-ins/${ci}/vitals`, {
        vitals: [vit(100.5)],
      });
      assert.deepEqual(above.json()['outOfRange'], [SPO2]);
      const saved = await rows(
        `SELECT count(*)::int AS c FROM clinical.vital_sign WHERE check_in_id = $1`,
        [ci],
      );
      assert.equal(saved[0]?.['c'], 5, 'every attempt was saved, including the out-of-range ones');
    });

    test('a unit the range is not stated in is unit_mismatch (no conversion); a code with no range is no_range', async () => {
      const r = await t.scall(t.nurse, 'POST', `/api/v1/check-ins/${ci}/vitals`, {
        vitals: [vit(0.95, { unit: '1' }), vit(70, { loincCode: '8867-4', unit: '/min' })],
      });
      const st = (r.json()['vitals'] as Record<string, unknown>[]).map((v) => v['rangeStatus']);
      assert.deepEqual(st, ['unit_mismatch', 'no_range']);
      assert.deepEqual(r.json()['outOfRange'], []);
    });

    test('validation: nothing is saved when one entry is bad; a front-desk user and a nurse of another location are refused', async () => {
      const before = Number(
        (
          await rows(`SELECT count(*)::int AS c FROM clinical.vital_sign WHERE check_in_id = $1`, [
            ci,
          ])
        )[0]?.['c'],
      );
      const bad = await t.scall(t.nurse, 'POST', `/api/v1/check-ins/${ci}/vitals`, {
        vitals: [
          vit(96),
          vit(Number.NaN as number),
          { loincCode: 'x', value: 1, unit: '%', measuredAt: nowIso() },
        ],
      });
      assert.equal(bad.status, 422);
      assert.equal(
        Number(
          (
            await rows(
              `SELECT count(*)::int AS c FROM clinical.vital_sign WHERE check_in_id = $1`,
              [ci],
            )
          )[0]?.['c'],
        ),
        before,
        'all or none',
      );
      assert.equal(
        (await t.scall(t.desk, 'POST', `/api/v1/check-ins/${ci}/vitals`, { vitals: [vit(96)] }))
          .status,
        403,
      );
      const nurseA2 = await staffMember(t.k, 'triage_nurse', A2, 'Nurse A2');
      const r = await t.scall(nurseA2, 'POST', `/api/v1/check-ins/${ci}/vitals`, {
        vitals: [vit(96)],
      });
      assert.ok([403, 404].includes(r.status), `a nurse of another location gets ${r.status}`);
      assert.equal(
        (
          await t.scall(t.nurse, 'POST', `/api/v1/check-ins/${randomUUID()}/vitals`, {
            vitals: [vit(96)],
          })
        ).status,
        404,
      );
    });

    test('an idempotent retry replays the stored answer and saves one set of rows', async () => {
      const key = randomUUID();
      const body = { vitals: [vit(98, { loincCode: '9279-1', unit: '/min' })] };
      const a = await t.scall(t.nurse, 'POST', `/api/v1/check-ins/${ci}/vitals`, body, {
        'idempotency-key': key,
      });
      const b = await t.scall(t.nurse, 'POST', `/api/v1/check-ins/${ci}/vitals`, body, {
        'idempotency-key': key,
      });
      assert.equal(a.status, 201);
      assert.equal(b.status, 201);
      assert.equal(b.headers['idempotent-replay'], 'true');
      assert.deepEqual(b.json()['vitals'], a.json()['vitals']);
      assert.equal(
        Number(
          (
            await rows(
              `SELECT count(*)::int AS c FROM clinical.vital_sign WHERE loinc_code = '9279-1' AND check_in_id = $1`,
              [ci],
            )
          )[0]?.['c'],
        ),
        1,
      );
    });
  });

  // ===== triage (TC-PC-05, TC-PC-06) ===================================================================================
  describe('triage category and the assessment chain', () => {
    const post = (
      s: SeededSession,
      ci: string,
      body: unknown,
      extra: Record<string, string> = {},
    ) => t.scall(s, 'POST', `/api/v1/check-ins/${ci}/triage`, body, extra);

    test('TC-PC-05: the category is saved, set on the queue entry, shown on read; a re-triage supersedes it; nobody drops out of the queue', async () => {
      const ps: PatientKit[] = [];
      for (let i = 0; i < 4; i++) ps.push(await t.mkPatient(n()));
      const cis: string[] = [];
      for (const p of ps) cis.push(await t.checkedIn(p));
      const first = await post(t.nurse, cis[2] as string, { category: 'urgent', notes: 'note' });
      assert.equal(first.status, 201, first.body);
      assert.equal(first.json()['category'], 'urgent');
      assert.equal(first.json()['redFlag'], false);
      assert.equal(first.json()['alertId'], undefined);
      assert.equal(first.headers['etag'], 'W/"1"');
      assert.ok(first.json()['patientBanner']);
      for (const ci of [cis[0], cis[1], cis[3]])
        await post(t.nurse, ci as string, { category: 'standard' });
      const q = await rows<{ id: string; triage_category: string }>(
        `SELECT id, triage_category FROM scheduling.queue_entry WHERE id = ANY($1::uuid[]) ORDER BY entered_at`,
        [cis],
      );
      assert.equal(q.length, 4, 'no patient is dropped from the queue');
      assert.equal(q.find((x) => x.id === cis[2])?.triage_category, 'urgent');
      // re-triage: If-Match carries the chain length seen
      const again = await post(
        t.nurse,
        cis[2] as string,
        { category: 'emergency' },
        { 'if-match': 'W/"1"' },
      );
      assert.equal(again.status, 201, again.body);
      assert.equal(again.headers['etag'], 'W/"2"');
      assert.equal(
        (
          await rows(`SELECT triage_category FROM scheduling.queue_entry WHERE id = $1`, [cis[2]])
        )[0]?.['triage_category'],
        'emergency',
      );
      const chain = await rows<{ supersedes_id: string | null; category: string }>(
        `SELECT supersedes_id, category FROM clinical.triage_assessment WHERE check_in_id = $1 ORDER BY assessed_at, id`,
        [cis[2]],
      );
      assert.equal(chain.length, 2);
      assert.equal(chain[0]?.supersedes_id, null);
      assert.equal(chain[0]?.category, 'urgent', 'the first assessment is kept as it was');
      const cur = await t.scall(t.nurse, 'GET', `/api/v1/check-ins/${cis[2]}/triage`);
      assert.equal(cur.status, 200);
      assert.equal((cur.json()['triage'] as Record<string, unknown>)['category'], 'emergency');
      assert.equal(cur.headers['etag'], 'W/"2"');
    });

    test('TC-PC-06: two nurses holding the same ETag: one wins, the other gets 412 and nothing is overwritten', async () => {
      const ci = await t.checkedIn(await t.mkPatient(n()));
      assert.equal((await post(t.nurse, ci, { category: 'standard' })).status, 201);
      const [a, b] = await Promise.all([
        post(t.nurse, ci, { category: 'urgent' }, { 'if-match': 'W/"1"' }),
        post(t.nurse2, ci, { category: 'non_urgent' }, { 'if-match': 'W/"1"' }),
      ]);
      assert.deepEqual([a.status, b.status].sort(), [201, 412]);
      const chain = await rows(
        `SELECT category FROM clinical.triage_assessment WHERE check_in_id = $1`,
        [ci],
      );
      assert.equal(chain.length, 2, 'the loser wrote nothing');
      // a re-triage without If-Match once an assessment exists, and a stale one, are refused
      assert.equal((await post(t.nurse, ci, { category: 'standard' })).status, 428);
      assert.equal(
        (await post(t.nurse, ci, { category: 'standard' }, { 'if-match': 'W/"1"' })).status,
        412,
      );
    });

    test('two first triages of one check-in at the same moment: exactly one is saved', async () => {
      const ci = await t.checkedIn(await t.mkPatient(n()));
      const rs = await Promise.all([
        post(t.nurse, ci, { category: 'standard' }),
        post(t.nurse2, ci, { category: 'urgent' }),
      ]);
      assert.equal(rs.filter((r) => r.status === 201).length, 1, rs.map((r) => r.status).join());
      assert.ok(rs.some((r) => r.status === 428 || r.status === 412));
      assert.equal(
        Number(
          (
            await rows(
              `SELECT count(*)::int AS c FROM clinical.triage_assessment WHERE check_in_id = $1`,
              [ci],
            )
          )[0]?.['c'],
        ),
        1,
      );
    });

    test('validation and permissions: a bad category, bad symptoms or an over-long note is 422; front desk is 403; unknown check-in is 404', async () => {
      const ci = await t.checkedIn(await t.mkPatient(n()));
      for (const body of [
        { category: 'nonsense' },
        { category: 'standard', redFlag: 'yes' },
        { category: 'standard', notes: 'x'.repeat(5001) },
        { category: 'standard', symptoms: { 'bad key!': 1 } },
        { category: 'standard', symptoms: { ok: { nested: true } } },
        { category: 'standard', templateKey: '../etc' },
      ])
        assert.equal((await post(t.nurse, ci, body)).status, 422, JSON.stringify(body));
      assert.equal((await post(t.desk, ci, { category: 'standard' })).status, 403);
      assert.equal((await post(t.nurse, randomUUID(), { category: 'standard' })).status, 404);
      assert.equal(
        Number(
          (
            await rows(
              `SELECT count(*)::int AS c FROM clinical.triage_assessment WHERE check_in_id = $1`,
              [ci],
            )
          )[0]?.['c'],
        ),
        0,
      );
    });

    test('the table is append-only: no UPDATE or DELETE by the application role or even a superuser (the trigger)', async () => {
      const ci = await t.checkedIn(await t.mkPatient(n()));
      await post(t.nurse, ci, { category: 'standard' });
      await assert.rejects(
        t.as(t.staffScope(t.nurse), (tx) =>
          tx.query(
            `UPDATE clinical.triage_assessment SET category = 'urgent' WHERE check_in_id = $1`,
            [ci],
          ),
        ),
        (e: unknown) => ['42501', 'PS001'].includes((e as { code?: string }).code ?? ''),
      );
      await assert.rejects(
        rows(`UPDATE clinical.triage_assessment SET notes = 'x' WHERE check_in_id = $1`, [ci]),
        (e: unknown) => (e as { code?: string }).code === 'PS001',
      );
      await assert.rejects(
        rows(`DELETE FROM clinical.triage_assessment WHERE check_in_id = $1`, [ci]),
        (e: unknown) => (e as { code?: string }).code === 'PS001',
      );
    });
  });

  // ===== red flag (TC-SAF-01..04 mechanics, 38.2 item 16) =============================================================
  describe('red-flag alert at triage (mechanics only: the rules here are SYNTHETIC, D-12a blocks acceptance)', () => {
    let dr1Scope: ReturnType<FrontdoorKit['staffScope']>;
    const answers = (o: Record<string, unknown> = {}) => ({
      q_flag_a: false,
      q_flag_b: 'green',
      q_score: 1,
      ...o,
    });
    const triage = async (body: Record<string, unknown>, s = t.nurse, patient?: PatientKit) => {
      const p = patient ?? (await t.mkPatient(n()));
      const ci = await t.checkedIn(p);
      return {
        p,
        ci,
        r: await t.scall(s, 'POST', `/api/v1/check-ins/${ci}/triage`, {
          category: 'urgent',
          templateKey: TEMPLATE_KEY,
          ...body,
        }),
      };
    };
    const sinkEvents = async (task: string) =>
      rows<{ payload: Record<string, unknown> }>(
        `SELECT j.payload FROM queue._private_jobs j JOIN queue._private_tasks tk ON tk.id = j.task_id WHERE tk.identifier = $1 ORDER BY j.id`,
        [task],
      );

    before(async () => {
      dr1Scope = t.staffScope(t.doctor);
      await t.roster(t.doctor, 'on_duty_doctor');
      await t.roster(t.doctor2, 'on_call_doctor');
      // observers for the two events the front door publishes
      for (const j of [
        { name: 'sink.on_red_flag_raised', carriesPatientIds: true, jobScope: 'patients' as const },
        { name: 'sink.on_roster_gap', carriesPatientIds: false, jobScope: 'org' as const },
      ])
        t.k.registry.defineJob({
          ...j,
          maxAttempts: 3,
          onMerged: j.carriesPatientIds ? 'resolve' : 'none',
          jobClass: 'handler',
        });
      t.k.registry.registerHandler('clinical.red_flag_raised', 'sink');
      t.k.registry.registerHandler('clinical.roster_gap', 'sink');
      const { syncTaskTypes } = await import('@ehr/kernel');
      const wc = new (await import('./testkit.js')).pg.Client({
        connectionString: t.k.urlFor('app_worker'),
      });
      await wc.connect();
      await syncTaskTypes(wc, t.k.registry);
      await wc.end();
    });

    test('TC-SAF-01 / 38.2 item 16: a rule match creates the alert for the on-duty doctor; the nurse who raised it is not a target and still sees it; the advice is returned', async () => {
      const { p, ci, r } = await triage({ symptoms: answers({ q_flag_a: true }) });
      assert.equal(r.status, 201, r.body);
      assert.equal(r.json()['redFlag'], true);
      assert.equal(r.json()['advice'], ADVICE);
      const alertId = String(r.json()['alertId']);
      const a = (
        await rows(`SELECT * FROM notifications.staff_alert WHERE id = $1`, [alertId])
      )[0] as Record<string, unknown>;
      assert.equal(a['type'], 'red_flag');
      assert.equal(a['severity'], 'critical');
      assert.equal(a['patient_id'], p.patientId);
      assert.equal(a['location_id'], A1);
      assert.equal(a['status'], 'open');
      assert.deepEqual(a['target_principal_ids'], [t.doctor.seeded.principalId]);
      assert.ok(
        !(a['target_principal_ids'] as string[]).includes(t.nurse.seeded.principalId),
        'the nurse is not a target',
      );
      assert.equal(a['created_by'], t.nurse.seeded.principalId);
      const tri = (
        await rows(
          `SELECT id, alert_id, red_flag FROM clinical.triage_assessment WHERE check_in_id = $1`,
          [ci],
        )
      )[0] as Record<string, unknown>;
      assert.equal(tri['alert_id'], alertId);
      assert.equal(a['resource_id'], tri['id']);
      assert.equal(a['resource_type'], 'triage_assessment');
      // the creator reads the alert they raised through RLS (22.13; the BE-07 list route is target-only); another nurse does not
      const seenBy = (who: SeededSession) =>
        t.as(
          t.staffScope(who),
          async (tx) =>
            (await tx.query(`SELECT id FROM notifications.staff_alert WHERE id = $1`, [alertId]))
              .rows.length,
        );
      assert.equal(await seenBy(t.nurse), 1, 'the raiser reads it');
      assert.equal(
        await seenBy(t.nurse2),
        0,
        'a nurse who did not raise it and is not a target does not',
      );
      // the target sees it through its own RLS
      const seen = await t.as(dr1Scope, (tx) => t.alerts.list(tx, {}));
      assert.ok(JSON.stringify(seen).includes(alertId));
      assert.deepEqual(
        (
          await rows(`SELECT kind FROM notifications.staff_alert_event WHERE alert_id = $1`, [
            alertId,
          ])
        ).map((x) => x['kind']),
        ['created'],
      );
      // the time of the alert is recorded (created_at) and the triage and alert audit rows exist
      assert.ok(a['created_at'] instanceof Date);
      assert.equal(await auditCount('clinical.triage_assessment', p.patientId, 'create'), 1);
      assert.ok(
        (await sinkEvents('sink.on_red_flag_raised')).some(
          (e) => e.payload['alertId'] === alertId && e.payload['patientId'] === p.patientId,
        ),
      );
    });

    test('TC-SAF-03: every configured rule alerts; a near-miss and a non-flag answer do not; the boundary of a numeric rule is exact', async () => {
      const hits: [string, Record<string, unknown>][] = [
        ['boolean rule', answers({ q_flag_a: true })],
        ['in-list rule (first value)', answers({ q_flag_b: 'red' })],
        ['in-list rule (second value)', answers({ q_flag_b: 'purple' })],
        ['numeric rule at the bound (gte)', answers({ q_score: 8 })],
        ['numeric rule above the bound', answers({ q_score: 9.5 })],
        ['trimmed text still matches', answers({ q_flag_b: ' red ' })],
      ];
      for (const [label, a] of hits) {
        const { r } = await triage({ symptoms: a });
        assert.equal(r.json()['redFlag'], true, label);
      }
      const misses: [string, Record<string, unknown>][] = [
        ['non-flag answers', answers()],
        ['near-miss text', answers({ q_flag_b: 'reddish' })],
        ['case differs (exact comparison)', answers({ q_flag_b: 'RED' })],
        ['numeric just below the bound', answers({ q_score: 7.99 })],
        ['free text that mentions a flag', answers({ q_note: 'chest discomfort that is mild' })],
      ];
      for (const [label, a] of misses) {
        const { r } = await triage({ symptoms: a });
        assert.equal(r.status, 201, `${label}: ${r.body}`);
        assert.equal(r.json()['redFlag'], false, label);
        assert.equal(r.json()['alertId'], undefined, label);
      }
    });

    test('TC-SAF-03 step 3: a rule question left blank is rejected, not read as "no red flag"; nothing is saved; a match elsewhere still alerts', async () => {
      const p = await t.mkPatient(n());
      const ci = await t.checkedIn(p);
      const blank = await t.scall(t.nurse, 'POST', `/api/v1/check-ins/${ci}/triage`, {
        category: 'urgent',
        templateKey: TEMPLATE_KEY,
        symptoms: { q_flag_a: false, q_score: 1 },
      });
      assert.equal(blank.status, 422);
      assert.ok(
        JSON.stringify(blank.json()['errors']).includes('clinical.red_flag_answer_required'),
      );
      assert.equal(
        Number(
          (
            await rows(
              `SELECT count(*)::int AS c FROM clinical.triage_assessment WHERE check_in_id = $1`,
              [ci],
            )
          )[0]?.['c'],
        ),
        0,
      );
      assert.equal(
        (await rows(`SELECT triage_category FROM scheduling.queue_entry WHERE id = $1`, [ci]))[0]?.[
          'triage_category'
        ],
        null,
      );
      const matched = await t.scall(t.nurse, 'POST', `/api/v1/check-ins/${ci}/triage`, {
        category: 'urgent',
        templateKey: TEMPLATE_KEY,
        symptoms: { q_flag_a: true },
      });
      assert.equal(matched.status, 201, matched.body);
      assert.equal(matched.json()['redFlag'], true);
    });

    test('a rule that cannot be read fails toward safety (counts as a match); an unknown template is 422', async () => {
      await t.publishTemplate({
        key: 'broken-rules',
        rules: [{ question: 'q1' }, { equals: 1 }],
        questions: [{ id: 'q1' }],
      });
      const { r } = await triage({ templateKey: 'broken-rules', symptoms: { q1: 'x' } });
      assert.equal(r.json()['redFlag'], true);
      const bad = await triage({ templateKey: 'no-such-template', symptoms: { q1: 'x' } });
      assert.equal(bad.r.status, 422);
    });

    test('the nurse can mark the red flag without any rule; with no template at all the mark alone decides', async () => {
      const { r } = await triage({ templateKey: undefined, redFlag: true });
      assert.equal(r.status, 201, r.body);
      assert.equal(r.json()['redFlag'], true);
      assert.equal(r.json()['advice'], undefined, 'no template, no advice text is invented');
      const none = await triage({ templateKey: undefined });
      assert.equal(none.r.json()['redFlag'], false);
    });

    test('the alert row commits with the triage or not at all: a failure after the alert rolls back alert, triage and category', async () => {
      const p = await t.mkPatient(n());
      const ci = await t.checkedIn(p);
      const before = Number(
        (
          await rows(
            `SELECT count(*)::int AS c FROM notifications.staff_alert WHERE patient_id = $1`,
            [p.patientId],
          )
        )[0]?.['c'],
      );
      await assert.rejects(
        t.as(t.staffScope(t.nurse), async (tx) => {
          const res = await t.frontdoor.triage.record(
            tx,
            meta(),
            ci,
            { category: 'emergency', redFlag: true },
            undefined,
          );
          assert.ok(res.alertId);
          throw new Error('abort after the alert');
        }),
        /abort after the alert/,
      );
      assert.equal(
        Number(
          (
            await rows(
              `SELECT count(*)::int AS c FROM notifications.staff_alert WHERE patient_id = $1`,
              [p.patientId],
            )
          )[0]?.['c'],
        ),
        before,
      );
      assert.equal(
        Number(
          (
            await rows(
              `SELECT count(*)::int AS c FROM clinical.triage_assessment WHERE check_in_id = $1`,
              [ci],
            )
          )[0]?.['c'],
        ),
        0,
      );
      assert.equal(
        (await rows(`SELECT triage_category FROM scheduling.queue_entry WHERE id = $1`, [ci]))[0]?.[
          'triage_category'
        ],
        null,
      );
      assert.equal(
        (await sinkEvents('sink.on_red_flag_raised')).filter(
          (e) => e.payload['patientId'] === p.patientId,
        ).length,
        0,
        'no event for a rolled-back alert',
      );
    });

    test('TC-SAF-04: if the stream service is down the durable alert still exists and the patient still gets the advice (the alert row is the source)', async () => {
      // The SSE stream is a separate tier fed from the alert row; nothing in the triage transaction depends on it.
      const { p, r } = await triage({ symptoms: answers({ q_flag_a: true }) });
      assert.equal(r.status, 201);
      assert.equal(r.json()['advice'], ADVICE);
      const row = (
        await rows(
          `SELECT status FROM notifications.staff_alert WHERE patient_id = $1 AND type = 'red_flag'`,
          [p.patientId],
        )
      )[0];
      assert.equal(row?.['status'], 'open');
    });

    test('no doctor on duty: the alert goes to every holder of the receive permission at the location (not the raiser), and the roster gap is published', async () => {
      await rows(`DELETE FROM scheduling.roster_entry WHERE duty = 'on_duty_doctor'`);
      try {
        const { p, r } = await triage({ symptoms: answers({ q_flag_a: true }) });
        assert.equal(r.status, 201, r.body);
        const a = (
          await rows(`SELECT target_principal_ids FROM notifications.staff_alert WHERE id = $1`, [
            r.json()['alertId'],
          ])
        )[0] as Record<string, unknown>;
        const targets = a['target_principal_ids'] as string[];
        assert.ok(
          targets.includes(t.doctor.seeded.principalId) &&
            targets.includes(t.nurse2.seeded.principalId),
        );
        assert.ok(!targets.includes(t.nurse.seeded.principalId), 'the raiser is not a target');
        assert.ok(
          !targets.includes(t.desk.seeded.principalId),
          'front desk does not hold the permission',
        );
        const gaps = await sinkEvents('sink.on_roster_gap');
        assert.ok(gaps.length >= 1 && gaps.some((g) => g.payload['locationId'] === A1));
        void p;
      } finally {
        await t.roster(t.doctor, 'on_duty_doctor');
      }
    });

    test('nobody can receive the alert: the triage is NOT saved (409) rather than looking handled', async () => {
      const p = await t.mkPatient(n());
      const ci = await t.checkedIn(p);
      const { TriageService } = await import('./triage.js');
      const base = {
        audit: t.audit,
        checkIns: t.ports.checkIns,
        alerts: t.ports.alerts,
        catalog: t.ports.catalog,
        events: t.ports.events,
      };
      const lonely = new TriageService({
        ...base,
        duty: {
          onDuty: () => Promise.resolve([]),
          permissionHoldersAt: () => Promise.resolve([t.nurse.seeded.principalId]),
        },
      });
      // The only receiver is the raiser: they are then their own recipient (a doctor who triages alone), the flag is not lost.
      const self = await t.as(t.staffScope(t.nurse), (tx) =>
        lonely.record(tx, meta(), ci, { category: 'urgent', redFlag: true }, undefined),
      );
      assert.ok(self.alertId);
      const ci2 = await t.checkedIn(await t.mkPatient(n()));
      const nobody = new TriageService({
        ...base,
        duty: { onDuty: () => Promise.resolve([]), permissionHoldersAt: () => Promise.resolve([]) },
      });
      await assert.rejects(
        t.as(t.staffScope(t.nurse), (tx) =>
          nobody.record(tx, meta(), ci2, { category: 'urgent', redFlag: true }, undefined),
        ),
        (e: unknown) => (e as { code?: string }).code === 'clinical.red_flag_no_recipient',
      );
      assert.equal(
        Number(
          (
            await rows(
              `SELECT count(*)::int AS c FROM clinical.triage_assessment WHERE check_in_id = $1`,
              [ci2],
            )
          )[0]?.['c'],
        ),
        0,
      );
    });

    test('escalation is configurable and not assumed: with no setting there is no timer; with one the job is queued at that time (PM-confirm-1, D-12a)', async () => {
      const none = await t.as(t.staffScope(t.nurse), async (tx) =>
        t.frontdoor.triage.record(
          tx,
          meta(),
          await t.checkedIn(await t.mkPatient(n())),
          { category: 'urgent', redFlag: true },
          undefined,
        ),
      );
      assert.equal(none.escalatesAt, null);
      assert.equal(
        (
          await rows(
            `SELECT count(*)::int AS c FROM queue._private_jobs j JOIN queue._private_tasks tk ON tk.id = j.task_id WHERE tk.identifier = 'notifications.escalate_alert' AND j.payload->>'alertId' = $1`,
            [none.alertId],
          )
        )[0]?.['c'],
        0,
      );
      await rows(
        `INSERT INTO notifications.staff_alert_setting (id, organisation_id, alert_type, location_id, escalate_after_min, escalate_to_duty)
         VALUES ($1, $2, 'red_flag', NULL, 7, 'on_call_doctor')`,
        [uuidv7(), ORG],
      );
      try {
        const set = await t.as(t.staffScope(t.nurse), async (tx) =>
          t.frontdoor.triage.record(
            tx,
            meta(),
            await t.checkedIn(await t.mkPatient(n())),
            { category: 'urgent', redFlag: true },
            undefined,
          ),
        );
        assert.ok(set.escalatesAt, 'a configured timer is honoured');
        const jobs = await rows<{ run_at: Date }>(
          `SELECT j.run_at FROM queue._private_jobs j JOIN queue._private_tasks tk ON tk.id = j.task_id WHERE tk.identifier = 'notifications.escalate_alert' AND j.payload->>'alertId' = $1`,
          [set.alertId],
        );
        assert.equal(jobs.length, 1);
        assert.equal(jobs[0]?.run_at.toISOString(), set.escalatesAt);
      } finally {
        await rows(`DELETE FROM notifications.staff_alert_setting WHERE alert_type = 'red_flag'`);
      }
    });

    test('an unacknowledged red flag is re-targeted to the on-call doctor (25.5); the targets are added, not replaced; repeating adds nothing', async () => {
      await rows(`DELETE FROM scheduling.roster_entry WHERE duty = 'on_duty_doctor'`); // earlier tests changed the on-duty roster
      await t.roster(t.doctor, 'on_duty_doctor');
      const { p, r } = await triage({ redFlag: true, templateKey: undefined });
      const alertId = String(r.json()['alertId']);
      const job = {
        audience: 'system' as const,
        realm: 'worker' as const,
        orgId: ORG,
        jobScope: 'patients' as const,
        jobPatientIds: [p.patientId],
      };
      const added = await t.asWorker(job, (tx) =>
        t.frontdoor.triage.retargetUnacknowledged(tx, alertId),
      );
      assert.deepEqual(added, [t.doctor2.seeded.principalId]);
      const after = (
        await rows(`SELECT target_principal_ids FROM notifications.staff_alert WHERE id = $1`, [
          alertId,
        ])
      )[0]?.['target_principal_ids'] as string[];
      assert.ok(
        after.includes(t.doctor.seeded.principalId) && after.includes(t.doctor2.seeded.principalId),
      );
      assert.deepEqual(
        await t.asWorker(job, (tx) => t.frontdoor.triage.retargetUnacknowledged(tx, alertId)),
        [],
      );
      // a staff transaction cannot do it (only a worker may add escalation targets)
      await assert.rejects(
        t.as(t.staffScope(t.nurse), (tx) => t.frontdoor.triage.retargetUnacknowledged(tx, alertId)),
      );
    });
  });
});
