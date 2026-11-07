// R8-B1: POST /waitlist-entries has a real request schema, and the API's validation (the flow controller and WaitlistService.createEntry)
// accepts exactly what it describes. The YAML is read as text (the api package has no YAML parser).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const yaml = readFileSync(
  new URL('../../../../../packages/contracts/openapi/scheduling.yaml', import.meta.url),
  'utf8',
);
const block = (start: RegExp, indent: number): string => {
  const m = start.exec(yaml);
  assert.ok(m, `${start} not found`);
  const rest = yaml.slice(m.index + m[0].length);
  const end = new RegExp(`\\n {0,${indent}}\\S`).exec(rest);
  return rest.slice(0, end === null ? undefined : end.index);
};

const REQUIRED = ['from', 'patientId', 'serviceId', 'to'];

test('POST /waitlist-entries request is the strict PostWaitlistEntriesRequest schema, not an opaque object', () => {
  const op = block(/\n {2}\/api\/v1\/waitlist-entries:\n/, 2);
  assert.match(op, /requestBody:[\s\S]*#\/components\/schemas\/PostWaitlistEntriesRequest/);
  assert.doesNotMatch(op.split('x-error-codes')[0] ?? '', /OpaqueObject/);
  assert.match(op, /'201':/);
  assert.match(op, /#\/components\/schemas\/WaitlistEntry'/);
  const s = block(/\n {4}PostWaitlistEntriesRequest:\n/, 4);
  assert.match(s, /additionalProperties: false/);
  const required = /required:\n((?: {8}- \w+\n?)+)/.exec(s)?.[1] ?? '';
  assert.deepEqual([...required.matchAll(/- (\w+)/g)].map((x) => x[1]).sort(), REQUIRED);
});

test('the controller refuses exactly the properties the schema does not declare', () => {
  const src = readFileSync(
    new URL('../../../src/modules/scheduling/flow/controller.ts', import.meta.url),
    'utf8',
  );
  const m = /WAITLIST_ENTRY_FIELDS = \[([^\]]*)\]/.exec(src);
  assert.ok(m?.[1]);
  const fields = m[1]
    .split(',')
    .map((x) => x.trim().replace(/'/g, ''))
    .sort();
  const s = block(/\n {4}PostWaitlistEntriesRequest:\n/, 4);
  const props = /properties:\n([\s\S]*?)\n {6}required:/.exec(s)?.[1] ?? '';
  const declared = [...props.matchAll(/^ {8}(\w+):/gm)].map((x) => x[1]).sort();
  assert.deepEqual(fields, declared);
});
