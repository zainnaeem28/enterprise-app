// The one registration of merge participants and export contributors (INT03-F04): it matches what it declares, a second call is a
// RegistryError, and a module left out is absent (the negative control the database suites rely on).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ParticipantRegistries, RegistryError } from '@ehr/kernel';
import {
  REGISTERED_EXPORT_MODULES,
  REGISTERED_MERGE_MODULES,
  newRegisteredRegistries,
  registerAllParticipants,
} from './register-participants.js';

const names = (xs: readonly { module: string }[]): string[] => xs.map((x) => x.module).sort();

test('every declared merge participant and export contributor is registered, and nothing else', () => {
  const r = newRegisteredRegistries();
  assert.deepEqual(names(r.mergeParticipants()), [...REGISTERED_MERGE_MODULES].sort());
  assert.deepEqual(names(r.exportContributors()), [...REGISTERED_EXPORT_MODULES].sort());
});

test('a second registration into the same registry is a RegistryError', () => {
  const r = new ParticipantRegistries();
  registerAllParticipants(r);
  assert.throws(() => registerAllParticipants(r), RegistryError);
});

test('negative control: a module left out is absent from both registries', () => {
  for (const m of REGISTERED_MERGE_MODULES) {
    const r = newRegisteredRegistries({ without: [m] });
    assert.ok(!names(r.mergeParticipants()).includes(m), `${m} is absent from merge participants`);
    assert.ok(!names(r.exportContributors()).includes(m), `${m} is absent from contributors`);
  }
});
