// Release store layout (S3 bucket in the tooling account, versioned, Object Lock governance; DEVOPS-PLAN 6.1).
//   manifests/by-number/<10-digit number>-<git_sha>.json   the commit point of a release (written last, never overwritten)
//   releases/<git_sha>/release-manifest.json (+ .sha256)   the manifest next to the bundles
//   releases/<git_sha>/bundles/<portal>/...                the portal bundles (entry document, assets, release.json)
// The number and sha are encoded in the key so "every other manifest" can be listed with s3:ListBucket alone.
export const numberKey = (n, sha) =>
  `manifests/by-number/${String(n).padStart(10, '0')}-${sha}.json`;
export const shaKey = (sha) => `releases/${sha}/release-manifest.json`;
export const bundlePrefix = (sha, portal) => `releases/${sha}/bundles/${portal}/`;

const KEY_RE = /^manifests\/by-number\/(\d{10})-([0-9a-f]{40})\.json$/;
/** Keys under manifests/by-number/ -> [{ releaseNumber, gitSha }]. A key that does not parse is an error, not ignored. */
export function parseKeys(keys) {
  return keys.map((k) => {
    const m = KEY_RE.exec(k);
    if (!m) throw new Error(`unexpected object in the manifest index: ${k}`);
    return { releaseNumber: Number(m[1]), gitSha: m[2] };
  });
}
