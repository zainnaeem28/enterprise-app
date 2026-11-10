export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type RuleMode = 'in_person' | 'video' | 'either';
export type BlockedKind = 'leave' | 'blocked' | 'admin';
export type RosterDuty = 'on_duty_doctor' | 'on_call_doctor' | 'compliance_on_call';

export interface RuleInput {
  /** 0 = Sunday .. 6 = Saturday (extract(dow)), in the local time of the template's location. */
  weekday: number;
  /** Local wall-clock time `HH:MM` (seconds are accepted and must be zero). */
  startLocal: string;
  endLocal: string;
  /** null or absent = every service the doctor is eligible for. */
  serviceIds?: string[] | null;
  mode: RuleMode;
  roomId?: string | null;
  overbookable?: boolean;
}

export interface TemplateInput {
  locationId: string;
  /** `YYYY-MM-DD`, a date at the template's location. */
  validFrom: string;
  validTo?: string | null;
  rules: RuleInput[];
}

export interface RuleView {
  id: string;
  weekday: number;
  startLocal: string;
  endLocal: string;
  serviceIds: string[] | null;
  mode: RuleMode;
  roomId: string | null;
  overbookable: boolean;
}

export interface TemplateView {
  id: string;
  clinicianId: string;
  locationId: string;
  validFrom: string;
  validTo: string | null;
  status: 'active' | 'retired';
  rules: RuleView[];
  version: number;
}

export interface BlockedTimeInput {
  startsAt: string;
  endsAt: string;
  kind: BlockedKind;
  note?: string | null;
  /** Saves although active appointments overlap (they stay as they are: nothing is cancelled). */
  acknowledgeConflicts?: boolean;
  /** Reports the conflicts and saves nothing. */
  dryRun?: boolean;
}

export interface BlockedTimeView {
  id: string;
  clinicianId: string;
  startsAt: string;
  endsAt: string;
  kind: BlockedKind;
  note: string | null;
  version: number;
}

/** Appointments of the doctor that overlap a period, by occupancy status. Counts only: an occupancy row has no patient. */
export interface ConflictCounts {
  total: number;
  held: number;
  confirmed: number;
  checked_in: number;
}

export interface RosterInput {
  duty: RosterDuty;
  principalId: string;
  startsAt: string;
  endsAt: string;
}

export interface RosterView {
  id: string;
  locationId: string;
  duty: RosterDuty;
  principalId: string;
  startsAt: string;
  endsAt: string;
  version: number;
}

export interface SearchInput {
  serviceId: string;
  locationId?: string | null;
  clinicianId?: string | null;
  mode: 'in_person' | 'video';
  from: string;
  to: string;
  /** Staff only (29.3): also offer slots in overbookable sessions that are already occupied, up to the session's cap. */
  includeOverbook?: boolean;
}

export interface Slot {
  startsAt: string;
  endsAt: string;
  clinicianId: string;
  locationId: string;
  mode: 'in_person' | 'video';
  /** Only in a staff search with `includeOverbook`: this slot already holds a booking and takes a further one, up to the cap, in an overbookable window. */
  overbook?: true;
}

export interface SearchResult {
  slots: Slot[];
  /** True when any doctor in the result has Google busy data older than the stale threshold (X-03, RA-R1-04). */
  availabilityStale: boolean;
}
