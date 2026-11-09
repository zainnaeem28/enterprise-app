// In-process stand-in for the log-archive bucket (versioning on, `If-None-Match: *`, Object Lock: no delete or overwrite). Used by the
// unit and database tests; no AWS is reachable from CI (INT04-F10 design 3.8). Real-bucket behaviour is verified by DevOps in staging.
import { createHash } from 'node:crypto';
import type { AnchorArchiveStore, ArchiveVersion, PutResult } from './archive.js';

export class MemoryAnchorArchive implements AnchorArchiveStore {
  readonly objects = new Map<string, { versionId: string; lastModified: string; body: Buffer }[]>();
  /** Rejects the next N calls of any method (object store down). */
  failNext = 0;
  puts = 0;
  private clock = Date.parse('2026-01-01T00:00:00Z');
  private seq = 0;

  private guard(): void {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('object store down');
    }
  }
  private append(key: string, body: Buffer): string {
    const versionId = `v${++this.seq}`;
    this.clock += 1000;
    const list = this.objects.get(key) ?? [];
    list.push({ versionId, lastModified: new Date(this.clock).toISOString(), body });
    this.objects.set(key, list);
    return versionId;
  }

  putAnchor(key: string, body: Buffer, sha256: Buffer): Promise<PutResult> {
    try {
      this.guard();
    } catch (e) {
      return Promise.reject(e as Error);
    }
    if (!createHash('sha256').update(body).digest().equals(sha256))
      return Promise.reject(new Error('BadDigest'));
    this.puts++;
    if (this.objects.has(key)) return Promise.resolve({ outcome: 'exists' });
    return Promise.resolve({ outcome: 'created', versionId: this.append(key, body) });
  }

  async *listVersions(prefix: string): AsyncIterable<ArchiveVersion> {
    this.guard();
    // Like S3: keys in order, newest version first within a key.
    for (const key of [...this.objects.keys()].sort()) {
      if (!key.startsWith(prefix)) continue;
      for (const v of [...(this.objects.get(key) ?? [])].reverse())
        yield { key, versionId: v.versionId, lastModified: v.lastModified };
    }
  }

  getVersion(key: string, versionId: string): Promise<Buffer> {
    try {
      this.guard();
    } catch (e) {
      return Promise.reject(e as Error);
    }
    const v = this.objects.get(key)?.find((x) => x.versionId === versionId);
    return v === undefined ? Promise.reject(new Error('NoSuchVersion')) : Promise.resolve(v.body);
  }

  clone(): MemoryAnchorArchive {
    const c = new MemoryAnchorArchive();
    for (const [k, v] of this.objects) c.objects.set(k, [...v]);
    c.seq = this.seq + 1000;
    c.clock = this.clock + 60_000;
    return c;
  }
  /** Test hook: what a second writer with different bytes would do if Object Lock allowed it (a new version of an existing key). */
  forceVersion(key: string, body: Buffer): string {
    return this.append(key, body);
  }
  /** Test hook: an object that exists before the worker runs (crash between put and insert, or a forged object). */
  seed(key: string, body: Buffer): string {
    return this.append(key, body);
  }
}
