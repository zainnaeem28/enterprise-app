// Role-based navigation (UI-UX 3.2). Server authorisation stays authoritative: a link here only decides what is
// offered, every route and API call is checked again on the server.
// R1 only: items marked R2/R3 in the map (Prescriptions, Results inbox, Lab desk) are not offered.

export type Surface = 'preconsult' | 'doctor';

export interface NavItem {
  id: string;
  label: string;
  /** Fixed path. Never carries a patient, appointment or other record identifier (no PHI in URLs). */
  path: string;
}

const preconsult: readonly NavItem[] = [
  { id: 'arrivals', label: 'Arrivals', path: '/arrivals' },
  { id: 'triage', label: 'Triage queue', path: '/triage' },
  { id: 'forms', label: 'Forms & consents', path: '/forms' },
  { id: 'follow-ups', label: 'Follow-ups', path: '/follow-ups' },
  { id: 'waitlist', label: 'Waitlist', path: '/waitlist' },
];

// Phone order is Alerts · Schedule · Patients · More (UI-UX 3.2); desktop order follows the map.
const doctor: readonly NavItem[] = [
  { id: 'alerts', label: 'Alerts', path: '/alerts' },
  { id: 'schedule', label: 'Schedule', path: '/schedule' },
  { id: 'patients', label: 'Patients', path: '/patients' },
  { id: 'tasks', label: 'Tasks & messages', path: '/tasks' },
  { id: 'notes', label: 'Notes to sign', path: '/notes-to-sign' },
  { id: 'availability', label: 'Availability', path: '/availability' },
];

export const surfaces: Record<Surface, readonly NavItem[]> = { preconsult, doctor };

/** Staff-realm role keys (ARCHITECTURE 27.3). Admin-realm roles never get staff navigation. */
const roleSurface: Record<string, Surface> = {
  front_desk: 'preconsult',
  front_desk_lead: 'preconsult',
  medical_records: 'preconsult',
  triage_nurse: 'preconsult',
  care_coordinator: 'preconsult',
  doctor: 'doctor',
  trainee_doctor: 'doctor',
  assistant: 'doctor',
};

/** The navigation for a set of role keys: each surface once, in the fixed order below; unknown roles add nothing. */
export function navigationFor(roleKeys: readonly string[]): NavItem[] {
  const wanted = new Set<Surface>();
  for (const key of roleKeys) {
    const s = roleSurface[key];
    if (s !== undefined) wanted.add(s);
  }
  const out: NavItem[] = [];
  if (wanted.has('doctor')) out.push(...doctor);
  if (wanted.has('preconsult')) out.push(...preconsult);
  return out;
}

/** Phone: the first three stay visible, the rest sit under "More" (UI-UX 3.2). */
export const PHONE_VISIBLE = 3;

export const allNavPaths: readonly string[] = [...doctor, ...preconsult].map((i) => i.path);
