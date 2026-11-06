import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyOnMerged, JobPatientMergedError } from './on-merged.js';
import type { PatientState } from './on-merged.js';

const ACTIVE = 'a';
const MERGED = 'm';
const lookup = async (id: string): Promise<PatientState> =>
  id === ACTIVE
    ? { state: 'active' }
    : id === MERGED
      ? { state: 'merged', survivorId: 's' }
      : { state: 'unknown' };

test('resolve: an active ID is kept, a merged ID becomes its survivor', async () => {
  const t = { carriesPatientIds: true, onMerged: 'resolve' as const };
  assert.deepEqual(await applyOnMerged(t, [ACTIVE, MERGED], lookup), [ACTIVE, 's']);
});

test('fail: a merged ID dead-letters the job with patient.merged; an active ID passes', async () => {
  const t = { carriesPatientIds: true, onMerged: 'fail' as const };
  assert.deepEqual(await applyOnMerged(t, [ACTIVE], lookup), [ACTIVE]);
  await assert.rejects(
    applyOnMerged(t, [MERGED], lookup),
    (e: unknown) => e instanceof JobPatientMergedError && e.code === 'patient.merged',
  );
});

test('undeclared on_merged on a patient-carrying type is treated as fail; unknown IDs fail under both', async () => {
  await assert.rejects(
    applyOnMerged({ carriesPatientIds: true } as never, [MERGED], lookup),
    JobPatientMergedError,
  );
  await assert.rejects(
    applyOnMerged({ carriesPatientIds: true, onMerged: 'resolve' }, ['x'], lookup),
    JobPatientMergedError,
  );
});

test('a type without patient IDs is untouched', async () => {
  assert.deepEqual(
    await applyOnMerged({ carriesPatientIds: false, onMerged: 'none' }, [MERGED], lookup),
    [MERGED],
  );
});
