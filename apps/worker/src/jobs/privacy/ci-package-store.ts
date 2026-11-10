// The privacy package store for the CI environment only (`EHR_ENV=ci`, synthetic data): objects are files in a private directory, so an
// export can finish end to end without the bucket and KMS key that do not exist yet (C-01). `composeWorker` uses it only when the
// environment is `ci` and no real adapter was passed; in dev, staging and production the store stays the refusing port until the S3
// adapter is delivered. It proves nothing about the real store (TC-PR-02b stays blocked).
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { PackageWriter, WorkerPackageStore } from './ports.js';

export class CiPackageStore implements PackageWriter, WorkerPackageStore {
  private readonly root: string;
  constructor(root: string = join(tmpdir(), 'ehr-ci-privacy-packages')) {
    this.root = resolve(root);
  }

  /** The file of an object key; a key that would leave the directory is refused. */
  private pathOf(key: string): string {
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + sep)) throw new Error('package key outside the store');
    return p;
  }

  async put(key: string, body: Buffer): Promise<void> {
    const p = this.pathOf(key);
    await mkdir(resolve(p, '..'), { recursive: true, mode: 0o700 });
    await writeFile(p, body, { mode: 0o600 });
  }

  async remove(key: string): Promise<void> {
    await rm(this.pathOf(key), { force: true });
  }
}
