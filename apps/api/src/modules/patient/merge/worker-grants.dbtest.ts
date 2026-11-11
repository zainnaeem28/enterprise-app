// Real-database tests for SEC03-F11 (HEAAA-687; docs/security/SEC03-F11-worker-merge-grants-hardening-spec.md section 5): the re-pointing
// runs in the patient_scope_owner / scheduling_booking_owner functions of migration 2503, which refuse unless the call is the executing
// merge for the job's two patients. The tests that need app_worker to have lost its table grants (section 5 items 1 and 2, AC-3) belong to
// the contract migration 2504 (HEAAA-722 D1) and are not in this file.
//   EHR_TEST_ADMIN_URL=postgres://postgres@host:5432/postgres node --test dist/src/modules/patient/merge/worker-grants.dbtest.js
// The URL names a superuser on a throwaway server (synthetic data only). Missing configuration FAILS; nothing skips.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import type { Tx } from '@ehr/kernel';
import { confirmedBooking } from '../testkit.js';
import { A1, A2, ORG, pg, saWrite, setupMerge } from './testkit.js';
import type { MergeKit } from './testkit.js';

let m: MergeKit;
before(async () => {
  m = await setupMerge('f11');
});
after(async () => {
  await m?.close();
});

const q = <T = Record<string, unknown>>(sql: string, p?: unknown[]): Promise<T[]> =>
  m.k.q<T>(sql, p);
const w = (sql: string, p: unknown[] = []): Promise<void> => saWrite(m.k, sql, p);
let next = 3000;
const patient = (): Promise<string> => m.mkPatient(next++, m.deskA1, A1);

const PARTICIPANT_FUNCTIONS = [
  'patient.merge_repoint_patient_contact',
  'patient.merge_repoint_insurance_coverage',
  'patient.merge_repoint_consent',
  'patient.merge_repoint_communication_preference',
  'patient.merge_repoint_care_team_member',
  'patient.merge_repoint_duplicate_flag',
  'scheduling.merge_repoint_slot_reservation',
] as const;

class Rollback extends Error {}
const patientsJob = (ids: string[]) =>
  ({
    audience: 'system',
    realm: 'worker',
    orgId: ORG,
    jobScope: 'patients',
    jobPatientIds: ids,
  }) as const;

