// Unit tests of the terminology load job that need no database: payload and chunk validation. The database behaviour (chunked
// commits, resume, idempotence, deactivation) is in the clinical chart real-database test.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { KernelDb } from '@ehr/kernel';
import { CLINICAL_CHART_JOBS } from './jobs.js';
import { InMemoryTerminologySource } from './stubs.js';
import { runTerminologyLoad, TerminologyLoadError } from './terminology-load.js';

const noDb = {
  withScope: () => Promise.reject(new Error('no database in this test')),
} as unknown as KernelDb;
const deps = (source = new InMemoryTerminologySource()) => ({
  db: noDb,
  orgId: '00000000-0000-7000-8000-0000000000a1',
  source,
});

test('the job type is organisation-scope, carries no patient and has no merge handling', () => {
  const j = CLINICAL_CHART_JOBS.find((x) => x.name === 'clinical.terminology_load');
  assert.ok(j);
  assert.equal(j.jobScope, 'org');
  assert.equal(j.carriesPatientIds, false);
  assert.equal(j.onMerged, 'none');
});

for (const bad of [
  undefined,
  {},
  { dataset: 'cpt', version: '1' },
  { dataset: 'rxnorm' },
  { dataset: 'rxnorm', version: 'a b' },
  { dataset: 'rxnorm', version: '' },
])
  test(`a bad payload is refused before anything is read: ${JSON.stringify(bad)}`, async () => {
    const source = new InMemoryTerminologySource();
    await assert.rejects(
      runTerminologyLoad(deps(source), bad),
      (e: unknown) => e instanceof TerminologyLoadError && e.kind === 'bad_payload',
    );
    assert.equal(source.calls.length, 0);
  });
