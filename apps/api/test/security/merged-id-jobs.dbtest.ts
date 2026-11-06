// SEC03-F07 item 5 (HEAAA-180): SHARED-BOUNDARIES 9.2 required test "a queued job with the merged ID for one `resolve` type and one `fail`
// type, each behaving as declared", on PostgreSQL 17 after a real merge (request, second-staff approval, execute job). The job is enqueued
// through the real API-path queue wrapper and read back from the queue; the job-start rule is the kernel's `applyOnMerged` with a lookup
// over the real merge map. LIMITATION: the worker runner does not yet call `applyOnMerged` at job start (see the SEC03-F07 report); this
// file proves the registry and the rule, not the wiring.
//   EHR_TEST_ADMIN_URL=postgres://postgres@host:5432/postgres node --test dist/test/security/merged-id-jobs.dbtest.js
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { applyOnMerged, JobPatientMergedError, Queue, syncTaskTypes } from '@ehr/kernel';
import type { PatientState, Tx } from '@ehr/kernel';
import { adminUrl, pg } from '../../src/modules/scheduling/core/testkit.js';
import { setupScheduling } from '../../src/modules/scheduling/core/testkit.js';
import type { SchedKit } from '../../src/modules/scheduling/core/testkit.js';

let t: SchedKit;
let survivor: string;
let merged: string;
let other: string;
before(async () => {
  t = await setupScheduling('mrgjob');
  t.k.registry.defineJob({
    name: 'sec03.resolve_probe',
    maxAttempts: 3,
    onMerged: 'resolve',
    carriesPatientIds: true,
    jobScope: 'patients',
  });
  t.k.registry.defineJob({
    name: 'sec03.fail_probe',
    maxAttempts: 3,
    onMerged: 'fail',
    carriesPatientIds: true,
    jobScope: 'patients',
  });
  const wc = new pg.Client({ connectionString: t.k.urlFor('app_worker') });
  await wc.connect();
  await syncTaskTypes(wc, t.k.registry);
  await wc.end();
  survivor = await t.mkPatient(31);
  merged = await t.mkPatient(32);
  other = await t.mkPatient(33);
  await t.merge(survivor, merged);
});
after(async () => {
  await t?.close();
});
void adminUrl;

const lookup =
  (tx: Tx) =>
  async (id: string): Promise<PatientState> => {
    const r = await tx.query(
      `SELECT p.status, m.final_survivor_id FROM patient.patient p LEFT JOIN patient.patient_merge m ON m.merged_id = p.id WHERE p.id = $1::uuid`,
      [id],
    );
    const row = r.rows[0] as { status: string; final_survivor_id: string | null } | undefined;
    if (row === undefined) return { state: 'unknown' };
    return row.status === 'merged' && row.final_survivor_id !== null
      ? { state: 'merged', survivorId: row.final_survivor_id }
      : row.status === 'active'
        ? { state: 'active' }
        : { state: 'unknown' };
  };

async function enqueueAndRead(job: string, patientId: string): Promise<{ patientId: string }> {
  const staff = await t.staffScope();
  await t.as({ ...staff, audience: 'staff' }, (tx) =>
    new Queue(t.k.registry, 'api').enqueue(tx, job, { patientId }),
  );
  const r = await t.k.sa.query(
    `SELECT j.payload FROM queue._private_jobs j JOIN queue._private_tasks k ON k.id = j.task_id WHERE k.identifier = $1 ORDER BY j.id DESC LIMIT 1`,
    [job],
  );
  return (r.rows[0] as { payload: { patientId: string } }).payload;
}

describe('9.2 queued job naming a merged patient ID', () => {
  test('the registry accepts the fail declaration and both types are enqueued by the API path with the merged ID in the payload', async () => {
    assert.equal(t.k.registry.get('sec03.fail_probe').onMerged, 'fail');
    assert.equal((await enqueueAndRead('sec03.resolve_probe', merged)).patientId, merged);
    assert.equal((await enqueueAndRead('sec03.fail_probe', merged)).patientId, merged);
  });

  test('resolve type: the merged ID is replaced by its final survivor; an active ID is used as it is', async () => {
    const p = await enqueueAndRead('sec03.resolve_probe', merged);
    const type = t.k.registry.get('sec03.resolve_probe');
    const ids = await t.worker.withScope(t.workerScope, (tx) =>
      applyOnMerged(type, [p.patientId, other], lookup(tx)),
    );
    assert.deepEqual(ids, [survivor, other]);
  });

  test('fail type: the merged ID dead-letters the job with code patient.merged; an active ID passes', async () => {
    const p = await enqueueAndRead('sec03.fail_probe', merged);
    const type = t.k.registry.get('sec03.fail_probe');
    await t.worker.withScope(t.workerScope, async (tx) => {
      await assert.rejects(
        applyOnMerged(type, [p.patientId], lookup(tx)),
        (e: unknown) => e instanceof JobPatientMergedError && e.code === 'patient.merged',
      );
      assert.deepEqual(await applyOnMerged(type, [other], lookup(tx)), [other]);
    });
  });

  test('a type that declares nothing is treated as fail', async () => {
    await t.worker.withScope(t.workerScope, async (tx) => {
      await assert.rejects(
        applyOnMerged({ carriesPatientIds: true } as never, [merged], lookup(tx)),
        JobPatientMergedError,
      );
    });
  });
});
