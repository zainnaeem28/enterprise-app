// Task handlers of the documents module (ARCHITECTURE 33.1). `createDocumentsTasks` returns a task table for the worker's
// `startWorker({ tasks })`; `defineDocumentsJobs` registers the types with the JobRegistry. DOCUMENTS_CRONTAB is wired at integration
// (the runner does not pass a crontab yet, as for the other modules).
import type { Task } from 'graphile-worker';
import type { JobRegistry } from '@ehr/kernel';
import { runAwaitScan } from './await-scan.js';
import { runOcrSuggest } from './ocr-suggest.js';
import type { OcrDeps } from './ocr-suggest.js';
import { DOCUMENTS_JOBS } from './jobs.js';
import { runRetentionSweep } from './retention-sweep.js';

export { DOCUMENTS_CRONTAB, DOCUMENTS_JOBS } from './jobs.js';
export { runAwaitScan } from './await-scan.js';
export type { ScanOutcome } from './await-scan.js';
export { runOcrSuggest, CLASSIFICATIONS } from './ocr-suggest.js';
export type { OcrDeps, OcrOutcome } from './ocr-suggest.js';
export { runRetentionSweep } from './retention-sweep.js';
export type { SweepResult } from './retention-sweep.js';
export { metadataStrippingReencoder, sniffType } from './sniff.js';
export {
  DEFAULT_TAG_MAPPING,
  OcrAdapter,
  OcrProviderError,
  TagScannerAdapter,
  scannerCaller,
} from './adapters.js';
export type { OcrProviderClient, ScanTagClient, ScannerAdapter, TagMapping } from './adapters.js';
export { DEFAULT_SCHEDULE, InvalidFile } from './ports.js';
export type {
  Bucket,
  DocumentsJobDeps,
  ImageReencoder,
  OpsAlert,
  ScanCaller,
  ScanState,
  StoredObject,
  WorkerObjectStore,
} from './ports.js';

export function defineDocumentsJobs(registry: JobRegistry): void {
  for (const j of DOCUMENTS_JOBS) registry.defineJob(j);
}

export function createDocumentsTasks(deps: OcrDeps): Record<string, Task> {
  return {
    'documents.await_scan': async (payload, helpers) => {
      await runAwaitScan(
        deps,
        payload as Record<string, unknown>,
        `documents.await_scan:${helpers.job.id}`,
      );
    },
    'documents.ocr_suggest': async (payload, helpers) => {
      await runOcrSuggest(deps, payload as Record<string, unknown>, {
        number: helpers.job.attempts,
        max: helpers.job.max_attempts,
      });
    },
    'documents.retention_sweep': async () => {
      await runRetentionSweep(deps);
    },
  };
}
