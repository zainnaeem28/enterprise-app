import { arr, num, rec, str, strOrNull } from './http.js';

// Shapes follow the API controllers (scheduling/flow, clinical/frontdoor, clinical/chart, patient), not the generated types:
// those request and response bodies are `OpaqueObject` in the contract. Every parser returns undefined for a body that is
// not the promised shape, so a contract drift shows as a visible error instead of a half-drawn row.

export type QueueStage = 'waiting' | 'vitals' | 'triage' | 'ready' | 'with_clinician' | 'done';
export const QUEUE_STAGES: readonly QueueStage[] = [
  'waiting',
  'vitals',
  'triage',
  'ready',
  'with_clinician',
  'done',
];
export type TriageCategory = 'emergency' | 'urgent' | 'standard' | 'non_urgent';
export const TRIAGE_CATEGORIES: readonly TriageCategory[] = [
  'emergency',
  'urgent',
  'standard',
  'non_urgent',
];
export type RangeStatus = 'in_range' | 'out_of_range' | 'no_range' | 'unit_mismatch';

export interface Previsit {
  questionnaire: boolean;
  consents: boolean;
  insurance: boolean;
}

export interface Arrival {
  reservationId: string;
  patientId: string;
  patientName: string | null;
  mrn: string | null;
  serviceId: string;
  clinicianId: string;
  mode: 'in_person' | 'video';
  status: string;
  startsAt: string;
  endsAt: string;
  checkedInAt: string | null;
  method: 'desk' | 'qr' | null;
  queueStage: QueueStage | null;
  previsit: Previsit | null;
  noShowCandidate: boolean;
  flaggedForStaff: boolean;
  version: number;
}

const isStage = (v: unknown): v is QueueStage =>
  typeof v === 'string' && (QUEUE_STAGES as readonly string[]).includes(v);
const isCategory = (v: unknown): v is TriageCategory =>
  typeof v === 'string' && (TRIAGE_CATEGORIES as readonly string[]).includes(v);

function parsePrevisit(v: unknown): Previsit | null | undefined {
  if (v === null || v === undefined) return null;
  const p = rec(v);
  if (
    typeof p['questionnaire'] !== 'boolean' ||
    typeof p['consents'] !== 'boolean' ||
    typeof p['insurance'] !== 'boolean'
  )
    return undefined;
  return { questionnaire: p['questionnaire'], consents: p['consents'], insurance: p['insurance'] };
}

export function parseArrival(v: unknown): Arrival | undefined {
  const a = rec(v);
  const previsit = parsePrevisit(a['previsit']);
  if (
    typeof a['reservationId'] !== 'string' ||
    typeof a['patientId'] !== 'string' ||
    typeof a['startsAt'] !== 'string' ||
    typeof a['status'] !== 'string' ||
    previsit === undefined
  )
    return undefined;
  return {
    reservationId: a['reservationId'],
    patientId: a['patientId'],
    patientName: strOrNull(a['patientName']),
    mrn: strOrNull(a['mrn']),
    serviceId: str(a['serviceId']) ?? '',
    clinicianId: str(a['clinicianId']) ?? '',
    mode: a['mode'] === 'video' ? 'video' : 'in_person',
    status: a['status'],
    startsAt: a['startsAt'],
    endsAt: str(a['endsAt']) ?? a['startsAt'],
    checkedInAt: strOrNull(a['checkedInAt']),
    method: a['method'] === 'desk' || a['method'] === 'qr' ? a['method'] : null,
    queueStage: isStage(a['queueStage']) ? a['queueStage'] : null,
    previsit,
    noShowCandidate: a['noShowCandidate'] === true,
    flaggedForStaff: a['flaggedForStaff'] === true,
    version: num(a['version']) ?? 0,
  };
}

export interface CheckInResult {
  reservationId: string;
  queueEntryId: string;
  checkedInAt: string;
  previsit: Previsit;
  alreadyCheckedIn: boolean;
}

export function parseCheckIn(v: unknown): CheckInResult | undefined {
  const c = rec(v);
  const previsit = parsePrevisit(c['previsit']);
  if (typeof c['reservationId'] !== 'string' || previsit === undefined || previsit === null)
    return undefined;
  return {
    reservationId: c['reservationId'],
    queueEntryId: str(c['queueEntryId']) ?? '',
    checkedInAt: str(c['checkedInAt']) ?? '',
    previsit,
    alreadyCheckedIn: c['alreadyCheckedIn'] === true,
  };
}

export interface QueueEntry {
  id: string;
  patientId: string;
  patientName: string | null;
  stage: QueueStage;
  triageCategory: TriageCategory | null;
  enteredAt: string;
  stageChangedAt: string;
  waitSeconds: number;
  assignedClinicianId: string | null;
  roomId: string | null;
  version: number;
}

