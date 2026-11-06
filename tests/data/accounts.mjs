// Role accounts of TEST-CASES 2. Identities are generated deterministically; the sign-in secret of every account comes
// from the environment (the environment's secret store, DEVOPS-PLAN 3.5), never from this repository.
import { stableUuid } from './prng.mjs';

/** Test domains. `.invalid` is reserved (RFC 2606) and can never be a real mailbox. */
export const STAFF_DOMAIN = 'staff.qa-test.invalid';
export const PATIENT_DOMAIN = 'patient.qa-test.invalid';

const staff = (key, role, actor, locations, extra = {}) => ({
  key,
  realm: 'google',
  audience: 'staff',
  role,
  actor,
  locations,
  ...extra,
});
const patient = (key, extra = {}) => ({
  key,
  realm: 'patient_pool',
  audience: 'patient',
  role: 'patient',
  actor: 'A-02',
  locations: [],
  ...extra,
});

/** TEST-CASES 2 table, one entry per account key. Role keys are bound to ARCH 27.3 in TEST-CASES 20.2. */
export const ACCOUNTS = [
  ...Array.from({ length: 12 }, (_, i) => {
    const key = `PAT-${String(i + 1).padStart(2, '0')}`;
    const notes = {
      'PAT-01': { mfa: true },
      'PAT-02': { mfa: false },
      'PAT-03': { dependantOf: 'PRX-01', age: 17 },
      'PAT-04': { duplicateOf: 'PAT-05' },
      'PAT-05': { duplicateOf: 'PAT-04' },
      'PAT-06': { registeredAt: ['LOC-B1'] },
    };
    return patient(key, notes[key] ?? {});
  }),
  patient('PRX-01', { role: 'guardian_proxy', actor: 'A-03', proxyFor: ['PAT-03'] }),
  staff('STF-FD-A', 'front_desk', 'A-04', ['LOC-A1']),
  staff('STF-TRI-A', 'triage_nurse', 'A-05', ['LOC-A1']),
  staff('STF-COORD-A', 'care_coordinator', 'A-06', ['LOC-A1']),
  staff('STF-DR-A1', 'doctor', 'A-07', ['LOC-A1'], { epcsProofing: false }),
  staff('STF-DR-A2', 'doctor', 'A-07', ['LOC-A1']),
  staff('STF-DR-B1', 'doctor', 'A-07', ['LOC-B1']),
  staff('STF-ASST-A', 'assistant', 'A-08', ['LOC-A1']),
  staff('STF-TRN-A', 'trainee_doctor', 'A-09', ['LOC-A1'], { supervisor: 'STF-DR-A1' }),
  staff('STF-ONCALL', 'on_call_doctor', 'A-17', ['LOC-A1', 'LOC-B1']),
  staff('STF-MRO-A', 'patient_merge_holder', 'BQ-3', ['LOC-A1']),
  // No R1 role exists for billing (ARCH 27.3); a no-role principal for negative cases only (QA-AL-02).
  staff('STF-BILL-A', 'none', 'A-13', ['LOC-A1']),
  staff('STF-MKT', 'marketing_content', 'A-14', [], { realm: 'cms_sso' }),
  staff('ADM-1', 'system_admin', 'A-15', ['*'], { bootstrapPair: true }),
  staff('ADM-2', 'system_admin', 'A-15', ['*'], { bootstrapPair: true }),
  staff('ADM-3', 'system_admin', 'A-15', ['*'], { createdByApproval: true }),
  staff('CMP-1', 'compliance_officer', 'A-16', ['*']),
  staff('CMP-2', 'compliance_officer', 'A-16', ['*'], { secondApprover: true }),
  staff('STF-OUT-OU', 'none', 'A-15', [], { outsideAdminOu: true }),
  staff('STF-SUPER', 'none', 'A-15', [], { workspaceSuperAdmin: true }),
  staff('STF-SUSP', 'none', 'A-04', [], { suspended: true }),
  staff('STF-NO2SV', 'none', 'A-04', [], { twoStepVerification: false }),
  {
    key: 'VIS-01',
    realm: 'none',
    audience: 'visitor',
    role: 'visitor',
    actor: 'A-01',
    locations: [],
  },
].map((a) => {
  const domain = a.audience === 'patient' ? PATIENT_DOMAIN : STAFF_DOMAIN;
  return {
    ...a,
    // Same person across principals is the caller's choice (TEST-CASES 2 two-person rule): personId is per key here.
    personId: stableUuid('person', a.key),
    principalId: stableUuid('principal', a.key),
    displayName: `Test ${a.key}`,
    email: a.realm === 'none' ? null : `${a.key.toLowerCase()}@${domain}`,
  };
});

export const accountByKey = (key) => {
  const a = ACCOUNTS.find((x) => x.key === key);
  if (!a) throw new Error(`unknown test account ${key}`);
  return a;
};

/** Environment variable that carries the secret of an account: PAT-01 -> QA_SECRET_PAT_01. */
export const secretVar = (key) => `QA_SECRET_${key.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;

/**
 * Secrets for the requested accounts, read from `env`. A missing or empty one is an error naming the variables (never a
 * value), so a run cannot proceed on a guessed or default credential. Accounts with realm `none` need no secret.
 */
export function credentialsFromEnv(keys, env = process.env) {
  const out = {};
  const missing = [];
  for (const key of keys) {
    const a = accountByKey(key);
    if (a.realm === 'none') continue;
    const v = env[secretVar(key)];
    if (v === undefined || v === '') missing.push(secretVar(key));
    else out[key] = v;
  }
  if (missing.length)
    throw new Error(`missing credentials in the environment: ${missing.join(', ')}`);
  return out;
}
