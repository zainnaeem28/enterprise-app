// TC-PERF-01 (NFR-6, NFR-9): mixed workload at peak (1x), sustained 2x and 3x burst on ENV-LOAD with VOL-1 data.
// TC-PERF-03 reuses this script with PROFILE=vol2 (VOL-2 data, google-policy staff + patient audiences) - see perf-03-rls.js.
import {
  phased,
  PEAK_RPS,
  latencyThresholds,
  pick,
  get,
  post,
  idem,
  ids,
  slotSearch,
  summaryWithMeta,
} from '../lib/common.js';

export const options = {
  scenarios: {
    ...phased('staff', 'staff', PEAK_RPS.staff),
    ...phased('patient', 'patient', PEAK_RPS.patient),
    ...phased('search', 'search', PEAK_RPS.slot_search),
    ...phased('booking', 'booking', PEAK_RPS.booking),
  },
  thresholds: latencyThresholds(),
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export function staff() {
  const s = pick('staff');
  const r = Math.random();
  if (r < 0.4) get(s, '/api/v1/auth/session');
  else if (r < 0.8)
    get(
      s,
      `/api/v1/clinicians/${s.clinicianId}/schedule?locationId=${s.locationId}`,
      'api',
      '/api/v1/clinicians/:id/schedule',
    );
  else get(s, '/api/v1/alerts/open-ids');
}
export function patient() {
  const s = pick('patient');
  if (Math.random() < 0.5) get(s, '/api/v1/auth/session');
  else get(s, '/api/v1/clinicians');
}
export function search() {
  slotSearch(pick('patient'));
}
export function booking() {
  // hold + confirm of a distinct pre-generated free slot (ids.slots is sized for the full run by the seeder)
  const s = pick('patient');
  const slot = ids.slots[Math.floor(Math.random() * ids.slots.length)];
  const h = post(
    s,
    '/api/v1/holds',
    { patientId: s.patientId, ...slot },
    'api',
    idem(),
    [201, 409],
    '/api/v1/holds',
  );
  if (h.status === 201)
    post(
      s,
      `/api/v1/appointments/${h.json('reservationId')}/confirm`,
      {},
      'api',
      idem(),
      [200, 409],
      '/api/v1/appointments/:id/confirm',
    );
}
export const handleSummary = (d) => summaryWithMeta('TC-PERF-01', d);
