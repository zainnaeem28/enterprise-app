// Test and development stand-ins for the object store, the scanner and the OCR vendor. NOT proof of any real service: an EICAR-style
// string recognised by this stub shows that the job reacts to an "infected" verdict, not that a real scanner would produce one
// (TICKETS BE-10: the real scan result tag and timing are Unverified until staging, C-01, C-10).
import type { Bucket, ScanCaller, ScanState, StoredObject, WorkerObjectStore } from './ports.js';
import { OcrProviderError } from './adapters.js';
import type { OcrProviderClient, ScanTagClient } from './adapters.js';

/** The standard, harmless antivirus test string (EICAR). */
export const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

export class InMemoryObjectStore implements WorkerObjectStore {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();
  failRemove = false;
  private id = (b: Bucket, k: string): string => `${b}/${k}`;

  /** What the browser's upload did: the object appears in quarantine. */
  upload(key: string, body: Buffer, contentType: string): void {
    this.objects.set(this.id('quarantine', key), { body, contentType });
  }
  has(b: Bucket, k: string): boolean {
    return this.objects.has(this.id(b, k));
  }
  head(b: Bucket, k: string): Promise<StoredObject | null> {
    const o = this.objects.get(this.id(b, k));
    return Promise.resolve(
      o === undefined ? null : { sizeBytes: o.body.length, contentType: o.contentType },
    );
  }
  read(b: Bucket, k: string, maxBytes: number): Promise<Buffer> {
    const o = this.objects.get(this.id(b, k));
    if (o === undefined) return Promise.reject(new Error('no such object'));
    if (o.body.length > maxBytes) return Promise.reject(new Error('object too large'));
    return Promise.resolve(Buffer.from(o.body));
  }
  put(b: Bucket, k: string, body: Buffer, contentType: string): Promise<void> {
    this.objects.set(this.id(b, k), { body: Buffer.from(body), contentType });
    return Promise.resolve();
  }
  remove(b: Bucket, k: string): Promise<void> {
    if (this.failRemove) return Promise.reject(new Error('store down'));
    this.objects.delete(this.id(b, k));
    return Promise.resolve();
  }
}

/** A scanner whose verdict the test controls: `release(key)` finishes the scan (infected when the bytes contain EICAR); `outage` throws. */
export class StubScanner {
  outage = false;
  private readonly released = new Set<string>();
  constructor(private readonly store: InMemoryObjectStore) {}
  release(key: string): void {
    this.released.add(key);
  }
  releaseAll(): void {
    for (const k of this.store.objects.keys())
      if (k.startsWith('quarantine/')) this.released.add(k.slice('quarantine/'.length));
  }
  readonly scan: ScanCaller = async (b, k) => {
    if (this.outage) throw new Error('scanner down');
    if (!this.released.has(k)) return 'pending';
    const o = await this.store.read(b, k, Number.MAX_SAFE_INTEGER);
    return o.includes(Buffer.from('EICAR-STANDARD-ANTIVIRUS-TEST-FILE')) ? 'infected' : 'clean';
  };
}

/** A tag client for the TagScannerAdapter: the tag value per key is set by the test (as the real service would set it on the object). */
export class StubTagClient implements ScanTagClient {
  readonly tags = new Map<string, string>();
  outage = false;
  readScanTag(req: { bucket: Bucket; key: string }): Promise<{ value: string | null }> {
    if (this.outage) return Promise.reject(new Error('down'));
    return Promise.resolve({ value: this.tags.get(`${req.bucket}/${req.key}`) ?? null });
  }
  health(): Promise<{ ok: boolean }> {
    return Promise.resolve({ ok: !this.outage });
  }
}

export class StubOcrProvider implements OcrProviderClient {
  calls = 0;
  plan: (n: number) => { documentType: string | null } | OcrProviderError = () => ({
    documentType: 'insurance_card',
  });
  classify(): Promise<{ documentType: string | null; vendorRef?: string }> {
    const r = this.plan(++this.calls);
    return r instanceof OcrProviderError
      ? Promise.reject(r)
      : Promise.resolve({ ...r, vendorRef: `ocr-${this.calls}` });
  }
  health(): Promise<{ ok: boolean }> {
    return Promise.resolve({ ok: true });
  }
}

export type { ScanState };
