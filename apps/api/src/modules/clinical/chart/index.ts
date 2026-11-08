// Public surface of the clinical chart (ARCHITECTURE 24, ticket BE-16). Other modules import only from here.
// Composition, at start-up:
//   1. define CLINICAL_CHART_JOBS in the API's and the worker's JobRegistry (and sync queue task types);
//   2. registerClinicalParticipants() next to the patient merge's other participants (merge) and the privacy export (exportPart);
//      the later clinical tickets pass their own parts in the same call (one participant per module name in the registry);
//   3. API: createClinicalChart({...}) builds the services and controllers and registers the `chart-patient` resolver and the
//      `care_team` / `reservation` assignment sources. Register `chart.controllers` BEFORE the patient module's controllers (both
//      declare `GET /patients/{id}/banner`; this one fills the allergy part);
//   4. worker: createClinicalTasks (apps/worker/src/jobs/clinical) with a terminology source, and the admin trigger enqueues
//      `clinical.terminology_load`.
export { createClinicalChart } from './runtime.js';
export type { ChartDeps, ClinicalChart } from './runtime.js';
export { ChartAccess } from './access.js';
export { BtgAwareAudit } from './audit-port.js';
export type { ChartAuditPort } from './audit-port.js';
export type { ChartAccessLevel } from './access.js';
export { BANNER_ALLERGY_LIMIT, BannerService } from './banner.js';
export type { PhotoUrlPort } from './banner.js';
export { ChartListsService } from './lists.js';
export type { ListQuery, ListsDeps, Page } from './lists.js';
export { ChartSummaryService } from './summary.js';
export type { ChartSummary } from './summary.js';
export { SEARCH_LIMIT, TerminologyService } from './terminology.js';
export { MAX_VITALS_PER_CALL, VitalsService } from './vitals.js';
export type { RecordVitalsInput, RecordedVitals, VitalInput } from './vitals.js';
export { chartResolvers, createChartControllers } from './controller.js';
export type { ChartControllerDeps } from './controller.js';
export { careTeamSource, registerChartAssignmentSources, reservationSource } from './assignment.js';
export {
  CHART_CONFLICT_RULES,
  CHART_MERGE_TABLES,
  chartExportPart,
  chartMergePart,
  clinicalExportContributor,
  clinicalMergeParticipant,
  registerClinicalParticipants,
} from './merge.js';
export type { ClinicalExportPart, ClinicalMergePart } from './merge.js';
export { CLINICAL_CHART_EVENTS, CLINICAL_CHART_JOBS } from './jobs.js';
export {
  ChartError,
  ChartNotFoundError,
  ChartScopeError,
  ChartValidationError,
  InvalidTransitionError,
  PatientMergedError,
  PreconditionFailedError,
  UncodedRequiresDisplayError,
  VitalRangeOverlapError,
  translateDbError,
} from './errors.js';
export {
  ALLERGY_SYSTEMS,
  MEDICATION_SYSTEMS,
  PROBLEM_SYSTEMS,
  TERMINOLOGY_SYSTEMS,
} from './types.js';
export type {
  AllergyBannerItem,
  AllergySummary,
  AllergyView,
  CodeSystem,
  Concept,
  MedicationView,
  PatientBannerView,
  ProblemView,
  RangeStatus,
  RequestMeta,
  VitalRangeView,
  VitalView,
} from './types.js';
