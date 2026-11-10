// TC-PERF-02 (NFR-8): slot search across ALL locations at peak and 2x (and the 3x burst). p95 < 1 s.
import {
  phased,
  PEAK_RPS,
  latencyThresholds,
  pick,
  slotSearch,
  summaryWithMeta,
} from '../lib/common.js';

export const options = {
  scenarios: phased('search', 'search', PEAK_RPS.slot_search),
  thresholds: latencyThresholds(),
};
export function search() {
  slotSearch(pick('patient'));
}
export const handleSummary = (d) => summaryWithMeta('TC-PERF-02', d);
