// What a deploy accepts as "the release manifest" (DEVOPS-PLAN 6.1, 6.2, 15.3).
import { sha256 } from '../../release/lib/hash.mjs';
import { validate } from '../../release/lib/manifest.mjs';

/**
 * @param {Buffer} bytes the exact bytes of release-manifest.json as stored by build-release
 * @param {string} expectedHash 64 hex the dispatcher supplied
 * @returns {{errors:string[], manifest?:object, hash:string}}
 */
export function checkManifestBytes(bytes, expectedHash) {
  const hash = sha256(bytes);
  const errors = [];
  if (hash !== expectedHash)
    errors.push(`manifest bytes hash to ${hash}, not the supplied ${expectedHash}`);
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { errors: [...errors, 'manifest is not valid JSON'], hash };
  }
  errors.push(...validate(manifest));
  if (manifest.mode !== 'publish')
    errors.push(`manifest mode is "${manifest.mode}": only a published manifest can be deployed`);
  for (const name of manifest.required?.images ?? []) {
    const i = manifest.images?.[name];
    if (
      i &&
      !(
        i.signed === true &&
        (i.attestations ?? []).includes('sbom') &&
        (i.attestations ?? []).includes('provenance')
      )
    )
      errors.push(`image ${name}: signature, SBOM or provenance missing (15.3)`);
    if (i && !/@sha256:[0-9a-f]{64}$/.test(String(i.reference)))
      errors.push(`image ${name}: reference is not by digest`);
  }
  return { errors, manifest, hash };
}

/** `repo@sha256:...` references of the required images, by name. */
export function imageRefs(manifest) {
  return Object.fromEntries(
    (manifest.required?.images ?? []).map((n) => [n, manifest.images[n].reference]),
  );
}
