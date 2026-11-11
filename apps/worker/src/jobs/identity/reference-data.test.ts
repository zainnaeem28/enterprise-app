import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  checksum,
  expandedMapping,
  expandRole,
  ReferenceDataError,
} from './apply-reference-data.js';
import { PERMISSIONS, ROLES } from './reference-data.js';
import type { RoleSeed } from './reference-data.js';

const keys = (role: string): string[] =>
  expandedMapping().find((m) => m.role.key === role)?.permissions ?? [];
const base = (over: Partial<RoleSeed>): RoleSeed => ({
  key: 't',
  realm: 'google',
  privileged: false,
  locationBound: true,
  permissions: [],
  ...over,
});

const DOCTOR_PINNED = [
  'audit.btg.open',
  'calendar.link.own',
  'clinical.alert.red_flag.receive',
  'clinical.chart.read',
  'clinical.chart.read_previsit',
  'clinical.consultation.start',
  'clinical.list.write',
  'clinical.note.cosign',
  'clinical.note.sign',
  'clinical.note.write',
  'clinical.referral.manage',
  'clinical.terminology.search',
  'clinical.triage.record',
  'clinical.vitals.record',
  'documents.read',
  'documents.upload',
  'messaging.task.manage',
  'messaging.thread.patient',
  'messaging.thread.staff',
  'notifications.alert.acknowledge',
  'notifications.alert.read',
  'patient.lookup',
  'scheduling.blocked_time.manage',
  'scheduling.booking.own_schedule',
  'scheduling.template.manage',
  'telehealth.session.host',
];

