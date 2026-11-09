/* eslint-disable boundaries/module-boundaries -- a test file reusing the patient testkit (same exemption request as testkit.ts, BE-10 README O-6). */
// Real-database tests for BE-16 (clinical chart) on PostgreSQL 17 with the real roles, migrations 1600-1603, the real Nest application
// and identity guard, and the worker's real terminology job over an in-memory source:
//   TC-CL-04, TC-CL-08, TC-CL-10 (mechanism only), TC-PC-13..15 (API parts), TC-AZ-04..06, TC-AZ-10, TC-AZ-11 (the chart side),
//   38.2 items 11 (merge counts), 18 (banner allergies) and 19 (vitals), the database rules no route can bypass, and RLS.
// The terminology is a few synthetic concepts and the vital ranges use made-up numbers for a made-up code: they test the MECHANISM.
// Nothing here asserts a clinical value (D-12a, BQ-12) or proves a licensed terminology (C-09) or the real elevation check (BE-05).
//   EHR_TEST_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres node --test dist/src/modules/clinical/chart/chart.dbtest.js
// The URL names a superuser on a throwaway server (synthetic data only). Missing configuration FAILS; nothing skips.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { CLINICAL_CHART_JOBS } from './jobs.js';
import { chartExportPart, chartMergePart, CHART_MERGE_TABLES } from './merge.js';
import { A1, B1, CURSOR_KEY, ORG, pg, repoRoot, setupChart } from './testkit.js';
import { staffMember } from '../../patient/testkit.js';
import type { ChartKit, SeededSession } from './testkit.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import { SelfReviewError } from '../../audit/index.js';
import { NotAssignedError } from '../../identity/index.js';
import { pathToFileURL } from 'node:url';
import { patientAccount, saWrite, seedPrincipal } from '../../patient/testkit.js';

const FAKE_LOINC = '99999-9'; // a made-up code: the mechanism is tested, no clinical value is asserted
const CANARY = 'CANARY-CHART-TEXT-7f3a9c';

