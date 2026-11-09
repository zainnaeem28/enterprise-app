// Release numbering (DEVOPS-PLAN 6.1, 6.2; ARCHITECTURE 28.6; AL-04).
//   release_number = git rev-list --first-parent --count <git_sha>      (full clone required)
//   client release = r<release_number>.<git_sha12>
// A build is refused when its number is not greater than every OTHER manifest in the store, so an older build that
// finishes after a newer one fails by design. A re-run of a commit that already has a manifest is idempotent.
import { execFileSync } from 'node:child_process';

export const CLIENT_RELEASE_RE = /^r([1-9][0-9]{0,9})\.([0-9a-f]{12})$/;
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

export function computeReleaseNumber(sha, cwd = process.cwd()) {
  if (!/^[0-9a-f]{40}$/.test(sha))
    throw new Error(`git sha must be 40 lowercase hex characters, got "${sha}"`);
  if (git(cwd, 'rev-parse', '--is-shallow-repository') !== 'false') {
    throw new Error(
      'release_number needs a full clone (checkout with fetch-depth: 0); this clone is shallow',
    );
  }
  const n = Number(git(cwd, 'rev-list', '--first-parent', '--count', sha));
  if (!Number.isSafeInteger(n) || n < 1)
    throw new Error(`release_number is not a positive integer: ${n}`);
  return {
    releaseNumber: n,
    gitSha: sha,
    gitSha12: sha.slice(0, 12),
    gitTreeHash: git(cwd, 'rev-parse', `${sha}^{tree}`),
  };
}

export const formatClientRelease = (n, sha) => `r${n}.${sha.slice(0, 12)}`;

export function parseClientRelease(value) {
  const m = CLIENT_RELEASE_RE.exec(String(value));
  return m ? { releaseNumber: Number(m[1]), gitSha12: m[2] } : undefined;
}

/**
 * Decide what the store allows. `stored` = [{ releaseNumber, gitSha }] for every manifest already in the store.
 * - same git_sha already stored: { action: 'reuse', releaseNumber } (idempotent re-run, nothing new is published);
 * - number greater than every other manifest: { action: 'publish' };
 * - otherwise throws with code 'release_number' (the by-design failure of an older build that finishes late).
 */
export function decideAgainstStore(releaseNumber, gitSha, stored) {
  const same = stored.find((m) => m.gitSha === gitSha);
  if (same) return { action: 'reuse', releaseNumber: same.releaseNumber };
  const clash = stored.filter((m) => m.releaseNumber >= releaseNumber);
  if (clash.length > 0) {
    const max = Math.max(...clash.map((m) => m.releaseNumber));
    const e = new Error(
      `release_number check failed: this build is number ${releaseNumber} but the store already holds number ${max}. ` +
        'An older build that finishes after a newer one is refused by design (DEVOPS-PLAN 4.2, 6.1); it is not a defect.',
    );
    e.code = 'release_number';
    throw e;
  }
  return { action: 'publish' };
}

/**
 * min_client_release for a deploy (DEVOPS-PLAN 6.2): the release_number of the PREVIOUS RELEASED manifest, never the
 * previous commit. First release (no previous released manifest): its own number. A value above the previous released
 * number would lock out the portal in the field; below it is a hand edit; both are refused (15.3).
 * `override` is what a person/config tried to set, if anything.
 */
export function resolveMinClientRelease({ ownReleaseNumber, previousReleasedNumber, override }) {
  if (!Number.isSafeInteger(ownReleaseNumber) || ownReleaseNumber < 1)
    throw new Error('own release number invalid');
  const first = previousReleasedNumber === undefined || previousReleasedNumber === null;
  if (
    !first &&
    (!Number.isSafeInteger(previousReleasedNumber) ||
      previousReleasedNumber < 1 ||
      previousReleasedNumber >= ownReleaseNumber)
  ) {
    throw new Error(
      `previous released number ${previousReleasedNumber} must be a positive integer below ${ownReleaseNumber}`,
    );
  }
  const expected = first ? ownReleaseNumber : previousReleasedNumber;
  if (override !== undefined && override !== expected) {
    throw new Error(
      `min_client_release ${override} refused: it must equal ${expected} (${first ? 'first release: its own number' : 'previous released number'})`,
    );
  }
  return expected;
}