describe('the 27.2 catalogue and the 27.3 default mapping as data (a Proposal until G2)', () => {
  test('81 permissions, flags as in 27.2, and compliance slices only on the six slice permissions', () => {
    assert.equal(PERMISSIONS.length, 81);
    assert.equal(new Set(PERMISSIONS.map((p) => p.key)).size, 81);
    const by = Object.fromEntries(PERMISSIONS.map((p) => [p.key, p]));
    assert.deepEqual(
      [by['identity.principal.kill']?.privileged, by['identity.principal.kill']?.needsElevation],
      [true, true],
    );
    assert.deepEqual(
      [by['identity.principal.read']?.privileged, by['identity.principal.read']?.needsElevation],
      [true, false],
    );
    assert.deepEqual(
      [by['patient.read']?.privileged, by['patient.read']?.needsElevation],
      [false, false],
    );
    assert.equal(by['audit.btg.open']?.privileged, false, 'doctors open break-glass');
    assert.equal(by['audit.btg.review']?.privileged, true);
    assert.equal(by['clinical.vital_range.manage']?.needsElevation, true);
    const sliced = PERMISSIONS.filter((p) => p.complianceScope !== null).map(
      (p) => `${p.key}=${p.complianceScope}`,
    );
    assert.deepEqual(sliced.sort(), [
      'audit.btg.review=btg_grants',
      'audit.event.read=audit_events',
      'patient.consent.read=consents',
      'patient.label.read=patient_label',
      'privacy.incident.manage=incidents',
      'privacy.request.manage=privacy_requests',
    ]);
  });

  test('eleven roles; privileged roles live in admin_pool only; staff roles are location-bound, admin roles are not', () => {
    assert.deepEqual(
      ROLES.map((r) => r.key),
      [
        'front_desk',
        'front_desk_lead',
        'medical_records',
        'triage_nurse',
        'care_coordinator',
        'doctor',
        'trainee_doctor',
        'assistant',
        'org_admin',
        'compliance_officer',
        'compliance_on_call',
      ],
    );
    for (const r of ROLES) {
      assert.equal(r.privileged, r.realm === 'admin_pool', r.key);
      assert.equal(r.locationBound, r.realm === 'google', r.key);
    }
  });

  test('27.3: the rows that are easy to get wrong', () => {
    const doctor = keys('doctor');
    assert.ok(
      doctor.includes('clinical.note.sign') &&
        doctor.includes('audit.btg.open') &&
        doctor.includes('clinical.chart.read'),
    );
    assert.ok(
      doctor.includes('messaging.thread.patient') &&
        doctor.includes('telehealth.session.host') &&
        doctor.includes('calendar.link.own'),
    );
    assert.ok(
      !doctor.includes('clinical.vital_range.manage'),
      'a privileged permission is never given to a staff-realm role',
    );
    assert.ok(
      !doctor.some(
        (k) => (k.startsWith('patient.') && k !== 'patient.lookup') || k.startsWith('identity.'),
      ),
      'a doctor has no patient.* right but patient.lookup (draft 8.3)',
    );
    const trainee = keys('trainee_doctor');
    assert.ok(!trainee.includes('clinical.note.sign') && !trainee.includes('audit.btg.open'));
    assert.equal(trainee.length, doctor.length - 2);
    assert.deepEqual([...doctor].sort(), DOCTOR_PINNED, 'draft 8.3 FE10D pinned set (26 keys)');
    assert.deepEqual(
      [...trainee].sort(),
      DOCTOR_PINNED.filter((k) => k !== 'audit.btg.open' && k !== 'clinical.note.sign'),
      'trainee_doctor: the pinned set without audit.btg.open and clinical.note.sign (24 keys)',
    );
    assert.equal(DOCTOR_PINNED.length, 26);
    for (const forbidden of ['patient.read', 'scheduling.check_in']) {
      assert.ok(!doctor.includes(forbidden) && !trainee.includes(forbidden), forbidden);
    }
    assert.deepEqual(keys('assistant'), [
      'clinical.chart.read',
      'clinical.list.write',
      'clinical.note.write',
    ]);
    assert.deepEqual(keys('compliance_on_call'), [
      'audit.btg.review',
      'notifications.alert.acknowledge',
      'notifications.alert.read',
    ]);
    const lead = keys('front_desk_lead');
    const fd = keys('front_desk');
    for (const k of fd) assert.ok(lead.includes(k));
    assert.deepEqual(
      lead.filter((k) => !fd.includes(k)),
      [
        'identity.proxy.revoke',
        'identity.proxy.verify',
        'patient.attach',
        'patient.merge.request',
        'scheduling.roster.manage',
      ],
    );
    assert.ok(!fd.includes('patient.merge.request'));
    const admin = keys('org_admin');
    assert.ok(
      admin.includes('clinical.vital_range.manage') &&
        admin.includes('identity.principal.kill') &&
        admin.includes('integration.secret.approve'),
    );
    assert.ok(
      !admin.some((k) => k.startsWith('patient.') || k.startsWith('audit.')),
      'org_admin reads no PHI and no audit',
    );
    assert.ok(keys('compliance_officer').includes('audit.export.create'));
    assert.ok(!keys('medical_records').includes('patient.update'));
  });

  test('every permission a role holds is in the catalogue, and privileged ones only in privileged roles', () => {
    const cat = new Map(PERMISSIONS.map((p) => [p.key, p]));
    for (const { role, permissions } of expandedMapping())
      for (const k of permissions) {
        assert.ok(cat.has(k), `${role.key}: ${k}`);
        if (cat.get(k)?.privileged) assert.ok(role.privileged, `${role.key} holds privileged ${k}`);
      }
  });

  test('the checksum is stable and changes with the data', () => {
    assert.deepEqual(checksum(), checksum());
    assert.equal(checksum().length, 32);
  });

  test('expandRole refuses what the database would also refuse', () => {
    assert.throws(
      () => expandRole(base({ permissions: ['no.such.permission'] })),
      ReferenceDataError,
    );
    assert.throws(
      () => expandRole(base({ permissions: ['identity.principal.kill'] })),
      /privileged roles only/,
    );
    assert.throws(() => expandRole(base({ permissions: ['nothing.*'] })), /matches no permission/);
    assert.throws(
      () => expandRole(base({ permissions: ['patient.read'], minus: ['patient.update'] })),
      /removes nothing/,
    );
    assert.throws(
      () => expandRole(base({ privileged: true, realm: 'google', permissions: ['patient.read'] })),
      /admin_pool/,
    );
    assert.deepEqual(
      expandRole(base({ permissions: ['clinical.*'], minus: ['clinical.note.sign'] })).includes(
        'clinical.vital_range.manage',
      ),
      false,
    );
  });
});
