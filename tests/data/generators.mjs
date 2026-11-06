// Synthetic data generators for TEST-CASES 3. Everything is derived from (seed, index); nothing is real. No real
// person's data may exist in any non-production environment (BR-35).
import { stableUuid, rng, int, pick } from './prng.mjs';
import { PATIENT_DOMAIN } from './accounts.mjs';

export const DEFAULT_SEED = 'ehr-r1';

const GIVEN = [
  'Alex',
  'Sam',
  'Robin',
  'Jordan',
  'Casey',
  'Taylor',
  'Morgan',
  'Riley',
  'Quinn',
  'Avery',
];
const FAMILY = ['Testpatient', 'Syntheticson', 'Fixture', 'Sampleton', 'Mockwell', 'Placeholder'];

// 3.1 Organisation and clinics -------------------------------------------------------------------------------------
export function organisations(seed = DEFAULT_SEED) {
  const id = (n) => stableUuid(`${seed}/org`, n);
  const loc = (code, zone, parentClinic) => ({
    code,
    id: id(code),
    clinic: parentClinic,
    timezone: zone,
    rooms: [`${code}-R1`, `${code}-R2`],
    hours: { mon_fri: ['09:00', '17:00'] },
    holiday: '2027-01-01',
    settings: { holdMinutes: 10, cutoffHours: 2, reminders: [24, 2] },
  });
  return [
    {
      code: 'ORG-1',
      id: id('ORG-1'),
      name: 'Test Organisation One',
      clinics: [
        { code: 'CLINIC-A', id: id('CLINIC-A'), locations: ['LOC-A1', 'LOC-A2'] },
        { code: 'CLINIC-B', id: id('CLINIC-B'), locations: ['LOC-B1'] },
      ],
      locations: [
        loc('LOC-A1', 'America/New_York', 'CLINIC-A'),
        loc('LOC-A2', 'America/New_York', 'CLINIC-A'),
        loc('LOC-B1', 'America/Los_Angeles', 'CLINIC-B'),
      ],
    },
    {
      // ORG-2 exists only to prove organisation isolation (BR-32).
      code: 'ORG-2',
      id: id('ORG-2'),
      name: 'Test Organisation Two',
      clinics: [{ code: 'CLINIC-C', id: id('CLINIC-C'), locations: ['LOC-C1'] }],
      locations: [loc('LOC-C1', 'America/Chicago', 'CLINIC-C')],
    },
  ];
}

export function services(seed = DEFAULT_SEED) {
  const s = (code, internal, display, mode) => ({
    code,
    id: stableUuid(`${seed}/svc`, code),
    internalName: internal,
    patientVisibleName: display,
    mode,
  });
  return [
    s('SVC-IN', 'General consultation (in person)', 'General consultation', 'in_person'),
    s('SVC-VID', 'General consultation (video)', 'Video consultation', 'video'),
    s('SVC-NEUTRAL', 'Ordinary check-up', 'Ordinary check-up', 'in_person'),
    // BR-23 extension: the internal name reveals a condition, the patient-visible name must not.
    s('SVC-SENS', 'synthetic HIV clinic', 'Specialist consultation', 'in_person'),
  ];
}

/** DOC-TPL-1: Mon-Fri 09:00-12:00 in 20-minute slots for STF-DR-A1 at LOC-A1; one overbookable session, cap 2. */
export function doctorTemplate(seed = DEFAULT_SEED) {
  return {
    code: 'DOC-TPL-1',
    id: stableUuid(`${seed}/tpl`, 'DOC-TPL-1'),
    doctor: 'STF-DR-A1',
    location: 'LOC-A1',
    days: ['mon', 'tue', 'wed', 'thu', 'fri'],
    from: '09:00',
    to: '12:00',
    slotMinutes: 20,
    overbookable: [{ day: 'wed', from: '10:00', to: '10:20', cap: 2 }],
  };
}

// 3.2 Patients and clinical content --------------------------------------------------------------------------------
/** One generated patient. Phone numbers use the NANP fictional range 555-0100..0199; emails use a `.invalid` domain. */
export function patient(index, { seed = DEFAULT_SEED, key } = {}) {
  const r = rng(`${seed}/patient/${index}`);
  const year = int(r, 1940, 2008);
  const dob = `${year}-${String(int(r, 1, 12)).padStart(2, '0')}-${String(int(r, 1, 28)).padStart(2, '0')}`;
  const n = String(index + 1).padStart(6, '0');
  return {
    key: key ?? `GEN-${n}`,
    id: stableUuid(`${seed}/patient`, key ?? n),
    givenName: pick(r, GIVEN),
    familyName: `${pick(r, FAMILY)}${n}`,
    dateOfBirth: dob,
    phone: `+1-202-555-01${String(int(r, 0, 99)).padStart(2, '0')}`,
    email: `patient-${n}@${PATIENT_DOMAIN}`,
  };
}

