import { arr, num, rec, str, strOrNull } from '../preconsult/http.js';
import type { RangeStatus } from '../preconsult/types.js';

// Shapes follow the API controllers on the prerequisite branches (clinical/chart, clinical/notes, notifications/alerts, scheduling/flow),
// not the generated types: those bodies are `OpaqueObject` in the contract. Every parser returns undefined for a body that is not the
// promised shape, so a contract drift shows as a visible error instead of a half-drawn screen.

export interface BannerAllergy {
  id: string;
  name: string;
  severity?: 'severe' | 'moderate' | 'mild';
}
export interface Banner {
  patientId: string;
  displayName: string;
  dateOfBirth: string;
  mrn: string;
  photoUrl?: string;
  /** null = the caller passes neither chart read nor pre-visit read: the block is "not shown", never "none" (UI-UX 8). */
  allergies: {
    state: 'recorded' | 'none_recorded';
    items: BannerAllergy[];
    moreCount: number;
    uncodedCount: number;
  } | null;
}

export function parseBanner(v: unknown): Banner | undefined {
  const b = rec(v);
  if (
    typeof b['displayName'] !== 'string' ||
    typeof b['dateOfBirth'] !== 'string' ||
    typeof b['patientId'] !== 'string'
  )
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
  const photo = str(b['photoUrl']);
  return {
    patientId: b['patientId'],
    displayName: b['displayName'],
    dateOfBirth: b['dateOfBirth'],
    mrn: str(b['mrn']) ?? '',
    ...(photo === undefined ? {} : { photoUrl: photo }),
    allergies,
  };
}

