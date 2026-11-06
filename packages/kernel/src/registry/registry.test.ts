import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExportContributor, MergeParticipant } from './registry.js';
import { ParticipantRegistries, RegistryError, defaultRegistries } from './registry.js';

// Fixture modules: stand-ins for what BE modules register; the merge job and the export own no per-module logic.
const fixtureMerge = (
  module: string,
  tables: string[],
  rules: { table: string; rule: string }[] = [],
): MergeParticipant => ({
  module,
  tables,
  conflictRules: rules,
  repointPatient: async () =>
    tables.map((table) => ({ table, found: 0, repointed: 0, resolved: 0, kept: 0, deleted: [] })),
});
const fixtureExport = (module: string): ExportContributor => ({
  module,
  exportPart: async () => ({ module }),
});

test('merge participants: register, duplicate refused, listed in a stable order', () => {
  const r = new ParticipantRegistries();
  r.registerMergeParticipant(fixtureMerge('scheduling', ['scheduling.slot_reservation']));
  r.registerMergeParticipant(
    fixtureMerge('clinical', ['clinical.note'], [{ table: 'clinical.note', rule: 'none' }]),
  );
  r.registerMergeParticipant(fixtureMerge('documents', ['documents.document']));
  assert.throws(
    () => r.registerMergeParticipant(fixtureMerge('clinical', ['clinical.problem'])),
    RegistryError,
  );
  assert.deepEqual(
    r.mergeParticipants().map((p) => p.module),
    ['clinical', 'documents', 'scheduling'],
  );
  // same list whatever the registration order
  const r2 = new ParticipantRegistries();
  for (const m of ['documents', 'scheduling', 'clinical'])
    r2.registerMergeParticipant(fixtureMerge(m, [`${m}.t`]));
  assert.deepEqual(
    r2.mergeParticipants().map((p) => p.module),
    ['clinical', 'documents', 'scheduling'],
  );
});

test('export contributors: register, duplicate refused, listed in a stable order', () => {
  const r = new ParticipantRegistries();
  for (const m of ['telehealth', 'messaging', 'identity'])
    r.registerExportContributor(fixtureExport(m));
  assert.throws(() => r.registerExportContributor(fixtureExport('messaging')), RegistryError);
  assert.deepEqual(
    r.exportContributors().map((c) => c.module),
    ['identity', 'messaging', 'telehealth'],
  );
});

test('merge participant declarations are validated', () => {
  const r = new ParticipantRegistries();
  assert.throws(() => r.registerMergeParticipant(fixtureMerge('a', [])), /tables/);
  assert.throws(() => r.registerMergeParticipant(fixtureMerge('a', ['b.t'])), /not in schema/);
  assert.throws(() => r.registerMergeParticipant(fixtureMerge('a', ['a.t', 'a.t'])), /twice/);
  assert.throws(
    () => r.registerMergeParticipant(fixtureMerge('a', ['a.t'], [{ table: 'a.u', rule: 'x' }])),
    /unlisted/,
  );
  assert.throws(() => r.registerExportContributor(fixtureExport('Bad Name')), RegistryError);
});

test('the two registries are independent and a participant is stored by copy', () => {
  const r = new ParticipantRegistries();
  const tables = ['a.t'];
  r.registerMergeParticipant(fixtureMerge('a', tables));
  tables.push('a.u');
  assert.deepEqual(r.mergeParticipants()[0]!.tables, ['a.t']);
  assert.equal(r.exportContributors().length, 0);
  assert.ok(defaultRegistries instanceof ParticipantRegistries);
});
