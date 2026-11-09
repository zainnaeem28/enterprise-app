#!/usr/bin/env node
// Append one image record to the images file the manifest is assembled from.
// Usage: record-image.mjs --file images.json --name api --digest sha256:.. [--reference repo@sha256:..] [--tag t]
//        [--sbom path] [--sbom-sha256 h] [--signed true|false] [--published true|false]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values: v } = parseArgs({
  options: {
    file: { type: 'string' },
    name: { type: 'string' },
    digest: { type: 'string' },
    reference: { type: 'string' },
    tag: { type: 'string' },
    sbom: { type: 'string' },
    'sbom-sha256': { type: 'string' },
    signed: { type: 'string', default: 'false' },
    published: { type: 'string', default: 'false' },
    attestations: { type: 'string', default: '' },
  },
});
if (!v.file || !v.name || !/^sha256:[0-9a-f]{64}$/.test(v.digest ?? '')) {
  console.error('usage: record-image.mjs --file f --name n --digest sha256:<64 hex> ...');
  process.exit(2);
}
const all = existsSync(v.file) ? JSON.parse(readFileSync(v.file, 'utf8')) : {};
all[v.name] = {
  digest: v.digest,
  reference: v.reference ?? null,
  tag: v.tag ?? null,
  published: v.published === 'true',
  signed: v.signed === 'true',
  attestations: v.attestations ? v.attestations.split(',') : [],
  sbom: v.sbom ? { file: v.sbom, sha256: v['sbom-sha256'] } : null,
};
writeFileSync(v.file, JSON.stringify(all, null, 2) + '\n');