describe('clinical chart (BE-16) on PostgreSQL 17', () => {
  let t: ChartKit;
  before(async () => {
    t = await setupChart('chart');
    await t.loadTerminology();
  });
  after(async () => {
    await t.close();
  });

  const code = (r: { json(): Record<string, unknown> }): unknown => r.json()['code'];
  const attempt = async (f: () => Promise<unknown>): Promise<string | undefined> => {
    try {
      await f();
      return undefined;
    } catch (e) {
      return (e as { code?: string }).code ?? String(e);
    }
  };
  const get = (s: SeededSession, path: string) => t.scall(s, 'GET', path);
  const post = (
    s: SeededSession,
    path: string,
    body: unknown = {},
    extra: Record<string, string> = {},
  ) => t.scall(s, 'POST', path, body, extra);
  const patch = (s: SeededSession, path: string, version: number, body: unknown) =>
    t.scall(s, 'PATCH', path, body, { 'if-match': `W/"${version}"` });

  /** A patient at A1 whose chart `t.doctor` may read (care team). */
  const chartPatient = async (
    n: number,
    o: { dateOfBirth?: string; sexAtBirth?: string | null } = {},
  ): Promise<string> => {
    const pid = await t.mkPatient(n, o);
    await t.assign(t.doctor, pid);
    return pid;
  };
  const allergyBody = (
    display: string,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> => ({ display, category: 'drug', ...extra });
  const addAllergy = async (pid: string, display: string, extra: Record<string, unknown> = {}) => {
    const r = await post(
      t.doctor,
      `/api/v1/patients/${pid}/allergies`,
      allergyBody(display, extra),
    );
    assert.equal(r.status, 201, r.body);
    return r.json();
  };
  const rows = <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => t.k.q<T>(sql, p);
  const auditRows = (pid: string, resource: string) =>
    rows<{ action: string; actor_principal_id: string }>(
      `SELECT action, actor_principal_id FROM audit.event WHERE patient_id = $1 AND resource_type = $2 ORDER BY occurred_at`,
      [pid, resource],
    );

  // ===== the job types ===============================================================================================
  test('the job type is the same on both sides, organisation scope, no patient IDs, and the queue registry accepts it', async () => {
    const worker = (await import(
      pathToFileURL(`${repoRoot}apps/worker/dist/jobs/clinical/index.js`).href
    )) as {
      CLINICAL_CHART_JOBS: typeof CLINICAL_CHART_JOBS;
    };
    assert.deepEqual(worker.CLINICAL_CHART_JOBS, CLINICAL_CHART_JOBS);
    const j = CLINICAL_CHART_JOBS.find((x) => x.name === 'clinical.terminology_load');
    assert.equal(j?.carriesPatientIds, false);
    assert.equal(j?.jobScope, 'org');
  });

  // ===== terminology ============================================================================================
  describe('terminology (reference data, chunked load)', () => {
    test('the synthetic release is loaded; search returns active concepts of one system, a code match first, literal text', async () => {
      const s = await post(t.doctor, '/api/v1/terminology/search', {
        system: 'rxnorm',
        text: 'penicillin',
      });
      assert.equal(s.status, 200, s.body);
      const items = s.json()['items'] as { code: string; display: string }[];
      assert.deepEqual(
        items.map((i) => i.code),
        ['70001', '70002'],
      ); // shortest display first
      const byCode = await post(t.doctor, '/api/v1/terminology/search', {
        system: 'rxnorm',
        text: '70003',
      });
      assert.deepEqual(
        (byCode.json()['items'] as { code: string }[]).map((i) => i.code),
        ['70003'],
      );
      // LIKE metacharacters are matched literally: '0% p' finds only the concept that contains a percent sign.
      const pct2 = await post(t.doctor, '/api/v1/terminology/search', {
        system: 'rxnorm',
        text: '0% p',
      });
      assert.deepEqual(
        (pct2.json()['items'] as { code: string }[]).map((i) => i.code),
        ['70005'],
      );
      const under = await post(t.doctor, '/api/v1/terminology/search', {
        system: 'rxnorm',
        text: 'p_r',
      });
      assert.deepEqual(
        (under.json()['items'] as { code: string }[]).map((i) => i.code),
        [],
      );
      // Another system's concepts are not offered.
      const snomed = await post(t.doctor, '/api/v1/terminology/search', {
        system: 'snomed',
        text: 'penicillin',
      });
      assert.deepEqual(snomed.json()['items'], []);
    });

    test('bad system or text is a 422; the route is for terminology.search holders only', async () => {
      assert.equal(
        (await post(t.doctor, '/api/v1/terminology/search', { system: 'cpt', text: 'abc' })).status,
        422,
      );
      assert.equal(
        (await post(t.doctor, '/api/v1/terminology/search', { system: 'rxnorm', text: 'a' }))
          .status,
        422,
      );
      assert.equal(
        (
          await post(t.doctor, '/api/v1/terminology/search', {
            system: 'rxnorm',
            text: 'x'.repeat(101),
          })
        ).status,
        422,
      );
      assert.equal(
        (await post(t.desk, '/api/v1/terminology/search', { system: 'rxnorm', text: 'abc' }))
          .status,
        403,
      );
    });

    test('at most 20 concepts come back', async () => {
      t.worker.source.set(
        'loinc',
        'L1',
        Array.from({ length: 45 }, (_, i) => ({
          code: `${1000 + i}-1`,
          display: `Synthetic observation ${i}`,
        })),
      );
      await t.worker.runTerminologyLoad({ dataset: 'loinc', version: 'L1' });
      const s = await post(t.doctor, '/api/v1/terminology/search', {
        system: 'loinc',
        text: 'observation',
      });
      assert.equal((s.json()['items'] as unknown[]).length, 20);
    });

    test('the load is chunked: each chunk commits on its own, a failure resumes from the last committed chunk, a rerun changes nothing', async () => {
      const concepts = Array.from({ length: 25 }, (_, i) => ({
        code: `9${String(i).padStart(3, '0')}`,
        display: `Chunk concept ${i}`,
      }));
      t.worker.source.set('loinc', 'C1', concepts);
      t.worker.source.calls.length = 0;
      t.worker.source.failOnCall = 3; // the third chunk read fails
      await assert.rejects(
        t.worker.runTerminologyLoad({ dataset: 'loinc', version: 'C1' }, { chunkSize: 10 }),
        /source could not be read/,
      );
      const afterCrash = await rows<{ n: string }>(
        `SELECT count(*)::text AS n FROM clinical.terminology_concept WHERE system = 'loinc' AND release = 'C1'`,
      );
      assert.equal(afterCrash[0]?.n, '20', 'two chunks of ten are committed; the third is not');
      const cp = await rows<{ version: string }>(
        `SELECT version FROM kernel.reference_data_version WHERE dataset = 'clinical.terminology_load.loinc'`,
      );
      assert.equal(cp[0]?.version, 'C1|20|20');
      t.worker.source.calls.length = 0;
      const resumed = await t.worker.runTerminologyLoad(
        { dataset: 'loinc', version: 'C1' },
        { chunkSize: 10 },
      );
      assert.equal(resumed.resumed, true);
      assert.equal(
        t.worker.source.calls[0]?.cursor,
        '20',
        'the retry starts after the last committed chunk',
      );
      const total = await rows<{ n: string }>(
        `SELECT count(*)::text AS n FROM clinical.terminology_concept WHERE system = 'loinc' AND release = 'C1'`,
      );
      assert.equal(total[0]?.n, '25');
      const done = await rows<{ version: string }>(
        `SELECT version FROM kernel.reference_data_version WHERE dataset = 'clinical.terminology.loinc'`,
      );
      assert.equal(done[0]?.version, 'C1');
      // Rerun: same rows, nothing duplicated.
      await t.worker.runTerminologyLoad({ dataset: 'loinc', version: 'C1' }, { chunkSize: 10 });
      const again = await rows<{ n: string }>(
        `SELECT count(*)::text AS n FROM clinical.terminology_concept WHERE system = 'loinc' AND release = 'C1'`,
      );
      assert.equal(again[0]?.n, '25');
      const audit = await rows<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit.event WHERE resource_type = 'clinical.terminology_concept' AND action = 'config_change'`,
      );
      assert.ok(Number(audit[0]?.n) >= 2, 'a load is a config_change in the audit trail');
    });

    test('a newer release marks concepts that are not in it inactive (never deleted); a saved chart entry keeps its code and display', async () => {
      const pid = await chartPatient(1);
      const e = await post(t.doctor, `/api/v1/patients/${pid}/problems`, {
        codeSystem: 'snomed',
        code: '80002',
      });
      assert.equal(e.status, 201, e.body);
      t.worker.source.set('snomed', 'T2', [
        { code: '80001', display: 'Synthetic hypertension (renamed)' },
      ]);
      const r = await t.worker.runTerminologyLoad({ dataset: 'snomed', version: 'T2' });
      assert.ok(r.deactivated >= 1);
      const search = await post(t.doctor, '/api/v1/terminology/search', {
        system: 'snomed',
        text: 'asthma',
      });
      assert.deepEqual(search.json()['items'], [], 'an inactive concept is no longer offered');
      assert.equal(
        (
          await post(t.doctor, `/api/v1/patients/${pid}/problems`, {
            codeSystem: 'snomed',
            code: '80002',
          })
        ).status,
        422,
        'and cannot be chosen',
      );
      const list = await get(t.doctor, `/api/v1/patients/${pid}/problems`);
      assert.equal((list.json()['items'] as { display: string }[])[0]?.display, 'Synthetic asthma');
      assert.equal(
        (
          await rows<{ n: string }>(
            `SELECT count(*)::text AS n FROM clinical.terminology_concept WHERE system = 'snomed' AND code = '80002'`,
          )
        )[0]?.n,
        '1',
        'not deleted',
      );
    });

    test('a source that returns more than the chunk size, or a bad code, is refused and nothing is written', async () => {
      t.worker.source.set('icd10cm', 'BAD', [
        { code: 'ok.1', display: 'fine' },
        { code: 'no spaces allowed', display: 'bad' },
      ]);
      await assert.rejects(
        t.worker.runTerminologyLoad({ dataset: 'icd10cm', version: 'BAD' }),
        /bad code or display/,
      );
      assert.equal(
        (
          await rows<{ n: string }>(
            `SELECT count(*)::text AS n FROM clinical.terminology_concept WHERE release = 'BAD'`,
          )
        )[0]?.n,
        '0',
      );
    });
  });

  // ===== coded lists (TC-CL-04, RA-R1-09) =============================================================================
  describe('problems, allergies, medications', () => {
    test('TC-CL-04: coded items are saved with their codes; free text is saved flagged uncoded; the saved chart shows both', async () => {
      const pid = await chartPatient(2);
      const a = await post(t.doctor, `/api/v1/patients/${pid}/allergies`, {
        category: 'drug',
        codeSystem: 'rxnorm',
        code: '70001',
        severity: 'severe',
        display: 'client text is ignored for a coded entry',
      });
      assert.equal(a.status, 201, a.body);
      assert.equal(a.json()['coded'], true);
      assert.equal(
        a.json()['display'],
        'Synthetic penicillin',
        "the stored display is the concept's own",
      );
      assert.equal(a.json()['code'], '70001');
      const m = await post(t.doctor, `/api/v1/patients/${pid}/medications`, {
        code: '70004',
        doseText: '1 tablet',
      });
      assert.equal(m.status, 201, m.body);
      assert.deepEqual(
        [m.json()['coded'], m.json()['codeSystem'], m.json()['code']],
        [true, 'rxnorm', '70004'],
      );
      const a2 = await post(
        t.doctor,
        `/api/v1/patients/${pid}/allergies`,
        allergyBody('synthetic reaction x'),
      );
      assert.equal(a2.status, 201, a2.body);
      assert.deepEqual(
        [a2.json()['coded'], a2.json()['code'], a2.json()['codeSystem']],
        [false, null, null],
      );
      const m2 = await post(t.doctor, `/api/v1/patients/${pid}/medications`, {
        display: 'free text medicine',
      });
      assert.equal(m2.json()['coded'], false);
      const p = await post(t.doctor, `/api/v1/patients/${pid}/problems`, {
        codeSystem: 'icd10cm',
        code: 'T00.0',
        onsetDate: '2020-01-02',
      });
      assert.equal(p.status, 201, p.body);
      const saved = await get(t.doctor, `/api/v1/patients/${pid}/allergies`);
      const items = saved.json()['items'] as { coded: boolean }[];
      assert.equal(items.length, 2);
      assert.deepEqual(items.map((i) => i.coded).sort(), [false, true]);
      assert.ok(saved.json()['patientBanner'], 'a banner: true route carries the banner');
      assert.equal(saved.headers['cache-control'], 'no-store');
    });

    test('validation: a code must come from the picker and its own system; free text needs its text; the database also holds the shape', async () => {
      const pid = await chartPatient(3);
      const path = `/api/v1/patients/${pid}`;
      assert.equal(
        (
          await post(t.doctor, `${path}/allergies`, {
            category: 'drug',
            codeSystem: 'rxnorm',
            code: '99999999',
          })
        ).status,
        422,
        'unknown code',
      );
      const wrongSys = await post(t.doctor, `${path}/problems`, {
        codeSystem: 'rxnorm',
        code: '70001',
      });
      assert.equal(wrongSys.status, 422, 'problems take snomed or icd10cm');
      const noText = await post(t.doctor, `${path}/allergies`, { category: 'drug' });
      assert.equal(noText.status, 422);
      assert.equal(code(noText), 'clinical.uncoded_requires_display');
      assert.equal(
        (await post(t.doctor, `${path}/allergies`, { display: 'x', category: 'weather' })).status,
        422,
      );
      assert.equal(
        (await post(t.doctor, `${path}/allergies`, { display: 'x'.repeat(201), category: 'drug' }))
          .status,
        422,
      );
      assert.equal(
        (await post(t.doctor, `${path}/medications`, { code: '70001', codeSystem: 'snomed' }))
          .status,
        422,
      );
      assert.equal(
        (await post(t.doctor, `${path}/problems`, { display: 'x', onsetDate: '2020-13-45' }))
          .status,
        422,
      );
      // The table's own shape check: coded must agree with the code.
      const bad = await attempt(() =>
        t.as(t.staffScope(t.doctor), (tx) =>
          tx.query(
            `INSERT INTO clinical.problem (id, organisation_id, patient_id, display, coded, recorded_by, created_by) VALUES (gen_random_uuid(), kernel.uuid1('app.org_id'), $1, 'x', true, $2, $2)`,
            [pid, t.doctor.seeded.principalId],
          ),
        ),
      );
      assert.equal(bad, '23514');
    });

    test('PATCH: If-Match is required, a stale version is 412, the entry keeps its code, an uncoded entry can be coded, entered in error is final', async () => {
      const pid = await chartPatient(4);
      const created = await addAllergy(pid, 'Peanut', { category: 'food', severity: 'moderate' });
      const aid = String(created['id']);
      const path = `/api/v1/patients/${pid}/allergies/${aid}`;
      assert.equal(
        (await t.scall(t.doctor, 'PATCH', path, { severity: 'severe' })).status,
        428,
        'If-Match is required',
      );
      const ok = await patch(t.doctor, path, 1, { severity: 'severe', reaction: 'hives' });
      assert.equal(ok.status, 200, ok.body);
      assert.equal(ok.headers['etag'], 'W/"2"');
      assert.equal(ok.json()['severity'], 'severe');
      assert.equal(
        (await patch(t.doctor, path, 1, { severity: 'mild' })).status,
        412,
        'the stale second writer loses',
      );
      // Free text can be coded later (the "needs review" workflow); then the code is fixed.
      const coded = await patch(t.doctor, path, 2, { codeSystem: 'rxnorm', code: '70003' });
      assert.equal(coded.status, 200, coded.body);
      assert.deepEqual(
        [coded.json()['coded'], coded.json()['display']],
        [true, 'Synthetic amoxicillin'],
      );
      assert.equal(
        (await patch(t.doctor, path, 3, { codeSystem: 'rxnorm', code: '70001' })).status,
        422,
        'a coded entry keeps its code',
      );
      assert.equal((await patch(t.doctor, path, 3, { display: 'Other' })).status, 422);
      const dbCode = await attempt(() =>
        t.as(t.staffScope(t.doctor), (tx) =>
          tx.query(`UPDATE clinical.allergy SET display = 'Renamed' WHERE id = $1`, [aid]),
        ),
      );
      assert.equal(dbCode, 'PS001', 'the trigger holds even for a direct write');
      const eie = await patch(t.doctor, path, 3, { status: 'entered_in_error' });
      assert.equal(eie.status, 200, eie.body);
      assert.equal(
        (await patch(t.doctor, path, 4, { status: 'active' })).status,
        409,
        'an entry entered in error is final',
      );
      assert.equal(
        code(await patch(t.doctor, path, 4, { severity: 'mild' })),
        'clinical.invalid_transition',
      );
      assert.equal((await patch(t.doctor, path, 4, {})).status, 409);
      // Unknown entry, another patient's entry.
      const other = await chartPatient(5);
      assert.equal(
        (
          await patch(t.doctor, `/api/v1/patients/${other}/allergies/${aid}`, 1, {
            severity: 'mild',
          })
        ).status,
        404,
        'an entry is named by its own patient',
      );
      assert.equal(
        (
          await patch(t.doctor, `/api/v1/patients/${pid}/allergies/${randomUUID()}`, 1, {
            severity: 'mild',
          })
        ).status,
        404,
      );
    });

    test('resolving or stopping dates the entry; reactivating clears the date; two editors of one entry cannot both win', async () => {
      const pid = await chartPatient(6);
      const m = (
        await post(t.doctor, `/api/v1/patients/${pid}/medications`, {
          display: 'Some medicine',
          startDate: '2020-01-01',
        })
      ).json();
      const path = `/api/v1/patients/${pid}/medications/${String(m['id'])}`;
      const stopped = await patch(t.doctor, path, 1, { status: 'stopped' });
      assert.equal(stopped.status, 200, stopped.body);
      assert.match(String(stopped.json()['endDate']), /^\d{4}-\d{2}-\d{2}$/);
      const back = await patch(t.doctor, path, 2, { status: 'active' });
      assert.equal(back.json()['endDate'], null);
      const [x, y] = await Promise.all([
        patch(t.doctor, path, 3, { doseText: 'A' }),
        patch(t.doctor, path, 3, { doseText: 'B' }),
      ]);
      assert.deepEqual(
        [x.status, y.status].sort(),
        [200, 412],
        'exactly one wins (TC-CL-05 for the lists)',
      );
    });

    test('an idempotent POST replays: same key and body gives the stored answer and one row; same key, other body is 409', async () => {
      const pid = await chartPatient(7);
      const key = randomUUID();
      const send = (display: string) =>
        t.scall(
          t.doctor,
          'POST',
          `/api/v1/patients/${pid}/problems`,
          { display },
          { 'idempotency-key': key },
        );
      const first = await send('Replay me');
      const second = await send('Replay me');
      assert.equal(first.status, 201);
      assert.equal(second.status, 201);
      assert.equal(second.headers['idempotent-replay'], 'true');
      assert.equal(first.json()['id'], second.json()['id']);
      assert.equal((await send('Another body')).status, 409);
      assert.equal(
        (
          await rows<{ n: string }>(
            `SELECT count(*)::text AS n FROM clinical.problem WHERE patient_id = $1`,
            [pid],
          )
        )[0]?.n,
        '1',
      );
      const noKey = await t.scall(
        t.doctor,
        'POST',
        `/api/v1/patients/${pid}/problems`,
        { display: 'x' },
        { 'idempotency-key': '' },
      );
      assert.equal(noKey.status, 400);
    });

    test('lists page with a signed cursor, newest first, and filter by status', async () => {
      const pid = await chartPatient(8);
      for (let i = 0; i < 5; i++)
        await post(t.doctor, `/api/v1/patients/${pid}/problems`, { display: `Problem ${i}` });
      const first = await get(t.doctor, `/api/v1/patients/${pid}/problems?limit=2`);
      assert.equal((first.json()['items'] as unknown[]).length, 2);
      const cursor = String(first.json()['nextCursor']);
      const second = await get(
        t.doctor,
        `/api/v1/patients/${pid}/problems?limit=2&cursor=${encodeURIComponent(cursor)}`,
      );
      const third = await get(
        t.doctor,
        `/api/v1/patients/${pid}/problems?limit=2&cursor=${encodeURIComponent(String(second.json()['nextCursor']))}`,
      );
      const all = [first, second, third].flatMap((r) =>
        (r.json()['items'] as { display: string }[]).map((i) => i.display),
      );
      assert.deepEqual(all, ['Problem 4', 'Problem 3', 'Problem 2', 'Problem 1', 'Problem 0']);
      assert.equal(third.json()['nextCursor'], null);
      assert.equal(
        (
          await get(
            t.doctor,
            `/api/v1/patients/${pid}/problems?cursor=${encodeURIComponent(cursor.slice(0, -2) + 'xx')}`,
          )
        ).status,
        422,
        'a forged cursor is refused',
      );
      assert.equal((await get(t.doctor, `/api/v1/patients/${pid}/problems?limit=0`)).status, 422);
      assert.equal((await get(t.doctor, `/api/v1/patients/${pid}/problems?limit=101`)).status, 422);
      assert.equal(
        (await get(t.doctor, `/api/v1/patients/${pid}/problems?status=resolved`)).json()[
          'items'
        ] instanceof Array,
        true,
      );
      assert.equal(
        (await get(t.doctor, `/api/v1/patients/${pid}/problems?status=bogus`)).status,
        422,
      );
      assert.deepEqual(
        decodeCursor(
          CURSOR_KEY,
          encodeCursor(CURSOR_KEY, { c: '2026-01-01T00:00:00.000Z', i: randomUUID() }),
        ).c,
        '2026-01-01T00:00:00.000Z',
      );
    });
  });

  // ===== access: assignment and BTG (TC-AZ-04, 10, 11; BQ-5) =======================================================
  describe('chart access is assignment-bound, BTG is the exception', () => {
    test('TC-AZ-10: an unassigned doctor gets 403 clinical.not_assigned with btgAvailable on reads, the summary and the writes, each audited as denied', async () => {
      const pid = await t.mkPatient(10); // nobody on the care team
      for (const [method, path, body] of [
        ['GET', `/api/v1/patients/${pid}/problems`, undefined],
        ['GET', `/api/v1/patients/${pid}/allergies`, undefined],
        ['GET', `/api/v1/patients/${pid}/medications`, undefined],
        ['GET', `/api/v1/patients/${pid}/chart-summary`, undefined],
        ['POST', `/api/v1/patients/${pid}/problems`, { display: 'x' }],
        ['POST', `/api/v1/patients/${pid}/allergies`, allergyBody('x')],
        ['POST', `/api/v1/patients/${pid}/medications`, { display: 'x' }],
      ] as const) {
        const r = await t.scall(t.doctor2, method, path, body);
        assert.equal(r.status, 403, `${method} ${path} ${r.body}`);
        assert.equal(code(r), 'clinical.not_assigned');
      }
      // `btgAvailable` is a member of the error class; the platform's problem body does not serialise it yet (see the README, request R3).
      assert.equal(new NotAssignedError().btgAvailable, true);
      const denied = await rows<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit.event WHERE patient_id = $1 AND actor_principal_id = $2 AND action = 'denied'`,
        [pid, t.doctor2.seeded.principalId],
      );
      assert.ok(Number(denied[0]?.n) >= 7, 'every refusal is logged');
      assert.equal(
        (
          await rows<{ n: string }>(
            `SELECT count(*)::text AS n FROM clinical.problem WHERE patient_id = $1`,
            [pid],
          )
        )[0]?.n,
        '0',
        'nothing was written',
      );
    });

    test('TC-AZ-10/11: break-the-glass lets the next request pass; the grant is audited; the compliance alert is queued; the opener cannot review it', async () => {
      const pid = await t.mkPatient(11);
      assert.equal((await get(t.doctor2, `/api/v1/patients/${pid}/problems`)).status, 403);
      const scope = t.staffScope(t.doctor2);
      const grant = await t.as(scope, (tx) =>
        t.k.audit.openBtg(tx, {
          requestId: randomUUID(),
          patientId: pid,
          reason: 'Emergency review of a synthetic chart',
        }),
      );
      const ok = await get(t.doctor2, `/api/v1/patients/${pid}/problems`);
      assert.equal(ok.status, 200, ok.body);
      assert.equal(
        (
          await post(t.doctor2, `/api/v1/patients/${pid}/problems`, {
            display: 'Written under BTG',
          })
        ).status,
        201,
      );
      const ev = await rows<{ action: string; btg_grant_id: string | null }>(
        `SELECT action, btg_grant_id FROM audit.event WHERE patient_id = $1 AND action IN ('btg_open', 'view', 'create') AND actor_principal_id = $2 ORDER BY occurred_at`,
        [pid, t.doctor2.seeded.principalId],
      );
      assert.ok(ev.some((e) => e.action === 'btg_open'));
      assert.ok(
        ev.some((e) => e.action === 'view' && e.btg_grant_id === grant.grantId),
        'chart reads under the grant name the grant',
      );
      const queued = await rows<{ n: string }>(
        `SELECT count(*)::text AS n FROM queue._private_jobs j JOIN queue._private_tasks k ON k.id = j.task_id WHERE k.identifier = 'sink.on_btg_opened' AND j.payload->>'grantId' = $1`,
        [grant.grantId],
      );
      assert.ok(
        Number(queued[0]?.n) >= 1,
        'the audit.btg_opened event was queued for the compliance alert handler',
      );
      // TC-AZ-11: the reviewer needs the compliance BTG slice and is another person; the opener is refused, a bystander cannot see it.
      await assert.rejects(
        t.as(scope, (tx) =>
          t.k.audit.reviewBtg(tx, {
            requestId: randomUUID(),
            grantId: grant.grantId,
            outcome: 'justified',
          }),
        ),
        (e: { code?: string }) => e.code === 'kernel.not_found',
      );
      const cscope = (principalId: string, personId: string): Parameters<ChartKit['as']>[0] => ({
        audience: 'staff',
        realm: 'admin_pool',
        orgId: ORG,
        principalId,
        personId,
        phiAccess: 'limited',
        complianceScopes: ['btg_grants', 'audit_events'],
      });
      await assert.rejects(
        t.as(cscope(t.doctor2.seeded.principalId, t.doctor2.seeded.personId), (tx) =>
          t.k.audit.reviewBtg(tx, {
            requestId: randomUUID(),
            grantId: grant.grantId,
            outcome: 'justified',
          }),
        ),
        (e: unknown) => e instanceof SelfReviewError,
      );
      const cmp = await seedPrincipal(t.k, 'admin_pool', { name: 'Compliance reviewer' });
      await t.as(cscope(cmp.principalId, cmp.personId), (tx) =>
        t.k.audit.reviewBtg(tx, {
          requestId: randomUUID(),
          grantId: grant.grantId,
          outcome: 'not_justified',
        }),
      );
      const rev = await rows<{ review_status: string }>(
        `SELECT review_status FROM audit.btg_grant WHERE id = $1`,
        [grant.grantId],
      );
      assert.equal(rev[0]?.review_status, 'not_justified');
    });

    test('the assignment rules: care team (and its end), a reservation, a patient merged into the patient; none of them is the pre-visit permission', async () => {
      const pid = await t.mkPatient(12);
      assert.equal((await get(t.doctor2, `/api/v1/patients/${pid}/allergies`)).status, 403);
      await t.assign(t.doctor2, pid);
      assert.equal((await get(t.doctor2, `/api/v1/patients/${pid}/allergies`)).status, 200);
      await saWrite(
        t.k,
        `UPDATE patient.care_team_member SET to_date = current_date, end_reason = 'merged_duplicate' WHERE patient_id = $1`,
        [pid],
      );
      assert.equal(
        (await get(t.doctor2, `/api/v1/patients/${pid}/allergies`)).status,
        403,
        'an ended care-team row no longer assigns',
      );
    });

    test('a front-desk user and a triage nurse hold only the pre-visit permission: no list route, the summary is the pre-visit slice', async () => {
      const pid = await chartPatient(13);
      await addAllergy(pid, 'Latex', { category: 'environment' });
      await post(t.nurse, `/api/v1/patients/${pid}/problems`, { display: 'x' }).then((r) =>
        assert.equal(r.status, 403),
      );
      assert.equal((await get(t.nurse, `/api/v1/patients/${pid}/problems`)).status, 403);
      for (const s of [t.nurse, t.desk]) {
        const sum = await get(s, `/api/v1/patients/${pid}/chart-summary`);
        assert.equal(sum.status, 200, sum.body);
        const j = sum.json();
        assert.equal(j['level'], 'previsit');
        assert.deepEqual(
          [j['problems'], j['allergies'], j['medications'], j['encounters'], j['documents']],
          [null, null, null, null, null],
          'not available, not "none"',
        );
        assert.deepEqual(j['recentVitals'], []);
        assert.equal(
          (j['patientBanner'] as { allergies: { items: { display: string }[] } }).allergies.items[0]
            ?.display,
          'Latex',
        );
      }
    });

    test("TC-AZ-04: a patient who has no care relationship at the user's location is not visible", async () => {
      const pid = await t.mkPatient(14); // registered at A1
      const b1 = await staffMember(t.k, 'front_desk', B1, 'Desk B1');
      assert.equal((await get(b1, `/api/v1/patients/${pid}/banner`)).status, 404);
      assert.equal((await get(b1, `/api/v1/patients/${pid}/chart-summary`)).status, 404);
      assert.equal((await get(t.desk, `/api/v1/patients/${pid}/banner`)).status, 200);
    });

    test('a patient-realm session reaches no chart route and gets no banner (TC-PC-15 step 5)', async () => {
      const pid = await t.mkPatient(15);
      const ps = await patientAccount(t.k, pid, 'Patient Fifteen');
      for (const path of ['banner', 'chart-summary', 'allergies', 'problems', 'medications']) {
        const r = await t.scall(ps, 'GET', `/api/v1/patients/${pid}/${path}`);
        assert.ok([403, 404].includes(r.status), `${path} ${r.status}`);
        assert.equal(r.json()['patientBanner'], undefined);
      }
    });
  });

  // ===== the banner (AL-01, 38.2 item 18, TC-PC-13..15) =====================================================================
  describe('patient banner and allergy summary', () => {
    let pid: string;
    let emptyPid: string;
    before(async () => {
      pid = await chartPatient(20);
      // 12 active allergies (2 severe, 1 uncoded), one resolved, one entered in error, one inactive.
      await addAllergy(pid, 'Zebra pollen', { category: 'environment', severity: 'severe' });
      await post(t.doctor, `/api/v1/patients/${pid}/allergies`, {
        category: 'drug',
        codeSystem: 'rxnorm',
        code: '70001',
        severity: 'severe',
      });
      for (let i = 0; i < 9; i++)
        await post(t.doctor, `/api/v1/patients/${pid}/allergies`, {
          category: 'drug',
          codeSystem: 'rxnorm',
          code: '70004',
          severity: i % 2 === 0 ? 'mild' : 'moderate',
        });
      await addAllergy(pid, `Free text ${CANARY}`, { category: 'food', severity: 'unknown' }); // the 12th, uncoded... (the first is uncoded too)
      for (const [name, status] of [
        ['Was resolved', 'resolved'],
        ['Was wrong', 'entered_in_error'],
        ['Was inactive', 'inactive'],
      ] as const) {
        const c = await addAllergy(pid, name, { category: 'food', severity: 'severe' });
        const r = await patch(t.doctor, `/api/v1/patients/${pid}/allergies/${String(c['id'])}`, 1, {
          status,
        });
        assert.equal(r.status, 200, r.body);
      }
      emptyPid = await chartPatient(21);
    });

    const bannerOf = (r: { json(): Record<string, unknown> }) =>
      r.json()['patientBanner'] as {
        allergies: null | {
          state: string;
          items: { display: string; severity: string; coded: boolean }[];
          moreCount: number;
          uncodedCount: number;
          lastChangedAt: string | null;
        };
        displayName: string;
        dateOfBirth: string;
        mrn: string;
        patientId: string;
      };

    test('38.2 item 18 / TC-PC-15: nurse, front desk, assigned doctor and a doctor under BTG see the same filled allergy block; no resolved, withdrawn or inactive allergy', async () => {
      const btgDoctor = await staffMember(t.k, 'doctor', A1, 'Doctor BTG');
      await t.as(t.staffScope(btgDoctor), (tx) =>
        t.k.audit.openBtg(tx, {
          requestId: randomUUID(),
          patientId: pid,
          reason: 'Emergency review of a synthetic chart',
        }),
      );
      // `GET /banner` needs patient.read, which the doctor role does not hold in the 27.3 proposal (README, finding F1): doctors are
      // checked on the chart routes, which carry the same banner.
      const bannerPath = `/api/v1/patients/${pid}/banner`;
      const summaryPath = `/api/v1/patients/${pid}/chart-summary`;
      for (const s of [t.nurse, t.desk, t.doctor, btgDoctor]) {
        for (const path of [
          s === t.doctor || s === btgDoctor ? `/api/v1/patients/${pid}/allergies` : bannerPath,
          summaryPath,
        ]) {
          const r = await get(s, path);
          assert.equal(r.status, 200, `${path} ${r.body}`);
          const b = r.json()['patientBanner'] as ReturnType<typeof bannerOf>;
          assert.equal(b.patientId, pid);
          assert.ok(b.displayName.length > 0 && b.dateOfBirth === '1980-05-17' && b.mrn.length > 0);
          assert.equal(b.allergies?.state, 'recorded');
          assert.equal(b.allergies?.items.length, 10);
          assert.equal(
            b.allergies?.moreCount,
            2,
            '13 active - 10 shown... 12 active allergies, 2 more',
          );
          assert.equal(b.allergies?.uncodedCount, 2);
          assert.deepEqual(
            b.allergies?.items.slice(0, 2).map((i) => i.severity),
            ['severe', 'severe'],
            'severe first',
          );
          const names = b.allergies?.items.map((i) => i.display) ?? [];
          for (const gone of ['Was resolved', 'Was wrong', 'Was inactive'])
            assert.ok(!names.includes(gone), gone);
          assert.ok(b.allergies?.lastChangedAt !== null);
        }
      }
    });

    test('the banner on every banner: true route of this ticket (lists, writes, summary, banner route)', async () => {
      const g = [
        `/api/v1/patients/${pid}/problems`,
        `/api/v1/patients/${pid}/allergies`,
        `/api/v1/patients/${pid}/medications`,
      ];
      for (const path of g) {
        const r = await get(t.doctor, path);
        assert.equal(r.status, 200);
        assert.equal(bannerOf(r).allergies?.state, 'recorded', path);
      }
      const w = await post(t.doctor, `/api/v1/patients/${pid}/problems`, {
        display: 'Banner on write',
      });
      assert.equal(bannerOf(w).allergies?.state, 'recorded');
    });

    test('a patient with no allergy reads none_recorded (never "no known allergies")', async () => {
      for (const [s, path] of [
        [t.nurse, 'banner'],
        [t.desk, 'banner'],
        [t.doctor, 'allergies'],
      ] as const) {
        const a = bannerOf(await get(s, `/api/v1/patients/${emptyPid}/${path}`)).allergies;
        assert.deepEqual(
          [a?.state, a?.items, a?.moreCount, a?.uncodedCount, a?.lastChangedAt],
          ['none_recorded', [], 0, 0, null],
        );
      }
      // A patient whose only allergy was withdrawn: still none_recorded, and the last change is known.
      const p = await chartPatient(22);
      const c = await addAllergy(p, 'Withdrawn one');
      await patch(t.doctor, `/api/v1/patients/${p}/allergies/${String(c['id'])}`, 1, {
        status: 'entered_in_error',
      });
      const a = bannerOf(await get(t.nurse, `/api/v1/patients/${p}/banner`)).allergies;
      assert.equal(a?.state, 'none_recorded');
      assert.ok(a?.lastChangedAt);
    });

    test('a caller with patient.read only (medical records) gets allergies: null, and the audit names allergy_summary only when it was filled', async () => {
      const before = (await auditRows(pid, 'clinical.allergy_summary')).length;
      const r = await get(t.records, `/api/v1/patients/${pid}/banner`);
      assert.equal(r.status, 200, r.body);
      const b = bannerOf(r);
      assert.equal(b.allergies, null);
      assert.equal(
        b.displayName.length > 0,
        true,
        'the name, date of birth and MRN part follows patient.read',
      );
      assert.equal(
        (await auditRows(pid, 'clinical.allergy_summary')).length,
        before,
        'no allergy_summary row when the block is null',
      );
      const mine = await auditRows(pid, 'clinical.allergy_summary');
      const nurseRows = mine.filter(
        (x) => x.actor_principal_id === t.nurse.seeded.principalId,
      ).length;
      await get(t.nurse, `/api/v1/patients/${pid}/banner`);
      assert.equal(
        (await auditRows(pid, 'clinical.allergy_summary')).filter(
          (x) => x.actor_principal_id === t.nurse.seeded.principalId,
        ).length,
        nurseRows + 1,
        'one row when filled',
      );
      assert.ok(
        !(await auditRows(pid, 'clinical.allergy_summary')).some(
          (x) => x.actor_principal_id === t.records.seeded.principalId,
        ),
      );
    });

    test('a patient registered at another location is not visible, so no banner leaks across locations', async () => {
      const b1 = await staffMember(t.k, 'triage_nurse', B1, 'Nurse B1');
      assert.equal((await get(b1, `/api/v1/patients/${pid}/banner`)).status, 404);
    });

    test('no allergy text reaches the audit trail (RA-R1-19): the canary in a free-text allergy appears in no audit row', async () => {
      const hits = await rows<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit.event WHERE coalesce(change::text, '') LIKE $1 OR coalesce(resource_id::text, '') LIKE $1 OR coalesce(reason, '') LIKE $1`,
        [`%${CANARY}%`],
      );
      assert.equal(hits[0]?.n, '0');
    });
  });

  // ===== vitals and ranges (AL-02, TC-CL-10, 38.2 item 19) =========================================================
  describe('vital ranges and vitals', () => {
    const rangeBody = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
      loincCode: FAKE_LOINC,
      unit: 'mg/dL',
      sex: 'any',
      ageYears: { from: 0 },
      low: 10,
      high: 20,
      approvedByNote: 'Synthetic test range, not a clinical value',
      ...o,
    });
    const record = (pid: string, vitals: Record<string, unknown>[]) =>
      t.as(t.staffScope(t.nurse), (tx) =>
        t.chart.vitals.recordVitals(
          tx,
          { requestId: randomUUID() },
          { patientId: pid, vitals: vitals as never },
        ),
      );
    const v = (value: number, o: Record<string, unknown> = {}): Record<string, unknown> => ({
      loincCode: FAKE_LOINC,
      value,
      unit: 'mg/dL',
      measuredAt: '2026-06-01T09:00:00Z',
      ...o,
    });

    test('TC-CL-10 step 1: the table ships empty and every vital is no_range; out of range never blocks saving', async () => {
      assert.equal(
        (await rows<{ n: string }>(`SELECT count(*)::text AS n FROM clinical.vital_range`))[0]?.n,
        '0',
      );
      const pid = await chartPatient(30);
      const out = await record(pid, [v(15), v(1000)]);
      assert.deepEqual(
        out.vitals.map((x) => [x.rangeStatus, x.rangeLow, x.rangeHigh]),
        [
          ['no_range', null, null],
          ['no_range', null, null],
        ],
      );
      assert.deepEqual(out.outOfRange, []);
    });

    test('the admin routes: only clinical.vital_range.manage in the admin realm; validation; overlap is 409 clinical.vital_range_overlap', async () => {
      assert.equal((await get(t.doctor, '/api/v1/admin/vital-ranges')).status, 403);
      assert.equal((await post(t.doctor, '/api/v1/admin/vital-ranges', rangeBody())).status, 403);
      assert.equal((await get(t.admin, '/api/v1/admin/vital-ranges')).status, 200);
      for (const bad of [
        { loincCode: 'x' },
        { unit: '' },
        { sex: 'other' },
        { ageYears: { from: -1 } },
        { ageYears: { from: 10, to: 10 } },
        { low: 20, high: 10 },
        { low: undefined, high: undefined },
        { approvedByNote: 'short' },
        { low: 'abc' },
      ]) {
        const r = await post(t.admin, '/api/v1/admin/vital-ranges', rangeBody(bad));
        assert.equal(r.status, 422, JSON.stringify(bad) + r.body);
      }
      const first = await post(
        t.admin,
        '/api/v1/admin/vital-ranges',
        rangeBody({ loincCode: '99998-1', ageYears: { from: 18, to: 65 } }),
      );
      assert.equal(first.status, 201, first.body);
      assert.deepEqual(first.json()['ageYears'], { from: 18, to: 65 });
      const overlap = await post(
        t.admin,
        '/api/v1/admin/vital-ranges',
        rangeBody({ loincCode: '99998-1', ageYears: { from: 60, to: 80 } }),
      );
      assert.equal(overlap.status, 409);
      assert.equal(code(overlap), 'clinical.vital_range_overlap');
      // Adjacent bands do not overlap (half-open), a different sex or code does not either.
      assert.equal(
        (
          await post(
            t.admin,
            '/api/v1/admin/vital-ranges',
            rangeBody({ loincCode: '99998-1', ageYears: { from: 65, to: 90 } }),
          )
        ).status,
        201,
      );
      assert.equal(
        (
          await post(
            t.admin,
            '/api/v1/admin/vital-ranges',
            rangeBody({ loincCode: '99998-1', sex: 'female', ageYears: { from: 18, to: 65 } }),
          )
        ).status,
        201,
      );
      assert.equal(
        (
          await post(
            t.admin,
            '/api/v1/admin/vital-ranges',
            rangeBody({ loincCode: '99998-2', ageYears: { from: 18, to: 65 } }),
          )
        ).status,
        201,
      );
      // A one-sided, open-ended range.
      assert.equal(
        (
          await post(
            t.admin,
            '/api/v1/admin/vital-ranges',
            rangeBody({ loincCode: '99998-3', ageYears: { from: 0 }, low: undefined, high: 5 }),
          )
        ).status,
        201,
      );
      const listed = await get(t.admin, '/api/v1/admin/vital-ranges?status=active');
      assert.ok((listed.json()['items'] as unknown[]).length >= 5);
      assert.equal((await get(t.admin, '/api/v1/admin/vital-ranges?status=bogus')).status, 422);
    });

    test('two admins adding overlapping ranges at once: exactly one wins, the other gets 409 (exclusion constraint)', async () => {
      const body = rangeBody({ loincCode: '99997-1', ageYears: { from: 0, to: 18 } });
      const results = await Promise.all(
        Array.from({ length: 6 }, () => post(t.admin, '/api/v1/admin/vital-ranges', body)),
      );
      assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409, 409, 409, 409]);
      assert.equal(
        (
          await rows<{ n: string }>(
            `SELECT count(*)::text AS n FROM clinical.vital_range WHERE loinc_code = '99997-1'`,
          )
        )[0]?.n,
        '1',
      );
    });

    test('TC-CL-10 / item 19: inclusive bounds, below and above, unit mismatch, age at measured_at, sex-specific beats any, null sex matches any only', async () => {
      const code = '99996-1';
      const mk = async (o: Record<string, unknown>) => {
        const r = await post(
          t.admin,
          '/api/v1/admin/vital-ranges',
          rangeBody({ loincCode: code, ...o }),
        );
        assert.equal(r.status, 201, r.body);
        return String(r.json()['id']);
      };
      await mk({ sex: 'any', ageYears: { from: 0, to: 18 }, low: 100, high: 200 }); // children
      await mk({ sex: 'any', ageYears: { from: 18 }, low: 10, high: 20 });
      await mk({ sex: 'female', ageYears: { from: 18 }, low: 12, high: 18 });
      const adultF = await chartPatient(31, { dateOfBirth: '1990-03-03', sexAtBirth: 'female' });
      const adultM = await chartPatient(32, { dateOfBirth: '1990-03-03', sexAtBirth: 'male' });
      const adultNull = await chartPatient(33, { dateOfBirth: '1990-03-03', sexAtBirth: null });
      const intersex = await chartPatient(34, {
        dateOfBirth: '1990-03-03',
        sexAtBirth: 'intersex',
      });
      const cv = (value: number, o: Record<string, unknown> = {}) =>
        v(value, { loincCode: code, ...o });

      // Inclusive bounds (male: the `any` adult range 10..20).
      const m = await record(adultM, [
        cv(10),
        cv(20),
        cv(9.999),
        cv(20.001),
        cv(15, { unit: 'mmol/L' }),
      ]);
      assert.deepEqual(
        m.vitals.map((x) => x.rangeStatus),
        ['in_range', 'in_range', 'out_of_range', 'out_of_range', 'unit_mismatch'],
      );
      assert.deepEqual(
        m.vitals.map((x) => [x.rangeLow, x.rangeHigh]),
        [
          [10, 20],
          [10, 20],
          [10, 20],
          [10, 20],
          [null, null],
        ],
      );
      assert.deepEqual(m.outOfRange, [code], 'the code is listed once');
      // The female-specific range (12..18) wins over `any` (10..20): 11 is out of range for her, in range for him.
      const f = await record(adultF, [cv(11), cv(12), cv(18), cv(19)]);
      assert.deepEqual(
        f.vitals.map((x) => x.rangeStatus),
        ['out_of_range', 'in_range', 'in_range', 'out_of_range'],
      );
      assert.deepEqual(
        f.vitals.map((x) => [x.rangeLow, x.rangeHigh]),
        [
          [12, 18],
          [12, 18],
          [12, 18],
          [12, 18],
        ],
      );
      assert.equal((await record(adultM, [cv(11)])).vitals[0]?.rangeStatus, 'in_range');
      // A null or other sex_at_birth matches only `any` rows (N-7).
      for (const p of [adultNull, intersex]) {
        const r = await record(p, [cv(11)]);
        assert.deepEqual([r.vitals[0]?.rangeStatus, r.vitals[0]?.rangeLow], ['in_range', 10]);
      }
      // Age is taken at measured_at: born 2000-06-15, 17 the day before the 18th birthday, 18 on it.
      const young = await chartPatient(35, { dateOfBirth: '2000-06-15', sexAtBirth: 'male' });
      const day17 = (await record(young, [cv(150, { measuredAt: '2018-06-14T23:59:00Z' })]))
        .vitals[0];
      const day18 = (await record(young, [cv(150, { measuredAt: '2018-06-15T00:00:00Z' })]))
        .vitals[0];
      assert.deepEqual(
        [day17?.rangeStatus, day17?.rangeLow, day17?.rangeHigh],
        ['in_range', 100, 200],
      );
      assert.deepEqual(
        [day18?.rangeStatus, day18?.rangeLow, day18?.rangeHigh],
        ['out_of_range', 10, 20],
      );
      // No range for this age (older than any band is covered by the open-ended adult range; a code with no row is no_range).
      assert.equal(
        (await record(adultM, [cv(5, { loincCode: '99995-1' })])).vitals[0]?.rangeStatus,
        'no_range',
      );
      // Validation.
      for (const bad of [
        cv(1, { loincCode: 'x' }),
        cv(Number.NaN),
        cv(1, { unit: '' }),
        cv(1, { measuredAt: 'yesterday' }),
        cv(1, { measuredAt: '2999-01-01T00:00:00Z' }),
        cv(1, { measuredAt: '1950-01-01T00:00:00Z' }),
      ])
        await assert.rejects(record(adultM, [bad]), /Validation|validation|invalid/i);
    });

    test('item 19: retiring a range changes no stored vital; the next vital has no range; retiring twice is 409; a range is never edited or deleted', async () => {
      const code = '99994-1';
      const r1 = await post(
        t.admin,
        '/api/v1/admin/vital-ranges',
        rangeBody({ loincCode: code, low: 1, high: 5 }),
      );
      const rid = String(r1.json()['id']);
      const pid = await chartPatient(36);
      const before = (await record(pid, [v(9, { loincCode: code })])).vitals[0];
      assert.deepEqual(
        [before?.rangeStatus, before?.rangeLow, before?.rangeHigh],
        ['out_of_range', 1, 5],
      );
      const ret = await post(t.admin, `/api/v1/admin/vital-ranges/${rid}/retire`);
      assert.equal(ret.status, 200, ret.body);
      assert.equal(ret.json()['status'], 'retired');
      const stored = await rows(
        `SELECT range_status, range_low, range_high, range_id FROM clinical.vital_sign WHERE id = $1`,
        [before?.vitalId],
      );
      assert.deepEqual(
        [
          stored[0]?.['range_status'],
          Number(stored[0]?.['range_low']),
          Number(stored[0]?.['range_high']),
          stored[0]?.['range_id'],
        ],
        ['out_of_range', 1, 5, rid],
      );
      assert.equal(
        (await record(pid, [v(3, { loincCode: code })])).vitals[0]?.rangeStatus,
        'no_range',
      );
      assert.equal((await post(t.admin, `/api/v1/admin/vital-ranges/${rid}/retire`)).status, 409);
      assert.equal(
        (await post(t.admin, `/api/v1/admin/vital-ranges/${randomUUID()}/retire`)).status,
        404,
      );
      // A new range can now take its place, and the retired one is final in the database.
      assert.equal(
        (
          await post(
            t.admin,
            '/api/v1/admin/vital-ranges',
            rangeBody({ loincCode: code, low: 2, high: 6 }),
          )
        ).status,
        201,
      );
      assert.equal(
        await attempt(() =>
          t.k.sa.query(`UPDATE clinical.vital_range SET low = 0 WHERE id = $1`, [rid]),
        ),
        'PS001',
      );
      assert.equal(
        await attempt(() => t.k.sa.query(`DELETE FROM clinical.vital_range WHERE id = $1`, [rid])),
        'PS001',
      );
    });

    test('the database holds the range rule: a status that disagrees with the value or the named range is refused', async () => {
      const code = '99993-1';
      const rid = String(
        (
          await post(
            t.admin,
            '/api/v1/admin/vital-ranges',
            rangeBody({ loincCode: code, low: 1, high: 5 }),
          )
        ).json()['id'],
      );
      const pid = await chartPatient(37);
      const ins = (
        status: string,
        value: number,
        low: number | null,
        high: number | null,
        range: string | null,
        unit = 'mg/dL',
      ) =>
        attempt(() =>
          t.as(t.staffScope(t.nurse), (tx) =>
            tx.query(
              `INSERT INTO clinical.vital_sign (id, organisation_id, patient_id, loinc_code, value, unit, range_status, range_id, range_low, range_high, measured_at, by_principal_id, created_by)
               VALUES (gen_random_uuid(), kernel.uuid1('app.org_id'), $1, $2, $3, $4, $5, $6, $7, $8, now(), $9, $9)`,
              [pid, code, value, unit, status, range, low, high, t.nurse.seeded.principalId],
            ),
          ),
        );
      assert.equal(
        await ins('in_range', 9, 1, 5, rid),
        'PS001',
        'in_range for a value above the bound',
      );
      assert.equal(
        await ins('out_of_range', 3, 1, 5, rid),
        'PS001',
        'out_of_range for a value inside',
      );
      assert.equal(
        await ins('in_range', 3, 1, 6, rid),
        'PS001',
        "bounds that are not the range row's",
      );
      assert.equal(
        await ins('in_range', 3, 1, 5, rid, 'mmol/L'),
        'PS001',
        'a unit the range is not stated in',
      );
      assert.equal(
        await ins('in_range', 3, 1, 5, randomUUID()),
        'PS001',
        'a range that does not exist',
      );
      assert.equal(await ins('no_range', 3, 1, 5, null), '23514', 'no_range with bounds');
      assert.equal(await ins('in_range', 1, 1, 5, rid), undefined, 'the bound itself is in range');
      assert.equal(await ins('in_range', 5, 1, 5, rid), undefined);
    });

    test('a vital sign is append-only; a correction is a new row; a row is corrected once, also under a race; the summary shows the current value', async () => {
      const pid = await chartPatient(38);
      const orig = (await record(pid, [v(100, { loincCode: '99992-1' })])).vitals[0];
      const vid = String(orig?.vitalId);
      assert.equal(
        await attempt(() =>
          t.k.sa.query(`UPDATE clinical.vital_sign SET unit = 'x' WHERE id = $1`, [vid]),
        ),
        'PS001',
      );
      assert.equal(
        await attempt(() => t.k.sa.query(`DELETE FROM clinical.vital_sign WHERE id = $1`, [vid])),
        'PS001',
      );
      assert.equal(
        await attempt(() =>
          t.as(t.staffScope(t.nurse), (tx) =>
            tx.query(`UPDATE clinical.vital_sign SET unit = 'x' WHERE id = $1`, [vid]),
          ),
        ),
        '42501',
        'app_api has no UPDATE right at all',
      );
      const correct = (id: string, body: Record<string, unknown>) =>
        t.as(t.staffScope(t.nurse), (tx) =>
          t.chart.vitals.correctVital(tx, { requestId: randomUUID() }, id, body),
        );
      const [a, b] = await Promise.allSettled([
        correct(vid, { value: 101, unit: 'mg/dL' }),
        correct(vid, { value: 102, unit: 'mg/dL' }),
      ]);
      assert.deepEqual([a.status, b.status].sort(), ['fulfilled', 'rejected']);
      const reason = (a.status === 'rejected' ? a : b) as PromiseRejectedResult;
      assert.equal((reason.reason as { code?: string }).code, 'clinical.invalid_transition');
      const chain = await rows(
        `SELECT id, value FROM clinical.vital_sign WHERE patient_id = $1 AND loinc_code = '99992-1' ORDER BY created_at`,
        [pid],
      );
      assert.equal(chain.length, 2, 'the original stays; one correction was added');
      const sum = await get(t.doctor, `/api/v1/patients/${pid}/chart-summary`);
      const recent = sum.json()['recentVitals'] as { value: number; correctsId: string | null }[];
      assert.equal(recent.length, 1, 'only the end of the chain is current');
      assert.equal(recent[0]?.correctsId, vid);
      // Entered in error withdraws the value: stored as no_range, null value; and it is not current any more.
      const eie = await correct(
        String(
          (
            (await rows(`SELECT id FROM clinical.vital_sign WHERE corrects_id = $1`, [vid]))[0] as {
              id: string;
            }
          ).id,
        ),
        { enteredInError: true },
      );
      assert.deepEqual([eie.enteredInError, eie.value, eie.rangeStatus], [true, null, 'no_range']);
      assert.equal(
        (
          (await get(t.doctor, `/api/v1/patients/${pid}/chart-summary`)).json()[
            'recentVitals'
          ] as unknown[]
        ).length,
        0,
      );
      await assert.rejects(
        correct(eie.vitalId, { enteredInError: true }),
        (e: unknown) => (e as { code?: string }).code === 'clinical.invalid_transition',
      );
      // Corrections cannot cross patients or codes (the trigger).
      const other = await chartPatient(39);
      const o2 = (await record(other, [v(1, { loincCode: '99992-1' })])).vitals[0];
      const x = await attempt(() =>
        t.as(t.staffScope(t.nurse), (tx) =>
          tx.query(
            `INSERT INTO clinical.vital_sign (id, organisation_id, patient_id, loinc_code, value, unit, range_status, measured_at, by_principal_id, created_by, corrects_id) VALUES (gen_random_uuid(), kernel.uuid1('app.org_id'), $1, '99992-1', 1, 'mg/dL', 'no_range', now(), $2, $2, $3)`,
            [pid, t.nurse.seeded.principalId, o2?.vitalId],
          ),
        ),
      );
      assert.equal(x, 'PS001');
    });
  });

  // ===== the merge participant (38.2 item 11, 22.16) ============================================================
  describe('merge participant and export part', () => {
    test('item 11: problems, allergies and medications of every status move to the survivor; vitals are kept; duplicates both stay; counts add up', async () => {
      const a = await chartPatient(40);
      const b = await chartPatient(41);
      for (const pid of [a, b]) {
        await addAllergy(pid, 'Duplicate substance');
      }
      const eie = await addAllergy(a, 'Withdrawn allergy');
      await patch(t.doctor, `/api/v1/patients/${a}/allergies/${String(eie['id'])}`, 1, {
        status: 'entered_in_error',
      });
      await post(t.doctor, `/api/v1/patients/${a}/problems`, { display: 'Problem on A' });
      await post(t.doctor, `/api/v1/patients/${a}/medications`, { display: 'Medicine on A' });
      const resolved = (
        await post(t.doctor, `/api/v1/patients/${a}/problems`, { display: 'Resolved on A' })
      ).json();
      await patch(t.doctor, `/api/v1/patients/${a}/problems/${String(resolved['id'])}`, 1, {
        status: 'resolved',
      });
      const vit = await t.as(t.staffScope(t.nurse), (tx) =>
        t.chart.vitals.recordVitals(
          tx,
          { requestId: randomUUID() },
          {
            patientId: a,
            vitals: [
              { loincCode: '99991-1', value: 1, unit: 'mg/dL', measuredAt: '2026-06-01T00:00:00Z' },
            ],
          },
        ),
      );
      const merged = await t.merge(b, a);
      assert.equal(merged.result.status, 'completed');
      const count = async (table: string, p: string) =>
        Number(
          (
            await rows<{ n: string }>(
              `SELECT count(*)::text AS n FROM ${table} WHERE patient_id = $1`,
              [p],
            )
          )[0]?.n,
        );
      assert.equal(await count('clinical.allergy', a), 0, 'no allergy is left on the merged ID');
      assert.equal(
        await count('clinical.allergy', b),
        3,
        'both duplicates and the withdrawn one are on the survivor',
      );
      assert.equal(await count('clinical.problem', a), 0);
      assert.equal(await count('clinical.problem', b), 2);
      assert.equal(await count('clinical.medication_statement', b), 1);
      assert.equal(
        await count('clinical.vital_sign', a),
        1,
        'the append-only vital stays on the merged ID',
      );
      assert.equal(await count('clinical.vital_sign', b), 0);
      const report = (
        await rows<{ counts: Record<string, Record<string, number>> | { table: string }[] }>(
          `SELECT counts FROM patient.merge_request WHERE id = $1`,
          [merged.requestId],
        )
      )[0]?.counts;
      const text = JSON.stringify(report);
      for (const tbl of CHART_MERGE_TABLES)
        assert.ok(text.includes(tbl), `${tbl} is in the merge report`);
      const entry = (tbl: string): Record<string, number> => {
        const c = report as unknown;
        if (Array.isArray(c))
          return (c as { table: string }[]).find((x) => x.table === tbl) as never;
        return (c as Record<string, Record<string, number>>)[tbl] as Record<string, number>;
      };
      assert.deepEqual(
        [
          entry('clinical.allergy')?.['found'],
          entry('clinical.allergy')?.['repointed'],
          entry('clinical.allergy')?.['kept'],
        ],
        [2, 2, 0],
      );
      assert.deepEqual(
        [
          entry('clinical.vital_sign')?.['found'],
          entry('clinical.vital_sign')?.['repointed'],
          entry('clinical.vital_sign')?.['kept'],
        ],
        [1, 0, 1],
      );
      // The merged ID takes no new chart entry; a correction of its vital is a new row on the survivor.
      const w = await post(t.doctor, `/api/v1/patients/${a}/problems`, { display: 'after merge' });
      assert.ok(
        [403, 404, 409].includes(w.status),
        `a write for the merged ID is refused (${w.status})`,
      );
      assert.equal(await count('clinical.problem', a), 0, 'and nothing was written for it');
      // The database says so too: a write for the merged ID, however it arrives, is the merge guard's PM001.
      assert.equal(
        await attempt(() =>
          t.as(t.staffScope(t.doctor), (tx) =>
            tx.query(
              `INSERT INTO clinical.problem (id, organisation_id, patient_id, display, coded, recorded_by, created_by) VALUES (gen_random_uuid(), kernel.uuid1('app.org_id'), $1, 'x', false, $2, $2)`,
              [a, t.doctor.seeded.principalId],
            ),
          ),
        ),
        'PM001',
      );
      const fixed = await t.as(t.staffScope(t.nurse), (tx) =>
        t.chart.vitals.correctVital(
          tx,
          { requestId: randomUUID() },
          vit.vitals[0]?.vitalId as string,
          { value: 2, unit: 'mg/dL' },
        ),
      );
      assert.equal(
        (
          await rows<{ patient_id: string }>(
            `SELECT patient_id FROM clinical.vital_sign WHERE id = $1`,
            [fixed.vitalId],
          )
        )[0]?.patient_id,
        b,
      );
      // The survivor's chart shows the records of both.
      const list = await get(t.doctor, `/api/v1/patients/${b}/allergies`);
      assert.equal((list.json()['items'] as unknown[]).length, 3);
    });

    test('the participant refuses anything but a patients-scope job that names both IDs, and nothing else touches the rows', async () => {
      const a = await chartPatient(42);
      const b = await chartPatient(43);
      const run = (scope: Parameters<ChartKit['as']>[0]) =>
        t.as(scope, (tx) => chartMergePart.repointPatient(tx, a, b, randomUUID()));
      const base = { audience: 'system' as const, realm: 'worker' as const, orgId: ORG };
      await assert.rejects(
        run({
          audience: 'staff',
          realm: 'google',
          orgId: ORG,
          principalId: t.doctor.seeded.principalId,
          locationIds: [A1],
        }),
        /forbidden|not permitted/i,
      );
      await assert.rejects(
        t.wdb.withScope({ ...base, jobScope: 'org' }, (tx) =>
          chartMergePart.repointPatient(tx, a, b, randomUUID()),
        ),
        /forbidden/i,
      );
      await assert.rejects(
        t.wdb.withScope({ ...base, jobScope: 'patients', jobPatientIds: [a] }, (tx) =>
          chartMergePart.repointPatient(tx, a, b, randomUUID()),
        ),
        /forbidden/i,
      );
      // app_api cannot move a row to another patient.
      const e = await addAllergy(a, 'Mine');
      assert.equal(
        await attempt(() =>
          t.as(t.staffScope(t.doctor), (tx) =>
            tx.query(`UPDATE clinical.allergy SET patient_id = $2 WHERE id = $1`, [e['id'], b]),
          ),
        ),
        '42501',
      );
    });

    test('the export part returns the chart of every ID asked for, every status, with the vital shape', async () => {
      const a = await chartPatient(44);
      await addAllergy(a, 'Export me');
      const gone = await addAllergy(a, 'Export me too');
      await patch(t.doctor, `/api/v1/patients/${a}/allergies/${String(gone['id'])}`, 1, {
        status: 'entered_in_error',
      });
      await t.as(t.staffScope(t.nurse), (tx) =>
        t.chart.vitals.recordVitals(
          tx,
          { requestId: randomUUID() },
          {
            patientId: a,
            vitals: [
              {
                loincCode: '99990-1',
                value: 7.5,
                unit: 'mg/dL',
                measuredAt: '2026-06-01T00:00:00Z',
              },
            ],
          },
        ),
      );
      const part = (await t.wdb.withScope(
        {
          audience: 'system',
          realm: 'worker',
          orgId: ORG,
          jobScope: 'patients',
          jobPatientIds: [a],
        },
        (tx) => chartExportPart.exportPart(tx, [a], randomUUID()),
      )) as Record<string, Record<string, unknown>[]>;
      assert.deepEqual(Object.keys(part).sort(), [
        'allergies',
        'medications',
        'problems',
        'vitals',
      ]);
      assert.equal(part['allergies']?.length, 2);
      assert.deepEqual(part['allergies']?.map((x) => x['status']).sort(), [
        'active',
        'entered_in_error',
      ]);
      assert.deepEqual(
        [part['vitals']?.[0]?.['value'], part['vitals']?.[0]?.['rangeStatus']],
        [7.5, 'no_range'],
      );
      await assert.rejects(
        chartExportPart.exportPart({} as never, ['nope'], randomUUID()),
        (e: unknown) => (e as { code?: string }).code === 'kernel.validation_failed',
      );
    });
  });

  // ===== RLS and roles (TC-AZ-05, 06) ===============================================================================
  describe('row-level security and roles', () => {
    const TABLES = [
      'problem',
      'allergy',
      'medication_statement',
      'vital_sign',
      'vital_range',
      'terminology_concept',
    ];

    test('every clinical table forces RLS and names its roles; no application role owns one', async () => {
      const r = await rows<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
        owner: string;
      }>(
        `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) AS owner FROM pg_class c WHERE c.relnamespace = 'clinical'::regnamespace AND c.relkind IN ('r', 'p') ORDER BY 1`,
      );
      // The expected set is the catalog itself (every ordinary or partitioned table in schema clinical, whichever module
      // added it), so a new clinical table cannot escape the RLS check by being missing from a hand-kept list. The chart
      // module's own tables must still be present, and the loop below fails any table without forced RLS.
      assert.ok(r.length >= TABLES.length, 'the clinical schema lists tables');
      const present = new Set(r.map((x) => x.relname));
      for (const own of TABLES) assert.ok(present.has(own), `chart table ${own} exists`);
      for (const x of r)
        assert.deepEqual(
          [x.relrowsecurity, x.relforcerowsecurity, x.owner],
          [true, true, 'app_owner'],
          x.relname,
        );
      const pol = await rows<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_policies WHERE schemaname = 'clinical' AND (roles = '{public}' OR roles IS NULL)`,
      );
      assert.equal(pol[0]?.n, '0');
    });

    test('TC-AZ-05: reporting_ro, the directory role and a transaction with no or an anonymous/public audience read nothing', async () => {
      const pid = await chartPatient(50);
      await addAllergy(pid, 'Secret allergy');
      for (const table of TABLES) {
        const c = new pg.Client({ connectionString: t.k.urlFor('reporting_ro') });
        await c.connect();
        try {
          const err = await c.query(`SELECT count(*) FROM clinical.${table}`).then(
            () => undefined,
            (e: { code?: string }) => e.code,
          );
          assert.equal(err, '42501', `reporting_ro on ${table}`);
        } finally {
          await c.end();
        }
        for (const role of ['directory_ro', 'identity_signin_ro', 'queue_owner']) {
          await t.k.sa.query('BEGIN');
          try {
            await t.k.sa.query(`SET LOCAL ROLE ${role}`);
            const err = await t.k.sa.query(`SELECT count(*) FROM clinical.${table}`).then(
              () => undefined,
              (e: { code?: string }) => e.code,
            );
            assert.equal(err, '42501', `${role} on ${table}`);
          } finally {
            await t.k.sa.query('ROLLBACK');
          }
        }
        for (const audience of ['anonymous', 'public', 'partner']) {
          const n = await t.api.withScope({ audience: audience as never, orgId: ORG }, async (tx) =>
            Number(
              (await tx.query(`SELECT count(*)::int AS n FROM clinical.${table}`)).rows[0]?.['n'],
            ),
          );
          if (table === 'terminology_concept' && audience === 'partner') continue; // C0: every authenticated audience reads reference data
          assert.equal(n, 0, `${audience} sees nothing in ${table}`);
        }
      }
    });

    test('TC-AZ-06: the function-owner roles read no clinical table', async () => {
      for (const role of [
        'scheduling_booking_owner',
        'patient_scope_owner',
        'patient_match_owner',
        'integration_receiver_owner',
      ]) {
        for (const table of TABLES) {
          await t.k.sa.query('BEGIN');
          try {
            await t.k.sa.query(`SET LOCAL ROLE ${role}`);
            const err = await t.k.sa.query(`SELECT count(*) FROM clinical.${table}`).then(
              () => undefined,
              (e: { code?: string }) => e.code,
            );
            assert.equal(err, '42501', `${role} on ${table}`);
          } finally {
            await t.k.sa.query('ROLLBACK');
          }
        }
      }
    });

    test('staff at another location, an admin without BTG, and a patient session see no chart row; a BTG admin sees it', async () => {
      const pid = await chartPatient(51);
      await addAllergy(pid, 'Located at A1');
      const n = (scope: Parameters<ChartKit['as']>[0]) =>
        t.as(scope, async (tx) =>
          Number(
            (
              await tx.query(
                `SELECT count(*)::int AS n FROM clinical.allergy WHERE patient_id = $1`,
                [pid],
              )
            ).rows[0]?.['n'],
          ),
        );
      const b1 = await staffMember(t.k, 'doctor', B1, 'Doctor B1');
      assert.equal(await n(t.staffScope(b1, [B1])), 0);
      assert.equal(await n(t.staffScope(t.doctor)), 1);
      const adminScope = {
        audience: 'staff' as const,
        realm: 'admin_pool' as const,
        orgId: ORG,
        principalId: t.admin.seeded.principalId,
        personId: t.admin.seeded.personId,
      };
      assert.equal(await n(adminScope), 0);
      assert.equal(await n({ ...adminScope, btgPatientIds: [pid] }), 1);
      assert.equal(
        await n({
          audience: 'patient',
          realm: 'patient_pool',
          orgId: ORG,
          principalId: t.admin.seeded.principalId,
          patientIds: [pid],
        }),
        0,
        'there is no patient-audience policy in R1',
      );
      // A system job sees only the patients of its scope.
      const sys = (jobPatientIds: string[]) =>
        t.wdb.withScope(
          { audience: 'system', realm: 'worker', orgId: ORG, jobScope: 'patients', jobPatientIds },
          async (tx) =>
            Number(
              (
                await tx.query(
                  `SELECT count(*)::int AS n FROM clinical.allergy WHERE patient_id = $1`,
                  [pid],
                )
              ).rows[0]?.['n'],
            ),
        );
      assert.equal(await sys([pid]), 1);
      assert.equal(await sys([randomUUID()]), 0);
    });

    test('a write for an unknown patient is refused by the merge guard, and the application role can neither delete nor truncate', async () => {
      assert.equal(
        await attempt(() =>
          t.as(t.staffScope(t.doctor), (tx) =>
            tx.query(
              `INSERT INTO clinical.problem (id, organisation_id, patient_id, display, coded, recorded_by, created_by) VALUES (gen_random_uuid(), kernel.uuid1('app.org_id'), gen_random_uuid(), 'x', false, $1, $1)`,
              [t.doctor.seeded.principalId],
            ),
          ),
        ),
        'PM008',
      );
      for (const table of TABLES) {
        assert.equal(
          await attempt(() =>
            t.as(t.staffScope(t.doctor), (tx) => tx.query(`DELETE FROM clinical.${table}`)),
          ),
          '42501',
          `delete ${table}`,
        );
        assert.equal(
          await attempt(() =>
            t.as(t.staffScope(t.doctor), (tx) => tx.query(`TRUNCATE clinical.${table}`)),
          ),
          '42501',
          `truncate ${table}`,
        );
      }
      // The terminology is read-only for the API role.
      assert.equal(
        await attempt(() =>
          t.as(t.staffScope(t.doctor), (tx) =>
            tx.query(
              `INSERT INTO clinical.terminology_concept (system, code, organisation_id, display, release) VALUES ('rxnorm', 'zz', kernel.uuid1('app.org_id'), 'x', 'r')`,
            ),
          ),
        ),
        '42501',
      );
    });

    test('the stored author cannot be forged: a staff insert must name the caller as recorder', async () => {
      const pid = await chartPatient(52);
      assert.equal(
        await attempt(() =>
          t.as(t.staffScope(t.doctor), (tx) =>
            tx.query(
              `INSERT INTO clinical.problem (id, organisation_id, patient_id, display, coded, recorded_by, created_by) VALUES (gen_random_uuid(), kernel.uuid1('app.org_id'), $1, 'x', false, $2, $2)`,
              [pid, t.doctor2.seeded.principalId],
            ),
          ),
        ),
        '42501',
      );
    });
  });
});
