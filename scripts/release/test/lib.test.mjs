import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { listing, listingHash } from '../lib/hash.mjs';
import {
  computeReleaseNumber,
  decideAgainstStore,
  formatClientRelease,
  parseClientRelease,
  resolveMinClientRelease,
} from '../lib/release-number.mjs';
import { numberKey, parseKeys } from '../lib/store.mjs';
import { repoWithCommits } from './helpers.mjs';

describe('release number', () => {
  test('is the first-parent count and r<n>.<sha12> round-trips', () => {
    const { dir, shas } = repoWithCommits(3);
    const r = computeReleaseNumber(shas[2], dir);
    assert.equal(r.releaseNumber, 3);
    assert.equal(computeReleaseNumber(shas[0], dir).releaseNumber, 1);
    const cr = formatClientRelease(3, shas[2]);
    assert.match(cr, /^r3\.[0-9a-f]{12}$/);
    assert.deepEqual(parseClientRelease(cr), { releaseNumber: 3, gitSha12: shas[2].slice(0, 12) });
  });
  test('a merge counts once along the first parent', () => {
    const { dir, git } = repoWithCommits(2);
    git('checkout', '-q', '-b', 'side');
    for (const f of ['a', 'b', 'c']) {
      writeFileSync(join(dir, f), f);
      git('add', '.');
      git('commit', '-q', '-m', f);
    }
    git('checkout', '-q', 'main');
    git('merge', '-q', '--no-ff', '-m', 'merge', 'side');
    assert.equal(computeReleaseNumber(git('rev-parse', 'HEAD'), dir).releaseNumber, 3); // 2 commits + the merge
  });
  test('a shallow clone and a malformed sha are refused', () => {
    const { dir, shas } = repoWithCommits(3);
    const clone = mkdtempSync(join(tmpdir(), 'rel-shallow-'));
    execFileSyncQuiet('git', ['clone', '-q', '--depth', '1', `file://${dir}`, clone]);
    assert.throws(() => computeReleaseNumber(shas[2], clone), /shallow/);
    assert.throws(() => computeReleaseNumber('abc', dir), /40 lowercase hex/);
  });
  test('malformed client releases do not parse', () => {
    for (const v of [
      '142.3f9a1c2b7d10',
      'r0.3f9a1c2b7d10',
      'r1.abc',
      'r1.3F9A1C2B7D10',
      'r01.3f9a1c2b7d10',
      'r1.3f9a1c2b7d10;x',
      undefined,
    ]) {
      assert.equal(parseClientRelease(v), undefined, String(v));
    }
  });
});

describe('store decision (release_number check)', () => {
  const sha = (c) => c.repeat(40);
  test('greater than every other manifest publishes', () => {
    assert.deepEqual(decideAgainstStore(5, sha('a'), [{ releaseNumber: 4, gitSha: sha('b') }]), {
      action: 'publish',
    });
    assert.deepEqual(decideAgainstStore(1, sha('a'), []), { action: 'publish' });
  });
  test('an older build finishing late fails by design with code release_number', () => {
    assert.throws(
      () => decideAgainstStore(4, sha('a'), [{ releaseNumber: 5, gitSha: sha('b') }]),
      (e) => e.code === 'release_number' && /refused by design/.test(e.message),
    );
  });
  test('an equal number from another commit fails', () => {
    assert.throws(
      () => decideAgainstStore(5, sha('a'), [{ releaseNumber: 5, gitSha: sha('b') }]),
      (e) => e.code === 'release_number',
    );
  });
  test('a re-run of a stored commit is idempotent: reuse, even when newer manifests exist', () => {
    assert.deepEqual(
      decideAgainstStore(4, sha('a'), [
        { releaseNumber: 4, gitSha: sha('a') },
        { releaseNumber: 9, gitSha: sha('c') },
      ]),
      { action: 'reuse', releaseNumber: 4 },
    );
  });
  test('store keys encode number and sha; a foreign object in the index is an error', () => {
    const k = numberKey(42, sha('a'));
    assert.equal(k, `manifests/by-number/0000000042-${sha('a')}.json`);
    assert.deepEqual(parseKeys([k]), [{ releaseNumber: 42, gitSha: sha('a') }]);
    assert.throws(() => parseKeys(['manifests/by-number/x.json']), /unexpected object/);
  });
});

describe('min_client_release (DEVOPS-PLAN 6.2, 15.3)', () => {
  test('is the previous released number, not the previous commit', () => {
    assert.equal(resolveMinClientRelease({ ownReleaseNumber: 20, previousReleasedNumber: 17 }), 17);
  });
  test('first release equals its own number', () => {
    assert.equal(resolveMinClientRelease({ ownReleaseNumber: 20 }), 20);
  });
  test('a hand-edited value above or below is refused', () => {
    assert.throws(
      () =>
        resolveMinClientRelease({ ownReleaseNumber: 20, previousReleasedNumber: 17, override: 18 }),
      /refused/,
    );
    assert.throws(
      () =>
        resolveMinClientRelease({ ownReleaseNumber: 20, previousReleasedNumber: 17, override: 16 }),
      /refused/,
    );
    assert.throws(() => resolveMinClientRelease({ ownReleaseNumber: 20, override: 19 }), /refused/);
    assert.equal(
      resolveMinClientRelease({ ownReleaseNumber: 20, previousReleasedNumber: 17, override: 17 }),
      17,
    );
  });
  test('a previous number that is not below the own number is refused', () => {
    assert.throws(
      () => resolveMinClientRelease({ ownReleaseNumber: 20, previousReleasedNumber: 20 }),
      /below/,
    );
  });
});

describe('listing hash', () => {
  test('is independent of creation order and changes with content', () => {
    const mk = (order) => {
      const d = mkdtempSync(join(tmpdir(), 'lst-'));
      mkdirSync(join(d, 'assets'));
      for (const [p, c] of order) writeFileSync(join(d, p), c);
      return d;
    };
    const a = mk([
      ['index.html', 'x'],
      ['assets/a.js', 'y'],
    ]);
    const b = mk([
      ['assets/a.js', 'y'],
      ['index.html', 'x'],
    ]);
    const c = mk([
      ['assets/a.js', 'Y'],
      ['index.html', 'x'],
    ]);
    assert.equal(listingHash(listing(a)), listingHash(listing(b)));
    assert.notEqual(listingHash(listing(a)), listingHash(listing(c)));
  });
});

import { execFileSync } from 'node:child_process';
function execFileSyncQuiet(cmd, args) {
  execFileSync(cmd, args, { stdio: 'ignore' });
}