export interface ChartEntry {
  id: string;
  display: string;
  coded: boolean;
  detail: string | null;
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

export interface ChartSummary {
  banner: Banner;
  level: 'chart' | 'previsit';
  problems: ChartEntry[] | null;
  allergies: ChartEntry[] | null;
  medications: ChartEntry[] | null;
  vitals: Vital[];
  /** The API types `encounters` and `documents` as unknown lists; only their count is used. */
  encounterCount: number | null;
  documentCount: number | null;
}

function entries(v: unknown, detail: (r: Record<string, unknown>) => string | null) {
  if (!Array.isArray(v)) return null;
  const out: ChartEntry[] = [];
  for (const x of v) {
    const r = rec(x);
    if (typeof r['id'] !== 'string' || typeof r['display'] !== 'string') return undefined;
    if (r['status'] !== undefined && r['status'] !== 'active') continue;
    out.push({
      id: r['id'],
      display: r['display'],
      coded: r['coded'] !== false,
      detail: detail(r),
    });
  }
  return out;
}

export function parseVital(v: unknown): Vital | undefined {
  const r = rec(v);
  const st = r['rangeStatus'];
  if (
    typeof r['vitalId'] !== 'string' ||
    typeof r['loincCode'] !== 'string' ||
    typeof r['measuredAt'] !== 'string' ||
    (st !== 'in_range' && st !== 'out_of_range' && st !== 'no_range' && st !== 'unit_mismatch')
  )
    return undefined;
  return {
    vitalId: r['vitalId'],
    loincCode: r['loincCode'],
    value: num(r['value']) ?? null,
    unit: strOrNull(r['unit']),
    measuredAt: r['measuredAt'],
    rangeStatus: st,
    rangeLow: num(r['rangeLow']) ?? null,
    rangeHigh: num(r['rangeHigh']) ?? null,
    enteredInError: r['enteredInError'] === true,
  };
}

export function parseChartSummary(v: unknown): ChartSummary | undefined {
  const r = rec(v);
  const banner = parseBanner(r['patientBanner']);
  const level = r['level'];
  if (banner === undefined || (level !== 'chart' && level !== 'previsit')) return undefined;
  const problems = entries(r['problems'], (x) => str(x['onsetDate']) ?? null);
  const allergies = entries(
    r['allergies'],
    (x) => [str(x['severity']), str(x['reaction'])].filter(Boolean).join(', ') || null,
  );
  const medications = entries(r['medications'], (x) => str(x['doseText']) ?? null);
  if (problems === undefined || allergies === undefined || medications === undefined)
    return undefined;
  const vitals = arr(r['recentVitals']).map(parseVital);
  if (vitals.some((x) => x === undefined)) return undefined;
  return {
    banner,
    level,
    problems,
    allergies,
    medications,
    vitals: vitals as Vital[],
    encounterCount: Array.isArray(r['encounters']) ? r['encounters'].length : null,
    documentCount: Array.isArray(r['documents']) ? r['documents'].length : null,
  };
}

export interface PatientHit {
  id: string;
  mrn: string;
  givenName: string;
  familyName: string;
  dateOfBirth: string;
}
export function parsePatientHit(v: unknown): PatientHit | undefined {
  const p = rec(v);
  if (
    typeof p['id'] !== 'string' ||
    typeof p['familyName'] !== 'string' ||
    typeof p['givenName'] !== 'string' ||
    typeof p['dateOfBirth'] !== 'string'
  )
    return undefined;
  return {
    id: p['id'],
    mrn: str(p['mrn']) ?? '',
    givenName: p['givenName'],
    familyName: p['familyName'],
    dateOfBirth: p['dateOfBirth'],
  };
}

export interface Visit {
  reservationId: string;
  patientId: string;
  patientName: string | null;
  mrn: string | null;
  clinicianId: string;
  mode: 'in_person' | 'video';
  status: string;
  startsAt: string;
  endsAt: string;
  queueStage: string | null;
}
export function parseVisit(v: unknown): Visit | undefined {
  const a = rec(v);
  if (
    typeof a['reservationId'] !== 'string' ||
    typeof a['patientId'] !== 'string' ||
    typeof a['startsAt'] !== 'string' ||
    typeof a['endsAt'] !== 'string'
  )
    return undefined;
  return {
    reservationId: a['reservationId'],
    patientId: a['patientId'],
    patientName: strOrNull(a['patientName']),
    mrn: strOrNull(a['mrn']),
    clinicianId: str(a['clinicianId']) ?? '',
    mode: a['mode'] === 'video' ? 'video' : 'in_person',
    status: str(a['status']) ?? '',
    startsAt: a['startsAt'],
    endsAt: a['endsAt'],
    queueStage: strOrNull(a['queueStage']),
  };
}

export type NoteStatus = 'draft' | 'pending_cosign' | 'signed';
export interface Encounter {
  id: string;
  patientId: string;
  reservationId: string | null;
  status: string;
  version: number;
  banner: Banner | null;
}
export interface Note {
  id: string;
  encounterId: string;
  patientId: string;
  status: NoteStatus;
  sections: Record<string, string>;
  cosignRequiredFrom: string | null;
  signedAt: string | null;
  cosignedAt: string | null;
  version: number;
  banner: Banner | null;
}
export interface Addendum {
  id: string;
  noteId: string;
  body: string;
  signedAt: string;
}

export function parseEncounter(v: unknown): Encounter | undefined {
  const r = rec(v);
  if (typeof r['id'] !== 'string' || typeof r['patientId'] !== 'string') return undefined;
  return {
    id: r['id'],
    patientId: r['patientId'],
    reservationId: strOrNull(r['reservationId']),
    status: str(r['status']) ?? '',
    version: num(r['version']) ?? 0,
    banner: r['patientBanner'] === undefined ? null : (parseBanner(r['patientBanner']) ?? null),
  };
}

export function parseNote(v: unknown): Note | undefined {
  const r = rec(v);
  const status = r['status'];
  if (
    typeof r['id'] !== 'string' ||
    typeof r['patientId'] !== 'string' ||
    (status !== 'draft' && status !== 'pending_cosign' && status !== 'signed')
  )
    return undefined;
  const sections: Record<string, string> = {};
  for (const [k, val] of Object.entries(rec(rec(r['body'])['sections'])))
    if (typeof val === 'string') sections[k] = val;
  return {
    id: r['id'],
    encounterId: str(r['encounterId']) ?? '',
    patientId: r['patientId'],
    status,
    sections,
    cosignRequiredFrom: strOrNull(r['cosignRequiredFrom']),
    signedAt: strOrNull(r['signedAt']),
    cosignedAt: strOrNull(r['cosignedAt']),
    version: num(r['version']) ?? 0,
    banner: r['patientBanner'] === undefined ? null : (parseBanner(r['patientBanner']) ?? null),
  };
}

export function parseAddendum(v: unknown): Addendum | undefined {
  const r = rec(v);
  if (typeof r['id'] !== 'string' || typeof r['body'] !== 'string') return undefined;
  return {
    id: r['id'],
    noteId: str(r['noteId']) ?? '',
    body: r['body'],
    signedAt: str(r['signedAt']) ?? '',
  };
}

export type AlertStatus = 'open' | 'escalated' | 'acknowledged' | 'closed';
export interface AlertItem {
  alertId: string;
  seq: number;
  type: string;
  severity: string;
  status: AlertStatus;
  createdAt: string;
  escalationLevel: number;
  escalatesAt: string | null;
  acknowledgedAt: string | null;
  acknowledgedByDisplayName: string | null;
  patientId: string | null;
}
export function parseAlert(v: unknown): AlertItem | undefined {
  const r = rec(v);
  const st = r['status'];
  if (
    typeof r['alertId'] !== 'string' ||
    typeof r['type'] !== 'string' ||
    (st !== 'open' && st !== 'escalated' && st !== 'acknowledged' && st !== 'closed')
  )
    return undefined;
  return {
    alertId: r['alertId'],
    seq: num(r['seq']) ?? 0,
    type: r['type'],
    severity: str(r['severity']) ?? 'medium',
    status: st,
    createdAt: str(r['createdAt']) ?? '',
    escalationLevel: num(r['escalationLevel']) ?? 0,
    escalatesAt: strOrNull(r['escalatesAt']),
    acknowledgedAt: strOrNull(r['acknowledgedAt']),
    acknowledgedByDisplayName: strOrNull(r['acknowledgedByDisplayName']),
    patientId: strOrNull(r['patientId']),
  };
}
export interface AckResult {
  alertId: string;
  acknowledgedAt: string;
  alreadyAcknowledged: boolean;
}
export function parseAck(v: unknown): AckResult | undefined {
  const r = rec(v);
  if (typeof r['alertId'] !== 'string' || typeof r['acknowledgedAt'] !== 'string') return undefined;
  return {
    alertId: r['alertId'],
    acknowledgedAt: r['acknowledgedAt'],
    alreadyAcknowledged: r['alreadyAcknowledged'] === true,
  };
}
export interface OpenAlertId {
  alertId: string;
  status: AlertStatus;
  escalationLevel: number;
  escalatesAt: string | null;
}
export function parseOpenId(v: unknown): OpenAlertId | undefined {
  const r = rec(v);
  const st = r['status'];
  if (typeof r['alertId'] !== 'string' || (st !== 'open' && st !== 'escalated')) return undefined;
  return {
    alertId: r['alertId'],
    status: st,
    escalationLevel: num(r['escalationLevel']) ?? 0,
    escalatesAt: strOrNull(r['escalatesAt']),
  };
}

export interface WaitingParticipant {
  id: string;
  name: string;
  admission: string;
}
export function parseWaiting(v: unknown): WaitingParticipant[] | undefined {
  const w = rec(v)['waiting'];
  if (!Array.isArray(w)) return undefined;
  const out: WaitingParticipant[] = [];
  for (const x of w) {
    const r = rec(x);
    if (typeof r['id'] !== 'string') return undefined;
    out.push({
      id: r['id'],
      name: str(r['displayName']) ?? str(r['name']) ?? 'Patient',
      admission: str(r['admission']) ?? 'waiting',
    });
  }
  return out;
}
