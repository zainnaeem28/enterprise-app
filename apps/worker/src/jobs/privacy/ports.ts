// What the privacy jobs need (ARCHITECTURE 25.10, 33.1). The package store's real adapter (S3 with the KMS key) is delivered at staging
// with the bucket, which does not exist yet (C-01): nothing here proves the real store.
import type { KernelDb, Logger, Queue, Tx } from '@ehr/kernel';
import type { DeletionStatement } from './statement.js';

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

/**
 * The retention settings and date rules, from the API's one config module (`apps/api/src/modules/privacy/retention.ts`; the worker does
 * not import the API at build time, so the composition hands this in). Dates are UTC calendar dates `YYYY-MM-DD`.
 */
export interface RetentionPolicyPort {
  /** The last day the medical record must be kept (adult, or the minors rule). */
  medicalRecordRetainedUntil(basis: {
    lastEncounterDate: string | null;
    registeredDate: string;
    birthDate: string | null;
  }): string;
  /** Privacy documentation finished on or before this date has passed its HIPAA period (`today` minus the period). */
  hipaaDocumentationCutoff(today: string): string;
  /** A privacy export package created on or before this instant is past its life (`now` minus the period). */
  exportPackageCutoff(now: Date): Date;
  /** Audit rows and anchors dated on or before this date have passed their retention in the archive (reporting only). */
  auditCutoff(today: string): string;
  readonly years: { auditTrail: number; auditAnchor: number; hipaaDocumentation: number };
}

/**
 * Sends the deletion statement to the patient (e-mail). The adapter resolves the address itself (the address is never stored on the
 * job or the record) and must be idempotent for one `recordId`. The e-mail provider does not exist yet (C-11), so the composition
 * supplies a refusing port: the job retries until one is configured. Nothing here claims a message left the building.
 */
export interface DeletionStatementSender {
  send(input: {
    recordId: string;
    requestId: string;
    patientId: string;
    subject: string;
    text: string;
    statement: DeletionStatement;
  }): Promise<void>;
}

/** What the deletion and retention jobs need beyond the existing privacy jobs. */
export interface RetentionJobDeps extends PrivacyJobDeps {
  /** The worker-path queue: the deletion job enqueues the statement job in its own transaction. */
  queue: Queue;
  retention: RetentionPolicyPort;
  statements: DeletionStatementSender;
}