export function parseQueueEntry(v: unknown): QueueEntry | undefined {
  const q = rec(v);
  if (typeof q['id'] !== 'string' || !isStage(q['stage']) || num(q['waitSeconds']) === undefined)
    return undefined;
  return {
    id: q['id'],
    patientId: str(q['patientId']) ?? '',
    patientName: strOrNull(q['patientName']),
    stage: q['stage'],
    triageCategory: isCategory(q['triageCategory']) ? q['triageCategory'] : null,
    enteredAt: str(q['enteredAt']) ?? '',
    stageChangedAt: str(q['stageChangedAt']) ?? '',
    waitSeconds: q['waitSeconds'] as number,
    assignedClinicianId: strOrNull(q['assignedClinicianId']),
    roomId: strOrNull(q['roomId']),
    version: num(q['version']) ?? 0,
  };
}

export interface Vital {
  vitalId: string;
  loincCode: string;
  value: number | null;
  unit: string | null;
  measuredAt: string;
  rangeStatus: RangeStatus;
  rangeLow: number | null;
  rangeHigh: number | null;
  enteredInError: boolean;
}

const RANGE_STATUSES: readonly string[] = ['in_range', 'out_of_range', 'no_range', 'unit_mismatch'];

export function parseVital(v: unknown): Vital | undefined {
  const x = rec(v);
  if (
    typeof x['vitalId'] !== 'string' ||
    typeof x['loincCode'] !== 'string' ||
    typeof x['rangeStatus'] !== 'string' ||
    !RANGE_STATUSES.includes(x['rangeStatus'])
  )
    return undefined;
  return {
    vitalId: x['vitalId'],
    loincCode: x['loincCode'],
    value: num(x['value']) ?? null,
    unit: strOrNull(x['unit']),
    measuredAt: str(x['measuredAt']) ?? '',
    rangeStatus: x['rangeStatus'] as RangeStatus,
    rangeLow: num(x['rangeLow']) ?? null,
    rangeHigh: num(x['rangeHigh']) ?? null,
    enteredInError: x['enteredInError'] === true,
  };
}

export interface Banner {
  displayName: string;
  dateOfBirth: string;
  mrn: string;
  allergies: {
    state: 'recorded' | 'none_recorded';
    items: { id: string; name: string; severity?: 'severe' | 'moderate' | 'mild' }[];
    moreCount: number;
    uncodedCount: number;
  } | null;
}

export function parseBanner(v: unknown): Banner | undefined {
  const b = rec(v);
  if (typeof b['displayName'] !== 'string' || typeof b['dateOfBirth'] !== 'string')
    return undefined;
  const a = b['allergies'];
  let allergies: Banner['allergies'] = null;
  if (a !== null && a !== undefined) {
    const al = rec(a);
    if (al['state'] !== 'recorded' && al['state'] !== 'none_recorded') return undefined;
    allergies = {
      state: al['state'],
      items: arr(al['items']).map((i) => {
        const r = rec(i);
        const sev = r['severity'];
        return {
          id: str(r['allergyId']) ?? '',
          name: str(r['display']) ?? '',
          ...(sev === 'severe' || sev === 'moderate' || sev === 'mild' ? { severity: sev } : {}),
        };
      }),
      moreCount: num(al['moreCount']) ?? 0,
      uncodedCount: num(al['uncodedCount']) ?? 0,
    };
  }
  return {
    displayName: b['displayName'],
    dateOfBirth: b['dateOfBirth'],
    mrn: str(b['mrn']) ?? '',
    allergies,
  };
}

/** `GET /patients/{id}/banner` wraps the banner as `{ patientBanner }`; the other banner-carrying routes embed the same key. */
export function parseBannerResponse(v: unknown): Banner | undefined {
  return parseBanner(rec(v)['patientBanner']);
}

export interface VitalsResult {
  vitals: Vital[];
  outOfRange: string[];
  banner: Banner | null;
}

export function parseVitalsResult(v: unknown): VitalsResult | undefined {
  const r = rec(v);
  const vitals = arr(r['vitals']).map(parseVital);
  if (vitals.some((x) => x === undefined)) return undefined;
  const banner =
    r['patientBanner'] === undefined ? null : (parseBanner(r['patientBanner']) ?? null);
  return {
    vitals: vitals as Vital[],
    outOfRange: arr(r['outOfRange']).filter((x): x is string => typeof x === 'string'),
    banner,
  };
}

export interface Triage {
  id: string;
  category: TriageCategory;
  notes: string | null;
  redFlag: boolean;
  alertId: string | null;
  assessedAt: string;
}

