// Retention settings (owner ruling 2026-11-11 C, item 2; PRD C-20 †). ONE module: the API reads the values here, the worker's retention
// job receives them from the API's composition (`worker-ports.ts`), and DevOps (C-DO-RET) takes the same key names from `RETENTION_KEYS`
// or from the JSON printed by `retention-cli.ts`. The defaults are the owner's conservative product defaults (delegated on HEAAA-33), NOT
// legal advice: † counsel must confirm before go-live. Every value is configuration, so a later answer is a settings change plus a test
// rerun, never a code change.
//
// Every value is an integer in a bounded range. A bad variable is reported by NAME, never by value (ConfigError), and stops start-up.
import { ConfigError } from '@ehr/kernel';

/** The unit of a retention key; the name of the key carries it too, so a value can never be read in the wrong unit. */
export type RetentionUnit = 'years' | 'months' | 'days';

/** Who acts on the value. `app` = enforced by this code base; `devops` = enforced by infrastructure (C-DO-RET) from the same key. */
export type RetentionConsumer = 'app' | 'devops';

export interface RetentionKey {
  /** The setting's name in the typed object (`RetentionSettings[field]`). */
  readonly field: keyof RetentionSettings;
  /** The environment variable that overrides the default. This is the key name DevOps consumes. */
  readonly env: string;
  readonly unit: RetentionUnit;
  readonly default: number;
  readonly min: number;
  readonly max: number;
  readonly consumer: RetentionConsumer;
  /** What the value governs (plain language, no PHI). */
  readonly governs: string;
}

export interface RetentionSettings {
  /** Medical record: years kept after the last encounter. */
  readonly medicalRecordYearsAfterLastEncounter: number;
  /** Age at which a person is no longer a minor for the minors rule (jurisdiction setting). */
  readonly ageOfMajorityYears: number;
  /** Minors: kept until this age ... */
  readonly minorRetainUntilAgeYears: number;
  /** ... or this many years after the last encounter, whichever is later. */
  readonly minorYearsAfterLastEncounter: number;
  readonly auditTrailYears: number;
  readonly auditAnchorYears: number;
  /** HIPAA documentation (requests, incidents, deletion records, accountings of disclosures). */
  readonly hipaaDocumentationYears: number;
  readonly backupDailyDays: number;
  readonly backupMonthlyMonths: number;
  /** Application logs stay searchable this many days ... */
  readonly applicationLogDays: number;
  /** ... and are then kept in the archive for this many years. */
  readonly applicationLogArchiveYears: number;
  readonly networkFlowLogYears: number;
  /** Privacy export packages are removed this many days after creation. */
  readonly exportPackageDays: number;
}

const k = (
  field: keyof RetentionSettings,
  env: string,
  unit: RetentionUnit,
  dflt: number,
  min: number,
  max: number,
  consumer: RetentionConsumer,
  governs: string,
): RetentionKey => ({ field, env, unit, default: dflt, min, max, consumer, governs });