const CLINICAL = {
  problems: ['Synthetic problem: test hypertension', 'Synthetic problem: test sprain'],
  // RxNorm-coded test concepts plus one free-text (uncoded) entry per patient, SA-F-08.
  allergies: [
    { text: 'Test allergen alpha', rxnorm: '7980', coded: true },
    { text: 'free text test allergen', rxnorm: null, coded: false },
  ],
  medications: [
    { text: 'Test medicine alpha', rxnorm: '161', coded: true },
    { text: 'free text test medicine', rxnorm: null, coded: false },
  ],
  vitals: { systolic: 120, diastolic: 80, pulse: 70 },
  note: 'Synthetic signed note. Obviously fake content.',
};

/** Named patients for the PAT-/PRX- accounts, with the relations TEST-CASES 2 states. */
export function namedPatients(seed = DEFAULT_SEED) {
  const mk = (key, i, extra = {}) => ({ ...patient(i, { seed, key }), ...extra });
  const dup = patient(3, { seed, key: 'PAT-04' });
  return [
    mk('PAT-01', 0, { mfa: true }),
    mk('PAT-02', 1, { mfa: false }),
    mk('PAT-03', 2, { age: 17, proxy: 'PRX-01' }),
    // Probable duplicates: same name, date of birth and phone (TEST-CASES 2).
    mk('PAT-04', 3),
    {
      ...patient(4, { seed, key: 'PAT-05' }),
      givenName: dup.givenName,
      familyName: dup.familyName,
      dateOfBirth: dup.dateOfBirth,
      phone: dup.phone,
    },
    mk('PAT-06', 5, { registeredOnlyAt: 'LOC-B1' }),
    ...[7, 8, 9, 10, 11].map((i) => mk(`PAT-${String(i + 1).padStart(2, '0')}`, i)),
    mk('PRX-01', 12),
  ];
}

export function seeds(seed = DEFAULT_SEED) {
  const byKey = Object.fromEntries(namedPatients(seed).map((p) => [p.key, p]));
  return {
    'SEED-CHART-1': { patient: byKey['PAT-01'], ...CLINICAL, signedNoteAuthor: 'STF-DR-A1' },
    'SEED-CHART-2': { patient: byKey['PAT-06'], ...CLINICAL, registeredOnlyAt: 'LOC-B1' },
    'SEED-DUP': {
      patients: [byKey['PAT-04'], byKey['PAT-05']],
      each: { appointments: 3, signedNotes: 1, openTasks: 1, proxyGrants: 1 },
    },
    'SEED-ATTACK': attackStrings(),
  };
}

/** Probe strings for injection and PHI-leak cases. Inert text: nothing here is executed by the generator. */
export function attackStrings() {
  return {
    script: ['<script>alert(1)</script>', '"><img src=x onerror=alert(1)>'],
    sql: ["'; DROP TABLE x; --", "' OR '1'='1", '1; SELECT pg_sleep(1)'],
    conditionName: 'synthetic HIV clinic',
    medicineName: 'Test medicine alpha',
    testName: 'Test panel alpha',
  };
}

// 3.3 Volume sets (load) -------------------------------------------------------------------------------------------
export const VOLUME_SETS = {
  'VOL-1': { patients: 250_000, staff: 1_000, clinics: 30, auditChartViewsPerDayPeak: 2_000_000 },
  'VOL-2': { patients: 250_000, oneLocation: true },
  'VOL-3': { patients: 100, parallelSessionsOnOnePatient: 100 },
};

/** Lazily yields the patients of a volume set; `limit` is for self-tests and smoke use, the full count is the default. */
export function* volumePatients(setName, { seed = DEFAULT_SEED, limit } = {}) {
  const set = VOLUME_SETS[setName];
  if (!set) throw new Error(`unknown volume set ${setName}`);
  const n = Math.min(set.patients, limit ?? set.patients);
  for (let i = 0; i < n; i++) {
    const location =
      set.oneLocation || !set.clinics ? 'LOC-VOL-1' : `LOC-VOL-${(i % set.clinics) + 1}`;
    yield { ...patient(i, { seed: `${seed}/${setName}` }), location };
  }
}
