#!/usr/bin/env node
// Writes the deterministic synthetic data set as JSON (no secrets, no real data).
//   generate.mjs <out-dir> [--seed S] [--volume VOL-1|VOL-2|VOL-3] [--volume-limit N]
// Output: accounts.json, organisations.json, services.json, patients.json, seeds.json, manifest.json (sha256 of each).
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ACCOUNTS } from './accounts.mjs';
import {
  DEFAULT_SEED,
  doctorTemplate,
  namedPatients,
  organisations,
  seeds,
  services,
  volumePatients,
} from './generators.mjs';
import { scanJson } from './identifier-scan.mjs';

export function buildDataset({ seed = DEFAULT_SEED } = {}) {
  return {
    'accounts.json': ACCOUNTS,
    'organisations.json': organisations(seed),
    'services.json': { services: services(seed), doctorTemplate: doctorTemplate(seed) },
    'patients.json': namedPatients(seed),
    'seeds.json': seeds(seed),
  };
}

function main(argv) {
  const args = [...argv];
  const out = args.shift();
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (!out || out.startsWith('--')) {
    console.error('usage: generate.mjs <out-dir> [--seed S] [--volume VOL-n] [--volume-limit N]');
    process.exit(2);
  }
  const seed = opt('--seed') ?? DEFAULT_SEED;
  const files = buildDataset({ seed });
  const volume = opt('--volume');
  if (volume) {
    const limit = opt('--volume-limit') ? Number(opt('--volume-limit')) : undefined;
    files[`${volume.toLowerCase()}.json`] = [...volumePatients(volume, { seed, limit })];
  }
  mkdirSync(out, { recursive: true });
  const manifest = { seed, files: {} };
  for (const [name, value] of Object.entries(files)) {
    const findings = scanJson(value);
    if (findings.length) {
      console.error(
        `::error::${name}: ${findings.length} real-identifier-looking value(s): ${JSON.stringify(findings.slice(0, 3))}`,
      );
      process.exit(1);
    }
    const text = `${JSON.stringify(value, null, 2)}\n`;
    writeFileSync(join(out, name), text);
    manifest.files[name] = createHash('sha256').update(text).digest('hex');
  }
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${Object.keys(files).length} file(s) to ${out} (seed ${seed})`);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
