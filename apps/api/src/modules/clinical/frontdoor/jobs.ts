// Job types and events of the clinical front door (ARCHITECTURE 33.1, 24).
//
// `clinical.on_alert_unacknowledged` is the handler of `notifications.alert_unacknowledged` (25.5): it re-targets an unacknowledged
// red flag to the on-call doctor (`TriageService.retargetUnacknowledged`). The WHEN is the alert's `escalate_at`, from the
// `staff_alert_setting` row that the safety reviewer sets (D-12a, PM-confirm-1); nothing here assumes a value. The worker's handler
// (apps/worker/src/jobs/clinical) is outside this ticket's paths: see the module README (request to the Orchestrator).
import type { JobRegistry, JobType } from '@ehr/kernel';

export const FRONTDOOR_JOBS: readonly JobType[] = [
  {
    name: 'clinical.on_alert_unacknowledged',
    maxAttempts: 5,
    onMerged: 'resolve',
    carriesPatientIds: true,
    jobScope: 'patients',
    jobClass: 'handler',
  },
];

/** Events this module publishes. `clinical.red_flag_raised` is the 24 event; `clinical.roster_gap` is the operations signal of 25.5. */
export const FRONTDOOR_EVENTS = ['clinical.red_flag_raised', 'clinical.roster_gap'] as const;

/** Registers the one handler this module has for an event of another module's. */
export function registerFrontdoorHandlers(registry: Pick<JobRegistry, 'registerHandler'>): void {
  registry.registerHandler('notifications.alert_unacknowledged', 'clinical');
}