/** Runs fn in a patients-scope worker transaction for `ids` and always rolls it back. */
async function inJob<T>(ids: string[], fn: (tx: Tx) => Promise<T>): Promise<T> {
  let out: T | undefined;
  try {
    await m.k.wdb.withScope(patientsJob(ids), async (tx) => {
      out = await fn(tx);
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return out as T;
}

/** The SQLSTATE of a refused statement (or 'ok' with the row count) without aborting the transaction. */
async function attempt(tx: Tx, sql: string, params: unknown[] = []): Promise<string> {
  await tx.query('SAVEPOINT probe');
  try {
    const r = await tx.query(sql, params);
    await tx.query('RELEASE SAVEPOINT probe');
    return `ok:${r.rowCount ?? 0}`;
  } catch (e) {
    await tx.query('ROLLBACK TO SAVEPOINT probe');
    return String((e as { code?: unknown }).code);
  }
}

async function approved(survivor: string, merged: string): Promise<string> {
  const r = await m.request(m.lead, survivor, merged);
  assert.equal(r.status, 200, r.body);
  const id = r.json()['id'] as string;
  const a = await m.approve(m.mr, id);
  assert.equal(a.status, 200, a.body);
  return id;
}

async function seed(p: string): Promise<void> {
  await w(
    `INSERT INTO patient.patient_contact (id, organisation_id, patient_id, kind, name) VALUES (gen_random_uuid(), $1, $2, 'emergency', 'Contact')`,
    [ORG, p],
  );
  await w(
    `INSERT INTO patient.insurance_coverage (id, organisation_id, patient_id, payer_name, member_id) VALUES (gen_random_uuid(), $1, $2, 'Payer', 'M-1')`,
    [ORG, p],
  );
  await w(
    `INSERT INTO patient.consent (id, organisation_id, patient_id, template_key, template_version, template_language, status, signed_at, signer_principal_id, signer_relationship, signed_name)
     VALUES (gen_random_uuid(), $1, $2, 'privacy', 1, 'en', 'signed', now(), gen_random_uuid(), 'self', 'Typed Name')`,
    [ORG, p],
  );
  await w(
    `INSERT INTO patient.communication_preference (patient_id, organisation_id, channels, language) VALUES ($2, $1, ARRAY['sms']::text[], 'en')`,
    [ORG, p],
  );
  await w(
    `INSERT INTO patient.care_team_member (id, organisation_id, patient_id, principal_id, role) VALUES (gen_random_uuid(), $1, $2, $3, 'clinician')`,
    [ORG, p, randomUUID()],
  );
  const other = await patient();
  await w(
    `INSERT INTO patient.duplicate_flag (id, organisation_id, patient_id, candidate_patient_id, strength, source, status, created_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 'probable', 'front_desk', 'open', now())`,
    [ORG, p, other],
  );
  await confirmedBooking(m.k, p, A2);
}

describe('SEC03-F11 worker merge grants', () => {
  test('3. wrong-patient call: the executing merge A->B, a function called with a request naming other patients, is refused (42501)', async () => {
    const [a, b, x, y] = [await patient(), await patient(), await patient(), await patient()];
    await seed(b);
    const r1 = await approved(a, b);
    const r2 = await approved(x, y);
    const res = await inJob([a, b], async (tx) => {
      await tx.lockPatients([a, b], 'no_key_update');
      await tx.callScopeOwner('patient.begin_merge', [r1], [a, b]);
      const out: Record<string, string> = {};
      for (const fn of PARTICIPANT_FUNCTIONS) {
        out[`${fn} other request`] = await attempt(tx, `SELECT * FROM ${fn}($1::uuid)`, [r2]);
        out[`${fn} unknown request`] = await attempt(tx, `SELECT * FROM ${fn}($1::uuid)`, [
          randomUUID(),
        ]);
        out[`${fn} null`] = await attempt(tx, `SELECT * FROM ${fn}(NULL::uuid)`);
      }
      out['executing request, accepted'] = await attempt(
        tx,
        `SELECT * FROM patient.merge_repoint_patient_contact($1::uuid)`,
        [r1],
      );
      return out;
    });
    for (const [k, v] of Object.entries(res))
      assert.equal(v, k === 'executing request, accepted' ? 'ok:1' : '42501', k);
    // A job that holds only one of the two IDs does not pass for the right request either.
    const half = await inJob([a], (tx) =>
      attempt(tx, `SELECT * FROM patient.merge_repoint_consent($1::uuid)`, [r1]),
    );
    assert.equal(half, '42501');
    // An organisation-wide job and a different organisation are refused.
    let orgJob = 'none';
    try {
      await m.k.wdb.withScope(
        { audience: 'system', realm: 'worker', orgId: ORG, jobScope: 'org' },
        async (tx) => {
          orgJob = await attempt(tx, `SELECT * FROM patient.merge_repoint_consent($1::uuid)`, [r1]);
          throw new Rollback();
        },
      );
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    }
    assert.equal(orgJob, '42501');
  });

  test('4. a merge that is not executing (approved, completed, failed) is refused by every function (PM012)', async () => {
    const [a, b] = [await patient(), await patient()];
    const approvedId = await approved(a, b);
    const [c, d] = [await patient(), await patient()];
    const done = await m.merge(c, d);
    assert.equal(done.result.status, 'completed');
    const [e, f] = [await patient(), await patient()];
    const failedId = await approved(e, f);
    await w(
      `UPDATE patient.merge_request SET status = 'failed', failure_code = 'patient.merge_failed' WHERE id = $1`,
      [failedId],
    );
    for (const [label, rid, ids] of [
      ['approved', approvedId, [a, b]],
      ['completed', done.requestId, [c, d]],
      ['failed', failedId, [e, f]],
    ] as const) {
      const res = await inJob([...ids], async (tx) => {
        const out: string[] = [];
        for (const fn of PARTICIPANT_FUNCTIONS)
          out.push(await attempt(tx, `SELECT * FROM ${fn}($1::uuid)`, [rid]));
        return out;
      });
      assert.deepEqual(
        res,
        PARTICIPANT_FUNCTIONS.map(() => 'PM012'),
        label,
      );
    }
  });

  test('5. catalog: the functions are definers with a fixed search_path, owned by NOLOGIN roles, executable by app_worker only', async () => {
    const fns = await q<{
      f: string;
      secdef: boolean;
      search_path: string | null;
      owner: string;
      login: boolean;
      public_exec: boolean;
      api_exec: boolean;
      worker_exec: boolean;
    }>(
      `SELECT n.nspname || '.' || p.proname AS f, p.prosecdef AS secdef,
              (SELECT c FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%') AS search_path,
              pg_get_userbyid(p.proowner) AS owner, r.rolcanlogin AS login,
              has_function_privilege(0, p.oid, 'EXECUTE') AS public_exec,
              has_function_privilege('app_api', p.oid, 'EXECUTE') AS api_exec,
              has_function_privilege('app_worker', p.oid, 'EXECUTE') AS worker_exec
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_roles r ON r.oid = p.proowner
        WHERE p.proname LIKE 'merge\\_repoint\\_%' OR p.proname = 'merge_job_check' ORDER BY 1`,
    );
    assert.equal(fns.length, PARTICIPANT_FUNCTIONS.length + 1);
    for (const f of fns) {
      assert.equal(f.secdef, true, f.f);
      assert.equal(f.search_path, 'search_path=pg_catalog', f.f);
      assert.equal(f.login, false, `${f.f} owner ${f.owner} is NOLOGIN`);
      assert.ok(['patient_scope_owner', 'scheduling_booking_owner'].includes(f.owner), f.f);
      assert.equal(f.public_exec, false, `${f.f} not executable by PUBLIC`);
      assert.equal(f.api_exec, false, `${f.f} not executable by app_api`);
      assert.equal(
        f.worker_exec,
        f.f !== 'patient.merge_job_check',
        `${f.f} executable by app_worker`,
      );
    }
    // Runtime half of AC-4: app_api cannot call one.
    const c = new pg.Client({ connectionString: m.k.urlFor('app_api') });
    await c.connect();
    try {
      await assert.rejects(
        c.query(`SELECT * FROM patient.merge_repoint_consent($1::uuid)`, [randomUUID()]),
        (e: { code?: string }) => e.code === '42501',
      );
    } finally {
      await c.end();
    }
  });

  test('6. the merge still re-points through the functions: rows move, K rows stay, found = re-pointed + resolved + kept, a signed consent is never withdrawn', async () => {
    const [s, d] = [await patient(), await patient()];
    await seed(s);
    await seed(d);
    const before = await q<{ n: string }>(
      `SELECT count(*) AS n FROM patient.patient_contact WHERE patient_id = $1`,
      [d],
    );
    assert.equal(before[0]?.n, '1');
    const done = await m.merge(s, d);
    assert.equal(done.result.status, 'completed');
    assert.equal(
      Number(
        (
          await q<{ n: string }>(
            `SELECT count(*) AS n FROM patient.patient_contact WHERE patient_id = $1`,
            [s],
          )
        )[0]?.n,
      ),
      2,
    );
    assert.equal(
      Number(
        (
          await q<{ n: string }>(
            `SELECT count(*) AS n FROM patient.consent WHERE patient_id = $1 AND status = 'withdrawn'`,
            [s],
          )
        )[0]?.n,
      ),
      0,
    );
    assert.equal(
      Number(
        (
          await q<{ n: string }>(
            `SELECT count(*) AS n FROM scheduling.slot_reservation WHERE patient_id = $1`,
            [s],
          )
        )[0]?.n,
      ),
      2,
    );
    if (done.result.status === 'completed')
      for (const [t, c] of Object.entries(done.result.counts))
        assert.equal(c.found, c.repointed + c.resolved + c.kept, t);
  });
});