export function parseTriage(v: unknown): Triage | undefined {
  const t = rec(v);
  if (typeof t['id'] !== 'string' || !isCategory(t['category'])) return undefined;
  return {
    id: t['id'],
    category: t['category'],
    notes: strOrNull(t['notes']),
    redFlag: t['redFlag'] === true,
    alertId: strOrNull(t['alertId']),
    assessedAt: str(t['assessedAt']) ?? '',
  };
}

export interface TriageSaved {
  triage: Triage;
  /** From the triage response the creator gets: the red-flag fact and the alert reference, nothing about its recipients (UXR-08 B). */
  redFlag: boolean;
  alertId: string | null;
  advice: string | null;
  banner: Banner | null;
}

export function parseTriageSaved(v: unknown): TriageSaved | undefined {
  const r = rec(v);
  const triage = parseTriage(r['triage']);
  if (triage === undefined || typeof r['redFlag'] !== 'boolean') return undefined;
  return {
    triage,
    redFlag: r['redFlag'],
    alertId: strOrNull(r['alertId']),
    advice: strOrNull(r['advice']),
    banner: r['patientBanner'] === undefined ? null : (parseBanner(r['patientBanner']) ?? null),
  };
}

export interface CurrentTriage {
  triage: Triage | null;
  banner: Banner | null;
}

export function parseCurrentTriage(v: unknown): CurrentTriage | undefined {
  const r = rec(v);
  if (r['triage'] === null || r['triage'] === undefined) return { triage: null, banner: null };
  const triage = parseTriage(r['triage']);
  if (triage === undefined) return undefined;
  return {
    triage,
    banner: r['patientBanner'] === undefined ? null : (parseBanner(r['patientBanner']) ?? null),
  };
}

export interface ConsentRow {
  id: string;
  templateKey: string;
  templateVersion: number;
  status: 'pending' | 'signed' | 'superseded' | 'withdrawn';
  signedAt: string | null;
}

export function parseConsent(v: unknown): ConsentRow | undefined {
  const c = rec(v);
  const s = c['status'];
  if (
    typeof c['id'] !== 'string' ||
    typeof c['templateKey'] !== 'string' ||
    (s !== 'pending' && s !== 'signed' && s !== 'superseded' && s !== 'withdrawn')
  )
    return undefined;
  return {
    id: c['id'],
    templateKey: c['templateKey'],
    templateVersion: num(c['templateVersion']) ?? 1,
    status: s,
    signedAt: strOrNull(c['signedAt']),
  };
}

export interface QuestionnaireRow {
  id: string;
  reservationId: string | null;
  templateKey: string;
  status: 'in_progress' | 'submitted';
  submittedAt: string | null;
  redFlag: boolean;
}

export function parseQuestionnaire(v: unknown): QuestionnaireRow | undefined {
  const q = rec(v);
  const s = q['status'];
  if (typeof q['id'] !== 'string' || (s !== 'in_progress' && s !== 'submitted')) return undefined;
  return {
    id: q['id'],
    reservationId: strOrNull(q['reservationId']),
    templateKey: str(q['templateKey']) ?? '',
    status: s,
    submittedAt: strOrNull(q['submittedAt']),
    redFlag: q['redFlag'] === true,
  };
}

export type FollowUpStatus = 'open' | 'booked' | 'done' | 'cancelled';

export interface FollowUp {
  id: string;
  patientId: string;
  dueOn: string;
  reason: string;
  status: FollowUpStatus;
  ownerPrincipalId: string | null;
  version: number;
}

export function parseFollowUp(v: unknown): FollowUp | undefined {
  const f = rec(v);
  const s = f['status'];
  if (
    typeof f['id'] !== 'string' ||
    typeof f['dueOn'] !== 'string' ||
    (s !== 'open' && s !== 'booked' && s !== 'done' && s !== 'cancelled')
  )
    return undefined;
  return {
    id: f['id'],
    patientId: str(f['patientId']) ?? '',
    dueOn: f['dueOn'],
    reason: str(f['reason']) ?? '',
    status: s,
    ownerPrincipalId: strOrNull(f['ownerPrincipalId']),
    version: num(f['version']) ?? 0,
  };
}

export interface PatientHit {
  id: string;
  mrn: string;
  givenName: string;
  familyName: string;
  dateOfBirth: string;
  status: string;
}

export function parsePatientHit(v: unknown): PatientHit | undefined {
  const p = rec(v);
  if (typeof p['id'] !== 'string' || typeof p['familyName'] !== 'string') return undefined;
  return {
    id: p['id'],
    mrn: str(p['mrn']) ?? '',
    givenName: str(p['givenName']) ?? '',
    familyName: p['familyName'],
    dateOfBirth: str(p['dateOfBirth']) ?? '',
    status: str(p['status']) ?? 'active',
  };
}