/** The contract. Adding a key is additive; renaming or removing one breaks DevOps (C-DO-RET) and needs a coordinated change. */
export const RETENTION_KEYS: readonly RetentionKey[] = [
  k(
    'medicalRecordYearsAfterLastEncounter',
    'EHR_RETENTION_MEDICAL_RECORD_YEARS_AFTER_LAST_ENCOUNTER',
    'years',
    10,
    1,
    100,
    'app',
    'medical record: years after the last encounter',
  ),
  k(
    'ageOfMajorityYears',
    'EHR_RETENTION_AGE_OF_MAJORITY_YEARS',
    'years',
    18,
    16,
    21,
    'app',
    'a patient younger than this at the last encounter is a minor for the minors rule',
  ),
  k(
    'minorRetainUntilAgeYears',
    'EHR_RETENTION_MINOR_UNTIL_AGE_YEARS',
    'years',
    21,
    18,
    30,
    'app',
    'minors: record kept until this age, or the encounter rule below, whichever is later',
  ),
  k(
    'minorYearsAfterLastEncounter',
    'EHR_RETENTION_MINOR_YEARS_AFTER_LAST_ENCOUNTER',
    'years',
    10,
    1,
    100,
    'app',
    'minors: years after the last encounter, whichever is later than the age rule',
  ),
  k(
    'auditTrailYears',
    'EHR_RETENTION_AUDIT_TRAIL_YEARS',
    'years',
    7,
    1,
    100,
    'devops',
    'audit trail (archive Object Lock retention; the app never deletes audit rows)',
  ),
  k(
    'auditAnchorYears',
    'EHR_RETENTION_AUDIT_ANCHOR_YEARS',
    'years',
    7,
    1,
    100,
    'devops',
    'audit anchors (archive Object Lock retention)',
  ),
  k(
    'hipaaDocumentationYears',
    'EHR_RETENTION_HIPAA_DOCUMENTATION_YEARS',
    'years',
    6,
    1,
    100,
    'app',
    'HIPAA documentation: privacy requests, incidents, deletion records',
  ),
  k(
    'backupDailyDays',
    'EHR_RETENTION_BACKUP_DAILY_DAYS',
    'days',
    35,
    1,
    3650,
    'devops',
    'daily backups',
  ),
  k(
    'backupMonthlyMonths',
    'EHR_RETENTION_BACKUP_MONTHLY_MONTHS',
    'months',
    12,
    1,
    600,
    'devops',
    'monthly backups',
  ),
  k(
    'applicationLogDays',
    'EHR_RETENTION_APPLICATION_LOG_DAYS',
    'days',
    90,
    1,
    3650,
    'devops',
    'application logs, searchable period',
  ),
  k(
    'applicationLogArchiveYears',
    'EHR_RETENTION_APPLICATION_LOG_ARCHIVE_YEARS',
    'years',
    1,
    1,
    100,
    'devops',
    'application logs, archived period after the searchable period',
  ),
  k(
    'networkFlowLogYears',
    'EHR_RETENTION_NETWORK_FLOW_LOG_YEARS',
    'years',
    1,
    1,
    100,
    'devops',
    'network flow logs',
  ),
  k(
    'exportPackageDays',
    'EHR_RETENTION_EXPORT_PACKAGE_DAYS',
    'days',
    7,
    1,
    365,
    'app',
    'privacy export packages: days after creation until removal',
  ),
];

export const RETENTION_DEFAULTS: RetentionSettings = Object.freeze(
  Object.fromEntries(
    RETENTION_KEYS.map((x) => [x.field, x.default]),
  ) as unknown as RetentionSettings,
);

/** Reads the overrides from the environment; unset means the default. Throws ConfigError naming every bad variable (never a value). */
export function loadRetentionSettings(
  env: Readonly<Record<string, string | undefined>>,
): RetentionSettings {
  const problems: string[] = [];
  const out: Record<string, number> = {};
  for (const key of RETENTION_KEYS) {
    const raw = env[key.env];
    if (raw === undefined || raw === '') {
      out[key.field] = key.default;
      continue;
    }
    const n = /^[0-9]{1,6}$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
    if (!Number.isInteger(n) || n < key.min || n > key.max) {
      problems.push(`${key.env} must be an integer from ${key.min} to ${key.max} (${key.unit})`);
      out[key.field] = key.default;
    } else out[key.field] = n;
  }
  const s = out as unknown as RetentionSettings;
  // Cross-field rules: an age-based minors rule that ends before majority would make the rule meaningless.
  if (s.minorRetainUntilAgeYears < s.ageOfMajorityYears)
    problems.push(
      'EHR_RETENTION_MINOR_UNTIL_AGE_YEARS must not be lower than EHR_RETENTION_AGE_OF_MAJORITY_YEARS',
    );
  if (problems.length > 0) throw new ConfigError(problems);
  return Object.freeze(s);
}

/** The flat export DevOps consumes: environment-variable name to value, plus the unit and consumer. No PHI, no secrets. */
export function exportRetentionSettings(s: RetentionSettings): {
  key: string;
  value: number;
  unit: RetentionUnit;
  consumer: RetentionConsumer;
}[] {
  return RETENTION_KEYS.map((x) => ({
    key: x.env,
    value: s[x.field],
    unit: x.unit,
    consumer: x.consumer,
  }));
}

// ---- dates -------------------------------------------------------------------------------------------------------------------
// All dates are UTC calendar dates (`YYYY-MM-DD`). Adding years to 29 February lands on 1 March: the later date, so the record is kept
// a day longer rather than a day shorter.

const DAY = 86_400_000;

export function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addYears(date: string, years: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return dateOnly(new Date(Date.UTC(y + years, m - 1, d)));
}

