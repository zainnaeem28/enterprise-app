// Fails when the CycloneDX SBOM is unreadable, has no components, or has no npm packages (the
// lockfile-resolved dependency inventory is the point of this SBOM).
import { readFileSync } from 'node:fs';

const [path] = process.argv.slice(2);
if (!path) {
  console.error('usage: check-sbom.mjs <sbom.cdx.json>');
  process.exit(2);
}
let sbom;
try {
  sbom = JSON.parse(readFileSync(path, 'utf8'));
} catch (e) {
  console.error(`::error::unreadable SBOM ${path}: ${e.message}`);
  process.exit(1);
}
const n = sbom.components?.length ?? 0;
const npm = (sbom.components ?? []).filter((c) =>
  String(c.purl ?? '').startsWith('pkg:npm/'),
).length;
if (sbom.bomFormat !== 'CycloneDX' || n === 0 || npm === 0) {
  console.error(
    `::error::SBOM is not a CycloneDX document with components (format=${sbom.bomFormat}, components=${n}, npm=${npm})`,
  );
  process.exit(1);
}
console.log(`sbom: CycloneDX ${sbom.specVersion}, ${n} components (${npm} npm)`);
