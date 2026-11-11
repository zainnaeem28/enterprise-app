import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ConfigError } from '@ehr/kernel';
import {
  RETENTION_DEFAULTS,
  RETENTION_KEYS,
  addYears,
  ageOn,
  exportPackageExpiry,
  exportRetentionSettings,
  hipaaDocumentationRetainedUntil,
  loadRetentionSettings,
  medicalRecordRetainedUntil,
} from './retention.js';

describe('retention settings (owner ruling C, item 2)', () => {
  test('defaults are the ruling values', () => {
    const s = loadRetentionSettings({});
    assert.deepEqual(
      { ...s },
      {
        medicalRecordYearsAfterLastEncounter: 10,
        ageOfMajorityYears: 18,
        minorRetainUntilAgeYears: 21,
        minorYearsAfterLastEncounter: 10,
        auditTrailYears: 7,
        auditAnchorYears: 7,
        hipaaDocumentationYears: 6,
        backupDailyDays: 35,
        backupMonthlyMonths: 12,
        applicationLogDays: 90,
        applicationLogArchiveYears: 1,
        networkFlowLogYears: 1,
        exportPackageDays: 7,
      },
    );
    assert.deepEqual({ ...RETENTION_DEFAULTS }, { ...s });
  });

  test('every key is overridable by its environment variable; names are unique and prefixed', () => {
    const env: Record<string, string> = {};
    for (const key of RETENTION_KEYS) env[key.env] = String(key.default + 1);
    env['EHR_RETENTION_MINOR_UNTIL_AGE_YEARS'] = '22';
    const s = loadRetentionSettings(env);
    for (const key of RETENTION_KEYS)
      assert.equal(s[key.field], key.env.endsWith('MINOR_UNTIL_AGE_YEARS') ? 22 : key.default + 1);
    assert.equal(new Set(RETENTION_KEYS.map((x) => x.env)).size, RETENTION_KEYS.length);
    assert.ok(RETENTION_KEYS.every((x) => x.env.startsWith('EHR_RETENTION_')));
  });

  test('a bad value is reported by variable NAME, never by value, and stops start-up', () => {
    const secretish = 'hunter2-not-a-number';
    assert.throws(
      () =>
        loadRetentionSettings({
          EHR_RETENTION_AUDIT_TRAIL_YEARS: secretish,
          EHR_RETENTION_EXPORT_PACKAGE_DAYS: '0',
          EHR_RETENTION_BACKUP_DAILY_DAYS: '1.5',
        }),
      (e: unknown) =>
        e instanceof ConfigError &&
        e.problems.length === 3 &&
        e.problems.some((p) => p.startsWith('EHR_RETENTION_AUDIT_TRAIL_YEARS')) &&
        !e.message.includes(secretish),
    );
  });

  test('the minors age rule cannot end before majority', () => {
    assert.throws(
      () =>
        loadRetentionSettings({
          EHR_RETENTION_MINOR_UNTIL_AGE_YEARS: '18',
          EHR_RETENTION_AGE_OF_MAJORITY_YEARS: '19',
        }),
      (e: unknown) => e instanceof ConfigError,
    );
  });

  test('the export for DevOps lists every key once with unit and consumer, no PHI', () => {
    const rows = exportRetentionSettings(RETENTION_DEFAULTS);
    assert.equal(rows.length, RETENTION_KEYS.length);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    assert.deepEqual(byKey['EHR_RETENTION_BACKUP_DAILY_DAYS'], {
      key: 'EHR_RETENTION_BACKUP_DAILY_DAYS',
      value: 35,
      unit: 'days',
      consumer: 'devops',
    });
    assert.equal(byKey['EHR_RETENTION_AUDIT_ANCHOR_YEARS']?.value, 7);
  });
});

describe('medical record retention dates', () => {
  const s = RETENTION_DEFAULTS;
  test('adult: 10 years after the last encounter', () => {
    assert.equal(
      medicalRecordRetainedUntil(s, {
        lastEncounterDate: '2020-03-15',
        registeredDate: '2015-01-01',
        birthDate: '1980-05-05',
      }),
      '2030-03-15',
    );
  });
  test('no encounter: the registration date stands in', () => {
    assert.equal(
      medicalRecordRetainedUntil(s, {
        lastEncounterDate: null,
        registeredDate: '2018-06-30',
        birthDate: '1980-05-05',
      }),
      '2028-06-30',
    );
  });
  test('minor: age 21 when that is later than 10 years after the last encounter', () => {
    // 4 years old at the visit: 21st birthday (2037) is later than 2020 + 10.
    assert.equal(
      medicalRecordRetainedUntil(s, {
        lastEncounterDate: '2020-02-01',
        registeredDate: '2020-02-01',
        birthDate: '2016-01-10',
      }),
      '2037-01-10',
    );
  });
  test('minor: 10 years after the last encounter when that is later than age 21', () => {
    // 17 at the visit: 21st birthday 2024-05-05, visit + 10 years = 2030-04-01.
    assert.equal(
      medicalRecordRetainedUntil(s, {
        lastEncounterDate: '2020-04-01',
        registeredDate: '2019-01-01',
        birthDate: '2003-05-05',
      }),
      '2030-04-01',
    );
  });
  test('turning 18 before the visit makes the adult rule apply; the day before 18 is still a minor', () => {
    const adult = medicalRecordRetainedUntil(s, {
      lastEncounterDate: '2021-05-05',
      registeredDate: '2021-05-05',
      birthDate: '2003-05-05',
    });
    assert.equal(adult, '2031-05-05');
    assert.equal(ageOn('2003-05-05', '2021-05-04'), 17);
    const minor = medicalRecordRetainedUntil(s, {
      lastEncounterDate: '2021-05-04',
      registeredDate: '2021-05-04',
      birthDate: '2003-05-05',
    });
    assert.equal(minor, '2031-05-04');
  });
  test('29 February lands on 1 March (later, so kept longer)', () => {
    assert.equal(addYears('2020-02-29', 1), '2021-03-01');
  });
  test('values are settings: a different answer changes the date with no code change', () => {
    const t = loadRetentionSettings({
      EHR_RETENTION_MEDICAL_RECORD_YEARS_AFTER_LAST_ENCOUNTER: '12',
    });
    assert.equal(
      medicalRecordRetainedUntil(t, {
        lastEncounterDate: '2020-03-15',
        registeredDate: '2015-01-01',
        birthDate: null,
      }),
      '2032-03-15',
    );
  });
});

describe('other retention dates', () => {
  test('HIPAA documentation 6 years', () => {
    assert.equal(hipaaDocumentationRetainedUntil(RETENTION_DEFAULTS, '2026-11-11'), '2032-11-11');
  });
  test('export package expires 7 days after creation', () => {
    const created = new Date('2026-11-11T10:00:00.000Z');
    assert.equal(
      exportPackageExpiry(RETENTION_DEFAULTS, created).toISOString(),
      '2026-11-18T10:00:00.000Z',
    );
  });
});
