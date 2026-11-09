// What the privacy jobs need (ARCHITECTURE 25.10, 33.1). The package store's real adapter (S3 with the KMS key) is delivered at staging
// with the bucket, which does not exist yet (C-01): nothing here proves the real store.
import type { KernelDb, Logger, Tx } from '@ehr/kernel';

export interface WorkerPackageStore {
  /** Idempotent: removing a missing object is not an error. */
  remove(key: string): Promise<void>;
}

/** The assembler's write access to the package store (mirrors the API package's `PackageWriterPort`); the object is encrypted at rest by the store. */
export interface PackageWriter {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** The documents module's answer to "how many documents of these patients are under a legal hold now" (BR-29). */
export interface LegalHoldReader {
  documentsUnderHold(tx: Tx, patientIds: readonly string[]): Promise<number>;
}

export interface PrivacyJobDeps {
  /** A pool of the worker role (app_worker). */
  db: KernelDb;
  orgId: string;
  store: WorkerPackageStore;
  holds: LegalHoldReader;
  /** `patient.closure(id)`: the patient and every ID merged into it. */
  closureOf: (tx: Tx, patientId: string) => Promise<string[]>;
  log: Logger;
  now?: () => Date;
}
