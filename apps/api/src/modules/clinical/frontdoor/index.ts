// Public surface of the clinical front door (ARCHITECTURE 24, ticket BE-18). Other modules import only from here.
// Composition, at start-up (after the chart's, which this builds on):
//   1. define FRONTDOOR_JOBS in the API's and the worker's JobRegistry (and sync queue task types); `registerFrontdoorHandlers` on the
//      registry used by `Queue.publish`;
//   2. registerFrontdoorParticipants() INSTEAD of registerClinicalParticipants(): the registry takes one clinical participant, and
//      this composes the chart's part, this ticket's and any later ones (BE-17 passes its own in `extra`);
//   3. API: createClinicalFrontdoor({ db, chart, audit, identity, ports: createFrontdoorPorts({...}) }); register `controllers`
//      (after the chart's and the scheduling resolvers: `reservation`, `chart-patient`);
//   4. scheduling: `new SchedulingFlowService({ ..., previsit: frontdoor.previsitPort })` so the check-in's pre-visit flags see the
//      questionnaire;
//   5. worker: a `clinical.on_alert_unacknowledged` handler that calls `TriageService.retargetUnacknowledged` (outside this
//      ticket's paths; README).
import { defaultRegistries } from '@ehr/kernel';
import type { ParticipantRegistries } from '@ehr/kernel';
import { chartExportPart, chartMergePart, registerClinicalParticipants } from '../chart/merge.js';
import type { ClinicalExportPart, ClinicalMergePart } from '../chart/merge.js';
import { frontdoorExportPart, frontdoorMergePart } from './merge.js';

export { createClinicalFrontdoor } from './runtime.js';
export type { ClinicalFrontdoor, FrontdoorDeps } from './runtime.js';
export { createFrontdoorPorts } from './adapters.js';
export type { FrontdoorPortDeps } from './adapters.js';
export type {
  AlertPort,
  CarePort,
  CatalogPort,
  CheckInPort,
  ConsentPort,
  DutyPort,
  EventPort,
  FrontdoorPorts,
  RosterDuty,
} from './ports.js';
export { createFrontdoorControllers, frontdoorResolvers } from './controller.js';
export type { FrontdoorControllerDeps } from './controller.js';
export { QuestionnaireService } from './questionnaire.js';
export { TriageService, RED_FLAG_PERMISSION, RED_FLAG_RAISED, ROSTER_GAP } from './triage.js';
export { ConsentGateService, MAX_REASON, MIN_REASON } from './consents.js';
export type { GateInput } from './consents.js';
export { ReferralService, REFERRAL_PERMISSION } from './referrals.js';
export { FollowUpService } from './followups.js';
export { adviceOf, evaluateRedFlags, ruleQuestions } from './redflag.js';
export type { RedFlagResult } from './redflag.js';
export {
  FRONTDOOR_CONFLICT_RULES,
  FRONTDOOR_MERGE_TABLES,
  frontdoorExportPart,
  frontdoorMergePart,
} from './merge.js';
export { FRONTDOOR_EVENTS, FRONTDOOR_JOBS, registerFrontdoorHandlers } from './jobs.js';
export {
  ConsentsMissingError,
  RedFlagAnswerRequiredError,
  RedFlagNoRecipientError,
  ReferralNotPendingError,
  ReferralTargetInvalidError,
} from './errors.js';
export { TRIAGE_CATEGORIES } from './types.js';
export type {
  CheckInInfo,
  ConsentGateResult,
  FollowUpStatus,
  FollowUpView,
  InboxItem,
  QuestionnaireForVisit,
  QuestionnaireResponseView,
  QuestionnaireTemplate,
  ReferralStatus,
  ReferralTargetKind,
  ReferralView,
  SubmitResult,
  TriageCategory,
  TriageResult,
  TriageView,
} from './types.js';

/** Registers the single `clinical` merge participant and export contributor: the chart's part, this ticket's, and `extra` parts. */
export function registerFrontdoorParticipants(
  registries: ParticipantRegistries = defaultRegistries,
  extra: { merge?: readonly ClinicalMergePart[]; export?: readonly ClinicalExportPart[] } = {},
): void {
  registerClinicalParticipants(registries, {
    merge: [chartMergePart, frontdoorMergePart, ...(extra.merge ?? [])],
    export: [chartExportPart, frontdoorExportPart, ...(extra.export ?? [])],
  });
}
