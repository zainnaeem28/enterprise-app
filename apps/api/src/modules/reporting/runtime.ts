// Wiring of the reporting module: one call builds the controllers from explicit dependencies. Nothing here reads the environment.
// Composition at start-up:
//   1. define REPORTING_JOBS in the API's and the worker's JobRegistry (and sync queue task types);
//   2. API: createReporting({ db }) and register `controllers`;
//   3. worker: handler of `reporting.refresh_ops` -> runRefreshOps({ db, staleMinutes }, orgId); add REPORTING_CRONTAB to the crontab.
import type { KernelDb } from '@ehr/kernel';
import type { Type } from '@nestjs/common';
import { createReportingControllers } from './controller.js';

export interface ReportingDeps {
  db: KernelDb;
}

export interface Reporting {
  controllers: Type<unknown>[];
}

export function createReporting(deps: ReportingDeps): Reporting {
  return { controllers: createReportingControllers({ db: deps.db }) };
}