export interface MatchCandidate {
  candidateRef: string;
  strength: 'exact' | 'probable';
  matchedFields: string[];
  inScope: boolean;
  display: {
    patientId: string;
    mrn: string;
    givenName: string;
    familyName: string;
    dateOfBirth: string;
  } | null;
}

export interface MatchResult {
  matchCheckId: string;
  candidates: MatchCandidate[];
}

export function parseMatch(v: unknown): MatchResult | undefined {
  const m = rec(v);
  if (typeof m['matchCheckId'] !== 'string' || !Array.isArray(m['candidates'])) return undefined;
  const candidates: MatchCandidate[] = [];
  for (const c of m['candidates']) {
    const r = rec(c);
    if (typeof r['candidateRef'] !== 'string') return undefined;
    const d = r['display'] === undefined ? null : rec(r['display']);
    candidates.push({
      candidateRef: r['candidateRef'],
      strength: r['strength'] === 'exact' ? 'exact' : 'probable',
      matchedFields: arr(r['matchedFields']).filter((x): x is string => typeof x === 'string'),
      // A candidate outside the caller's scope never shows its demographics (UI-UX 7.3): `display` is dropped even if present.
      inScope: r['inScope'] === true,
      display:
        r['inScope'] === true && d !== null && typeof d['patientId'] === 'string'
          ? {
              patientId: d['patientId'],
              mrn: str(d['mrn']) ?? '',
              givenName: str(d['givenName']) ?? '',
              familyName: str(d['familyName']) ?? '',
              dateOfBirth: str(d['dateOfBirth']) ?? '',
            }
          : null,
    });
  }
  return { matchCheckId: m['matchCheckId'], candidates };
}

export interface DuplicateFlag {
  id: string;
  patientId: string;
  candidatePatientId: string | null;
  strength: 'exact' | 'probable';
  status: string;
  createdAt: string;
}

export function parseDuplicateFlag(v: unknown): DuplicateFlag | undefined {
  const f = rec(v);
  if (typeof f['id'] !== 'string' || typeof f['patientId'] !== 'string') return undefined;
  return {
    id: f['id'],
    patientId: f['patientId'],
    candidatePatientId: strOrNull(f['candidatePatientId']),
    strength: f['strength'] === 'exact' ? 'exact' : 'probable',
    status: str(f['status']) ?? 'open',
    createdAt: str(f['createdAt']) ?? '',
  };
}

export type MergeStatus =
  'requested' | 'approved' | 'rejected' | 'executing' | 'completed' | 'failed' | 'cancelled';

export interface MergeRequest {
  id: string;
  status: MergeStatus;
  /** Null when the caller may not see that record (ARCHITECTURE 9.2): the screen then shows no identifier at all. */
  survivorId: string | null;
  mergedId: string | null;
  reason: string | null;
  callerIsRequester: boolean | null;
  failureCode: string | null;
  decidedAt: string | null;
  overlapsAfterMerge: number | null;
}

const MERGE_STATUSES: readonly string[] = [
  'requested',
  'approved',
  'rejected',
  'executing',
  'completed',
  'failed',
  'cancelled',
];

export function parseMerge(v: unknown): MergeRequest | undefined {
  const m = rec(v);
  if (
    typeof m['id'] !== 'string' ||
    typeof m['status'] !== 'string' ||
    !MERGE_STATUSES.includes(m['status'])
  )
    return undefined;
  const counts = rec(m['counts']);
  return {
    id: m['id'],
    status: m['status'] as MergeStatus,
    survivorId: strOrNull(m['survivorId']),
    mergedId: strOrNull(m['mergedId']),
    reason: strOrNull(m['reason']),
    callerIsRequester: typeof m['callerIsRequester'] === 'boolean' ? m['callerIsRequester'] : null,
    failureCode: strOrNull(m['failureCode']),
    decidedAt: strOrNull(m['decidedAt']),
    overlapsAfterMerge: num(counts['overlaps_after_merge']) ?? null,
  };
}

/** A queue row seen as the visit the desk works on: the queue entry's ID is the visit's (check-in) ID. */
export function arrivalFromQueue(e: QueueEntry): Arrival {
  return {
    reservationId: e.id,
    patientId: e.patientId,
    patientName: e.patientName,
    mrn: null,
    serviceId: '',
    clinicianId: '',
    mode: 'in_person',
    status: 'checked_in',
    startsAt: e.enteredAt,
    endsAt: e.enteredAt,
    checkedInAt: e.enteredAt,
    method: null,
    queueStage: e.stage,
    previsit: null,
    noShowCandidate: false,
    flaggedForStaff: false,
    version: 0,
  };
}
