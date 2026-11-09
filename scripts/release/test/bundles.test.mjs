// build-bundles.mjs against throwaway apps/staff/dist and apps/patient/dist (--no-build): the embedded release must really be in the JS of every bundle.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';

const root = resolve(import.meta.dirname, '../../..');
const dists = ['staff', 'patient'].map((n) => join(root, `apps/${n}/dist`));
const sha = '3f9a1c2b7d10' + 'e'.repeat(28);
const run = (out, n = '142') =>
  spawnSync(
    'node',
    [
      join(root, 'scripts/release/build-bundles.mjs'),
      '--out',
      out,
      '--release-number',
      n,
      '--sha',
      sha,
      '--no-build',
      '--built-at',
      '2026-11-09T00:00:00Z',
    ],
    { encoding: 'utf8' },
  );
const clean = () => dists.forEach((d) => rmSync(d, { recursive: true, force: true }));
const seed = (js, only = dists) => {
  clean();
  for (const dist of only) {
    mkdirSync(join(dist, 'assets'), { recursive: true });
    writeFileSync(join(dist, 'index.html'), '<html></html>');
    writeFileSync(join(dist, 'assets/index-abc.js'), js);
  }
};
afterEach(clean);

describe('build-bundles', () => {
  test('embeds r<n>.<sha12>, writes release.json, hashes the listing, for both required bundles', () => {
    seed('const r="r142.3f9a1c2b7d10";export{r}');
    const out = mkdtempSync(join(tmpdir(), 'bun-'));
    const r = run(out);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const rel = JSON.parse(readFileSync(join(out, 'bundles/staff/release.json'), 'utf8'));
    assert.deepEqual(Object.keys(rel).sort(), ['built_at', 'git_sha12', 'release_number']);
    assert.equal(rel.release_number, 142);
    assert.equal(rel.git_sha12, '3f9a1c2b7d10');
    const s = JSON.parse(readFileSync(join(out, 'bundles.json'), 'utf8'));
    assert.equal(s.staff.status, 'built');
    assert.equal(s.staff.client_release, 'r142.3f9a1c2b7d10');
    assert.match(s.staff.listing_sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(s.staff.embedded_in, ['assets/index-abc.js']);
    assert.equal(s.patient.status, 'built');
    assert.equal(s.patient.client_release, 'r142.3f9a1c2b7d10');
    assert.deepEqual(s.patient.embedded_in, ['assets/index-abc.js']);
    assert.match(s.patient.listing_sha256, /^[0-9a-f]{64}$/);
    const prel = JSON.parse(readFileSync(join(out, 'bundles/patient/release.json'), 'utf8'));
    assert.equal(prel.release_number, 142);
    // determinism: the same inputs give the same listing hash
    const out2 = mkdtempSync(join(tmpdir(), 'bun-'));
    run(out2);
    assert.equal(
      JSON.parse(readFileSync(join(out2, 'bundles.json'), 'utf8')).staff.listing_sha256,
      s.staff.listing_sha256,
    );
  });
  test('fails when the release is not in any shipped .js file', () => {
    seed('const r="r1.000000000000";export{r}');
    const out = mkdtempSync(join(tmpdir(), 'bun-'));
    const r = run(out);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not embedded/);
    assert.ok(!existsSync(join(out, 'bundles.json')));
  });
  test('fails when only one bundle lacks the release (patient not embedded)', () => {
    seed('const r="r142.3f9a1c2b7d10";export{r}', [dists[0]]);
    mkdirSync(join(dists[1], 'assets'), { recursive: true });
    writeFileSync(join(dists[1], 'index.html'), '<html></html>');
    writeFileSync(join(dists[1], 'assets/index-abc.js'), 'const r="r1.000000000000"');
    const out = mkdtempSync(join(tmpdir(), 'bun-'));
    const r = run(out);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /bundle patient.*not embedded/);
  });
  test('fails when a required bundle was not produced', () => {
    clean();
    const r = run(mkdtempSync(join(tmpdir(), 'bun-')));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /was not produced/);
  });
});
