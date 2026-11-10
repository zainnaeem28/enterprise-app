// TC-PERF-03 (HEAAA-12 6.8): VOL-2 (all patients attached to one location). Staff-scope probe under the `google` policy, patient
// audience, audit inserts and the merge write guard on the booking and note paths, at 2x sustained and 3x burst.
// Targets equal TC-PERF-01. If they fail, the fix is an index or a simpler policy - never dropping RLS (the run does not
// and cannot disable RLS: it only uses the public API with real sessions).
import { phased, PEAK_RPS, latencyThresholds, pick, get, post, idem, ids, noteRequest, summaryWithMeta } from '../lib/common.js';

export const options = {
  scenarios: {
    ...phased('staffScope', 'scope', PEAK_RPS.staff),
    ...phased('patientAudience', 'pataud', PEAK_RPS.patient),
    ...phased('writes', 'writes', PEAK_RPS.booking * 4), // booking + note path (merge write guard)
  },
  thresholds: latencyThresholds(),
};
const PHI_READS = (ids.phiReadPaths && ids.phiReadPaths.length ? ids.phiReadPaths : []);
export function staffScope() {
  const s = pick('staff');
  // every PHI table's read path comes from ids.phiReadPaths (one per PHI table, produced from the contract by the seeder)
  const p = PHI_READS[Math.floor(Math.random() * PHI_READS.length)];
  get(s, p.replace('{patientId}', ids.patientIds[Math.floor(Math.random() * ids.patientIds.length)]), 'api', `phi:${p}`);
}
export function patientAudience() {
  const s = pick('patient');
  get(s, '/api/v1/auth/session');
}
export function writes() {
  const s = pick('staff');
  const enc = ids.encounters[Math.floor(Math.random() * ids.encounters.length)];
  post(s, `/api/v1/encounters/${enc}/notes`, noteRequest('synthetic load note'), 'api', idem(), [200, 201], '/api/v1/encounters/:id/notes');
}
export const handleSummary = (d) => summaryWithMeta('TC-PERF-03', d);
