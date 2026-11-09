#!/usr/bin/env node
// Inputs of the manifest that come from the repository itself: migrations, lockfiles, base-image digests, tool versions.
// Usage: inventory.mjs --out <file>
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { sha256, sha256File } from './lib/hash.mjs';

const root = resolve(import.meta.dirname, '../..');
const cfg = JSON.parse(readFileSync(join(root, 'scripts/release/release.config.json'), 'utf8'));

export function migrations(dir) {
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => /^\d{4}_.+\.sql$/.test(f))
        .sort()
    : [];
  const list = files.map((f) => ({ name: f, sha256: sha256File(join(dir, f)) }));
  return {
    files: list,
    combined_sha256: sha256(list.map((m) => `${m.sha256}  ${m.name}\n`).join('')),
  };
}

export function baseImages(images) {
  const found = {};
  for (const i of images) {
    const p = join(root, i.dockerfile);
    if (!existsSync(p)) continue;
    for (const m of readFileSync(p, 'utf8').matchAll(
      /^(?:ARG\s+\w+=|FROM\s+)(\S+@sha256:[0-9a-f]{64})/gm,
    ))
      found[m[1]] = true;
    const unpinned = [...readFileSync(p, 'utf8').matchAll(/^FROM\s+(?!\$\{)(\S+)/gm)]
      .map((m) => m[1])
      .filter((r) => !r.includes('@sha256:') && r !== 'scratch');
    const stages = [...readFileSync(p, 'utf8').matchAll(/^FROM\s+\S+\s+AS\s+(\S+)/gim)].map(
      (m) => m[1],
    );
    const bad = unpinned.filter((r) => !stages.includes(r));
    if (bad.length)
      throw new Error(`${i.dockerfile}: base image(s) not pinned by digest: ${bad.join(', ')}`);
  }
  return Object.keys(found).sort();
}

const tool = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8' }).split('\n')[0].trim();
  } catch {
    return 'unavailable';
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { out: { type: 'string' } } });
  if (!values.out) {
    console.error('usage: inventory.mjs --out <file>');
    process.exit(2);
  }
  const locks = Object.fromEntries(cfg.lockfiles.map((f) => [f, sha256File(join(root, f))]));
  const bases = baseImages(cfg.images);
  const inv = {
    migrations: migrations(join(root, cfg.migrationsDir)),
    locks: {
      files: locks,
      base_images: bases,
      base_images_sha256: sha256(bases.join('\n') + '\n'),
      lockfile_sha256: locks['pnpm-lock.yaml'],
    },
    tools: {
      node: process.version,
      pnpm: tool('pnpm', ['--version']),
      docker: tool('docker', ['--version']),
      syft: tool('syft', ['--version']),
      trivy: tool('trivy', ['--version']),
      cosign: tool('cosign', ['version']),
      aws_cli: tool('aws', ['--version']),
    },
  };
  writeFileSync(resolve(values.out), JSON.stringify(inv, null, 2) + '\n');
  console.log(
    `inventory: ${inv.migrations.files.length} migrations, ${Object.keys(locks).length} lockfiles, ${bases.length} base image digest(s)`,
  );
}
