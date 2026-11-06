// What the worker needs from the object store (ARCHITECTURE 25.10): to look at, read, write and remove objects by bucket and key.
// The API has no such access (it only presigns). The real adapter (S3 with the KMS key and the two buckets) is delivered at staging:
// the buckets, the key and the malware-scan service do not exist yet (C-01, C-10), so nothing here proves the real store.
import type { Logger } from '@ehr/kernel';

export type Bucket = 'quarantine' | 'clean';

export interface StoredObject {
  sizeBytes: number;
  contentType: string | null;
}

export interface WorkerObjectStore {
  /** null when there is no such object (the browser has not uploaded yet, or never will). */
  head(bucket: Bucket, key: string): Promise<StoredObject | null>;
  /** The object's bytes; refuses an object larger than `maxBytes` (never reads more than that). */
  read(bucket: Bucket, key: string, maxBytes: number): Promise<Buffer>;
  put(bucket: Bucket, key: string, body: Buffer, contentType: string): Promise<void>;
  /** Idempotent: removing a missing object is not an error. */
  remove(bucket: Bucket, key: string): Promise<void>;
}

export type ScanState = 'pending' | 'clean' | 'infected' | 'error';

/**
 * Reads the malware scan's verdict for one object. Built from a {@link ScannerAdapter}; throws when the scanner cannot be asked
 * (an outage): the job treats that as `error`, never as `clean` (TC-DOC-08).
 */
export type ScanCaller = (bucket: Bucket, key: string) => Promise<ScanState>;

/** The operations alert hook (33.1, BR-33): IDs and a reason class only. */
export interface OpsAlert {
  kind: 'scan_error' | 'scan_timeout' | 'quarantined' | 'rejected_file' | 'ocr_failed';
  documentId: string;
  version: number;
  patientId: string;
}

export interface DocumentsJobDeps {
  db: import('@ehr/kernel').KernelDb;
  orgId: string;
  /** Worker-path queue (`new Queue(registry, 'worker')`). */
  queue: import('@ehr/kernel').Queue;
  store: WorkerObjectStore;
  scan: ScanCaller;
  reencode: ImageReencoder;
  log: Logger;
  /** `patient`'s answer to "who is the survivor of this ID". Without it a merged ID is never followed. */
  survivorOf?: (patientId: string) => Promise<string | undefined>;
  alert?: (a: OpsAlert) => void;
  now?: () => Date;
  /** Clock rules of 25.10: poll every 10 s for the first minute, then every 60 s, for 30 minutes; then alert and retry every 5 minutes. */
  schedule?: {
    fastMs: number;
    fastWindowMs: number;
    slowMs: number;
    timeoutMs: number;
    afterTimeoutMs: number;
    giveUpMs: number;
  };
}

/** Removes what is not pixels (EXIF, comments, text chunks) from an image's container; throws {@link InvalidFile} on a broken one. */
export interface ImageReencoder {
  reencode(type: string, bytes: Buffer): Buffer;
}

export class InvalidFile extends Error {
  constructor() {
    super('invalid_file');
    this.name = 'InvalidFile';
  }
}

export const DEFAULT_SCHEDULE = {
  fastMs: 10_000,
  fastWindowMs: 60_000,
  slowMs: 60_000,
  timeoutMs: 30 * 60_000,
  afterTimeoutMs: 5 * 60_000,
  giveUpMs: 24 * 60 * 60_000,
} as const;