/** The same calendar day `years` earlier; 29 February becomes 28 February (the earlier date, so a cut-off never removes a day too early). */
export function subYears(date: string, years: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const last = new Date(Date.UTC(y - years, m, 0)).getUTCDate();
  return dateOnly(new Date(Date.UTC(y - years, m - 1, Math.min(d, last))));
}

export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return dateOnly(new Date(Date.UTC(y, m - 1 + months, d)));
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return dateOnly(new Date(Date.UTC(y, m - 1, d) + days * DAY));
}

export function laterOf(a: string, b: string): string {
  return a >= b ? a : b;
}

/** Whole years between two calendar dates (`from` <= `to`); a birthday not yet reached does not count. */
export function ageOn(birthDate: string, on: string): number {
  const [by, bm, bd] = birthDate.split('-').map(Number) as [number, number, number];
  const [oy, om, od] = on.split('-').map(Number) as [number, number, number];
  return oy - by - (om < bm || (om === bm && od < bd) ? 1 : 0);
}

export interface RetentionBasis {
  /** Date of the last encounter; null when the patient never had one. */
  lastEncounterDate: string | null;
  /** The patient's registration date: the basis when there was no encounter. */
  registeredDate: string;
  /** Date of birth, if known. Unknown means the adult rule (nothing to compute an age from). */
  birthDate: string | null;
}

/**
 * The last day the medical record must be kept (it may be purged the day after).
 *  - Adult: last encounter + `medicalRecordYearsAfterLastEncounter`.
 *  - Minor (younger than the age of majority at the last encounter): the LATER of the 21st birthday (`minorRetainUntilAgeYears`) and
 *    last encounter + `minorYearsAfterLastEncounter`.
 * With no encounter the registration date stands in for it (documented in the module README; counsel to confirm).
 */
export function medicalRecordRetainedUntil(s: RetentionSettings, b: RetentionBasis): string {
  const basis = b.lastEncounterDate ?? b.registeredDate;
  const adult = addYears(basis, s.medicalRecordYearsAfterLastEncounter);
  if (b.birthDate === null || ageOn(b.birthDate, basis) >= s.ageOfMajorityYears) return adult;
  return laterOf(
    addYears(b.birthDate, s.minorRetainUntilAgeYears),
    addYears(basis, s.minorYearsAfterLastEncounter),
  );
}

/** HIPAA documentation: kept this long after the document was finished. */
export function hipaaDocumentationRetainedUntil(
  s: RetentionSettings,
  finishedDate: string,
): string {
  return addYears(finishedDate, s.hipaaDocumentationYears);
}

/** A privacy export package is removed this many days after its creation. */
export function exportPackageExpiry(s: RetentionSettings, createdAt: Date): Date {
  return new Date(createdAt.getTime() + s.exportPackageDays * DAY);
}

/** Audit and anchors are kept by the archive; this is the day from which their archive copy may lapse (read-only report). */
export function auditRetainedUntil(s: RetentionSettings, eventDate: string): string {
  return addYears(eventDate, s.auditTrailYears);
}

/**
 * What the worker's retention job receives (the worker does not import this package; its `RetentionPolicyPort` has the same shape, and
 * the composition assigns this object to it, so a mismatch fails to compile).
 */
export interface RetentionPolicy {
  medicalRecordRetainedUntil(basis: RetentionBasis): string;
  hipaaDocumentationCutoff(today: string): string;
  exportPackageCutoff(now: Date): Date;
  auditCutoff(today: string): string;
  readonly settings: RetentionSettings;
  readonly years: { auditTrail: number; auditAnchor: number; hipaaDocumentation: number };
}

export function retentionPolicy(s: RetentionSettings): RetentionPolicy {
  return {
    medicalRecordRetainedUntil: (b) => medicalRecordRetainedUntil(s, b),
    hipaaDocumentationCutoff: (today) => subYears(today, s.hipaaDocumentationYears),
    exportPackageCutoff: (now) => new Date(now.getTime() - s.exportPackageDays * DAY),
    auditCutoff: (today) => subYears(today, s.auditTrailYears),
    settings: s,
    years: {
      auditTrail: s.auditTrailYears,
      auditAnchor: s.auditAnchorYears,
      hipaaDocumentation: s.hipaaDocumentationYears,
    },
  };
}
