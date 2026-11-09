// Refusal-path test for the client release (DEVOPS-PLAN 6.2 CI item 2; with F-05, HEAAA-74). Producer and consumer meet:
// the numbers and headers come from the release scripts; the refusal comes from the REAL built API (F-05 harness).
// Needs `pnpm build` first. A missing build is a failure, never a skip.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  computeReleaseNumber,
  formatClientRelease,
  resolveMinClientRelease,
} from '../lib/release-number.mjs';
import { repoWithCommits } from './helpers.mjs';

const harnessPath = resolve(import.meta.dirname, '../../../apps/api/dist/test/platform/harness.js');
assert.ok(
  existsSync(harnessPath),
  `built API harness not found at ${harnessPath}: run pnpm build first`,
);
const { start, cfg } = await import(pathToFileURL(harnessPath).href);

const { dir, shas } = repoWithCommits(5);
const rel = (i) => computeReleaseNumber(shas[i], dir); // release numbers 1..5
const header = (i) => formatClientRelease(rel(i).releaseNumber, rel(i).gitSha);

describe('client release refusal path, producer to API', () => {
  let app;
  const get = (path, headers = {}) => fetch(app.base + path, { headers });
  before(async () => {
    // Release 5 is being deployed; release 3 is the previous RELEASED manifest (4 was built but never released).
    const min = resolveMinClientRelease({
      ownReleaseNumber: rel(4).releaseNumber,
      previousReleasedNumber: rel(2).releaseNumber,
    });
    assert.equal(min, 3);
    app = await start({ config: cfg({ minClientRelease: min }) });
  });
  after(() => app.close());

  test('the current build, the previous released build and an unreleased one in between are accepted', async () => {
    for (const i of [4, 3, 2])
      assert.equal(
        (await get('/api/v1/ping', { 'x-client-release': header(i) })).status,
        200,
        header(i),
      );
  });
  for (const [label, headers] of [
    ['older than min_client_release', () => ({ 'x-client-release': header(1) })],
    ['much older', () => ({ 'x-client-release': header(0) })],
    ['missing', () => ({})],
    [
      'malformed (no r prefix)',
      () => ({ 'x-client-release': `${rel(4).releaseNumber}.${rel(4).gitSha12}` }),
    ],
    ['malformed (short sha)', () => ({ 'x-client-release': `r${rel(4).releaseNumber}.abc` })],
  ]) {
    test(`refused: ${label} -> 400 kernel.client_release_unsupported, no cookie`, async () => {
      const r = await get('/api/v1/ping', headers());
      assert.equal(r.status, 400);
      assert.equal(r.headers.get('set-cookie'), null);
      assert.equal((await r.json()).code, 'kernel.client_release_unsupported');
    });
  }
  test('the stream takes the same value as a query parameter and refuses an old one before any event', async () => {
    const r = await get(`/api/v1/alerts/stream?clientRelease=${header(0)}`);
    assert.equal(r.status, 400);
    assert.equal((await r.json()).code, 'kernel.client_release_unsupported');
  });
  test('exempt routes work without the header', async () => {
    assert.equal((await get('/healthz')).status, 200);
  });
  test('first release: min_client_release equals its own number, so the previous number is refused', async () => {
    const first = await start({
      config: cfg({
        minClientRelease: resolveMinClientRelease({ ownReleaseNumber: rel(4).releaseNumber }),
      }),
    });
    try {
      assert.equal(
        (await fetch(first.base + '/api/v1/ping', { headers: { 'x-client-release': header(4) } }))
          .status,
        200,
      );
      assert.equal(
        (await fetch(first.base + '/api/v1/ping', { headers: { 'x-client-release': header(3) } }))
          .status,
        400,
      );
    } finally {
      await first.close();
    }
  });
});
