// Public surface of the reporting module (ARCHITECTURE 22.15, ticket BE-21). Other modules import only from here.
export { createReporting } from './runtime.js';
export type { Reporting, ReportingDeps } from './runtime.js';
export { createReportingControllers } from './controller.js';
export type { ReportingControllerDeps } from './controller.js';
export { REFRESH_OPS_JOB, REPORTING_CRONTAB, REPORTING_JOBS } from './jobs.js';
export {
  LAST_SUCCESS_WINDOW_DAYS,
  REFRESH_LOCK_KEY,
  refreshScope,
  runRefreshOps,
} from './refresh.js';
export type { RefreshDeps, RefreshResult } from './refresh.js';
export { FEED_STALE_AFTER_S, readOpsFeed } from './feed.js';
export type { OpsFeed } from './feed.js';
