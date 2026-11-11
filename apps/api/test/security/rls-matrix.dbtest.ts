// SEC03-F07 (HEAAA-180): the behavioural row-visibility matrix (ARCHITECTURE 21.3 AN-1) and the direct-SQL negative tests TC-AZ-05, 06, 07
// on PostgreSQL 17 with the migrations of the real pipeline. The unit of evidence is a ROW: one row per table with row-level security,
// read as every audience and realm the application can become, including a second location, a second clinic and a second patient.
// It reads what the database returns, never the policy text, so a predicate that compares a column with itself (SEC03-F01) fails here.
//   EHR_TEST_ADMIN_URL=postgres://postgres@host:5432/postgres node --test dist/src/modules/scheduling/../../test/security/rls-matrix.dbtest.js
// Optional: EHR_MATRIX_REPORT=<file> writes the full matrix as JSON (evidence). Synthetic data only. Missing configuration FAILS.
//
// Sections: (1) seed, (2) the matrix, (3) direct-SQL writes across clinics, (4) TC-AZ-05, (5) TC-AZ-06, (6) TC-AZ-07.
// Cases tagged `open` in OPEN_FINDINGS assert behaviour that a different finding (not F01) still has to fix. They run, they report, and
// they do NOT fail the suite until the owner's fix lands; removing a tag from OPEN_FINDINGS makes the case mandatory.
import { FIXTURE_STATES } from '../../src/platform/fixture-states.js';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { buildScopeStatement } from '@ehr/kernel';
import type { ScopeSettings } from '@ehr/kernel';
import { ORG, ORG2, adminUrl, id, pg, saWrite } from '../../src/modules/patient/testkit.js';
import { patientAccount, registerViaApi } from '../../src/modules/patient/testkit.js';
import {
  A1,
  A2,
  B1,
  SVC,
  setupScheduling,
  slotStart,
} from '../../src/modules/scheduling/core/testkit.js';
import type { SchedKit } from '../../src/modules/scheduling/core/testkit.js';

/** Findings whose negative cases cannot yet pass on the candidate (a todo marker). Empty: SEC03-F02, F04 and F08 pass. */
const OPEN_FINDINGS: Record<string, string> = {};
const openCase = (tag: string): { todo?: string } =>
  tag in OPEN_FINDINGS ? { todo: `${tag}: ${OPEN_FINDINGS[tag]}` } : {};

type Row = Record<string, unknown>;
type Cell = number | 'denied';
const urlAs = (t: SchedKit, user: string): string => t.k.urlFor(user);
const superUser = (): string => new URL(adminUrl as string).username;

/** One transaction as `dbUser` with the given settings; every statement runs under a savepoint so a refusal does not abort the rest. */
class Caller {
  private c: InstanceType<typeof pg.Client> | undefined;
  constructor(
    private readonly t: SchedKit,
    private readonly dbUser: string,
    private readonly settings: ScopeSettings | null,
    private readonly role?: string,
  ) {}
  async open(): Promise<this> {
    this.c = new pg.Client({ connectionString: urlAs(this.t, this.dbUser) });
    await this.c.connect();
    await this.c.query('BEGIN');
    if (this.role !== undefined) await this.c.query(`SET LOCAL ROLE ${this.role}`);
    if (this.settings !== null) {
      const s = buildScopeStatement(this.settings);
      await this.c.query(s.sql, s.params);
    }
    return this;
  }
  /** Runs `sql`; resolves `{ rows, rowCount }` or `{ error }` (SQLSTATE) and always rolls the statement back. */
  async run(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: Row[]; rowCount: number } | { error: string; message: string }> {
    const c = this.c as InstanceType<typeof pg.Client>;
    await c.query('SAVEPOINT s');
    try {
      const r = await c.query(sql, params);
      return { rows: r.rows as Row[], rowCount: r.rowCount ?? 0 };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return { error: err.code ?? 'unknown', message: err.message ?? '' };
    } finally {
      await c.query('ROLLBACK TO SAVEPOINT s');
    }
  }
  async count(sql: string, params: unknown[] = []): Promise<Cell> {
    const r = await this.run(sql, params);
    return 'error' in r ? 'denied' : Number((r.rows[0] as Row)['n']);
  }
  async close(): Promise<void> {
    await this.c?.query('ROLLBACK').catch(() => undefined);
    await this.c?.end().catch(() => undefined);
  }
}

let t: SchedKit;
let A: string; // patient A: cared for at location A1 only
let A_other: string; // a second patient, also at A1 only
let B: string; // patient B: cared for at location B1 only
let linkA: { principalId: string; personId: string };
let linkB: { principalId: string; personId: string };
let unlinked: { principalId: string; personId: string };
let proxyA: { principalId: string; personId: string };
let proxyB: { principalId: string; personId: string };
let B_other: string;
let staffPrincipalA: ScopeSettings;
let tables: { schema: string; name: string; hasPatientId: boolean; q: string }[] = [];
const reservation: { A?: string; B?: string } = {};
const seedRows: Record<string, string> = {};

const sa = (sql: string, p: unknown[] = []): Promise<void> => saWrite(t.k, sql, p);
const saRows = async <T = Row>(sql: string, p: unknown[] = []): Promise<T[]> =>
  (await t.k.sa.query(sql, p)).rows as T[];
const uid = (): string => randomUUID();
/** An appointment in a given state, written directly the way the booking service leaves the database: occupancy and reservation in one transaction. */
const seedVisit = async (
  pid: string,
  doctorId: string,
  status: string,
  mode: 'in_person' | 'video',
  startDays: number,
): Promise<string> => {
  const rid = uid();
  const start = slotStart(startDays);
  const end = new Date(start.getTime() + 30 * 60_000);
  await t.k.sa.query('BEGIN');
  try {
    await t.k.sa.query(
      `SELECT set_config('app.org_id', $1, true), set_config('app.audience', 'system', true)`,
      [ORG],
    );
    await t.k.sa.query(
      `INSERT INTO scheduling.slot_occupancy (id, organisation_id, location_id, clinician_principal_id, period, status)
            VALUES ($1,$2,$3,$4,tstzrange($5::timestamptz,$6::timestamptz,'[)'),$7)`,
      [rid, ORG, A1, doctorId, start.toISOString(), end.toISOString(), status],
    );
    await t.k.sa.query(
      `INSERT INTO scheduling.slot_reservation (id, organisation_id, patient_id, service_id, location_id, clinician_principal_id, mode, booked_by_principal_id, booked_via)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$6,'staff')`,
      [rid, ORG, pid, SVC, A1, doctorId, mode],
    );
    await t.k.sa.query('COMMIT');
  } catch (e) {
    await t.k.sa.query('ROLLBACK');
    throw e;
  }
  return rid;
};
/** A superuser write with user triggers off for that statement only: the fixture states a mid-lifecycle row that a guard admits only through several role-specific steps. */
const replicaWrite = async (sql: string, p: unknown[] = []): Promise<void> => {
  await t.k.sa.query('BEGIN');
  try {
    await t.k.sa.query(
      `SELECT set_config('app.org_id', $1, true), set_config('app.audience', 'system', true)`,
      [ORG],
    );
    await t.k.sa.query(`SET LOCAL session_replication_role = replica`);
    await t.k.sa.query(sql, p);
    await t.k.sa.query('COMMIT');
  } catch (e) {
    await t.k.sa.query('ROLLBACK');
    throw e;
  }
};
const saStaffWrite = async (principalId: string, sql: string, p: unknown[] = []): Promise<void> => {
  await t.k.sa.query(
    `SELECT set_config('app.org_id', $1, false), set_config('app.audience', 'staff', false), set_config('app.realm', 'google', false), set_config('app.principal_id', $2, false)`,
    [ORG, principalId],
  );
  try {
    await t.k.sa.query(sql, p);
  } finally {
    await t.k.sa.query(
      `SELECT set_config('app.org_id', '', false), set_config('app.audience', '', false), set_config('app.realm', '', false), set_config('app.principal_id', '', false)`,
    );
  }
};

before(async () => {
  t = await setupScheduling('rlsm');
  A = await t.mkPatient(1);
  A_other = await t.mkPatient(2);
  B = await registerViaApi(t.k, t.deskB1, B1, {
    givenName: 'Given77',
    familyName: 'Family77',
    dateOfBirth: '1991-02-03',
    phone: '+12125551077',
    email: 'person77@example.test',
  });
  const la = await patientAccount(t.k, A, 'Patient A account');
  const lb = await patientAccount(t.k, B, 'Patient B account');
  linkA = la.seeded;
  linkB = lb.seeded;
  const doc = await t.doctor();
  proxyA = (await patientAccount(t.k, undefined, 'Proxy of A')).seeded;
  proxyB = (await patientAccount(t.k, undefined, 'Proxy of B')).seeded;
  unlinked = (await patientAccount(t.k, undefined, 'Unlinked patient account')).seeded;
  B_other = await registerViaApi(t.k, t.deskB1, B1, {
    givenName: 'Given78',
    familyName: 'Family78',
    dateOfBirth: '1962-07-08',
    phone: '+12125551078',
    email: 'person78@example.test',
  });
  const admin = await t.k.sa.query(`SELECT 1`); // keep the connection warm
  void admin;
  staffPrincipalA = await t.staffScope([A1]);

  // Child rows for patient A and patient B (one of each table), written by the superuser under the settings of a system job.
  for (const [tag, pid, account, loc] of [
    ['A', A, linkA, A1],
    ['B', B, linkB, B1],
  ] as const) {
    const n = tag === 'A' ? 1 : 2;
    await sa(
      `INSERT INTO patient.patient_contact (id, organisation_id, patient_id, kind, name) VALUES ($1,$2,$3,'emergency','Contact ${tag}')`,
      [uid(), ORG, pid],
    );
    seedRows['patient_contact' + tag] = pid;
    await sa(
      `INSERT INTO patient.consent (id, organisation_id, patient_id, template_key, template_version, template_language) VALUES ($1,$2,$3,'privacy_notice',1,'en')`,
      [uid(), ORG, pid],
    );
    await sa(
      `INSERT INTO patient.insurance_coverage (id, organisation_id, patient_id, payer_name, member_id) VALUES ($1,$2,$3,'Payer ${tag}','MEMBER-${tag}-123')`,
      [uid(), ORG, pid],
    );
    await sa(
      `INSERT INTO patient.communication_preference (patient_id, organisation_id, channels, language) VALUES ($1,$2,ARRAY['email','in_app'],'en')`,
      [pid, ORG],
    );
    await sa(
      `INSERT INTO patient.care_team_member (id, organisation_id, patient_id, principal_id, role) VALUES ($1,$2,$3,$4,'clinician')`,
      [uid(), ORG, pid, doc.principalId],
    );
    if (tag === 'A')
      await sa(
        `INSERT INTO patient.duplicate_flag (id, organisation_id, patient_id, candidate_patient_id, strength, source) VALUES ($1,$2,$3,$4,'probable','front_desk')`,
        [uid(), ORG, A, A_other],
      );
    else
      await sa(
        `INSERT INTO patient.duplicate_flag (id, organisation_id, patient_id, candidate_patient_id, strength, source) VALUES ($1,$2,$3,$4,'probable','front_desk')`,
        [uid(), ORG, B, B_other],
      );
    await sa(
      `INSERT INTO identity.proxy_grant (id, organisation_id, proxy_principal_id, patient_id, relationship, patient_display_name) VALUES ($1,$2,$3,$4,'parent','Child ${tag}')`,
      [uid(), ORG, (tag === 'A' ? proxyA : proxyB).principalId, pid],
    );
    const nid = uid();
    await sa(
      `INSERT INTO notifications.notification (id, organisation_id, recipient_kind, patient_id, template_key, template_version, channel, dedupe_key)
              VALUES ($1,$2,'patient',$3,'appointment.reminder',1,'email',$4)`,
      [nid, ORG, pid, `rm:matrix-${tag}`],
    );
    await sa(
      `INSERT INTO notifications.delivery_receipt (id, organisation_id, notification_id, patient_id, status, received_at, vendor_event_id) VALUES ($1,$2,$3,$4,'delivered',now(),$5)`,
      [uid(), ORG, nid, pid, `ev-${tag}-${n}`],
    );
    await sa(
      `INSERT INTO notifications.in_app_read (notification_id, organisation_id, patient_id) VALUES ($1,$2,$3)`,
      [nid, ORG, pid],
    );
    await sa(
      `INSERT INTO audit.btg_grant (id, organisation_id, holder_principal_id, holder_person_id, holder_realm, patient_id, reason, expires_at)
              VALUES ($1,$2,$3,$4,'google',$5,'Break glass for the matrix, synthetic',now() + interval '1 hour')`,
      [uid(), ORG, doc.principalId, doc.personId, pid],
    );
    void account;
    void loc;
  }
  // A hold (slot_reservation + occupancy twin) for each patient through the real service.
  const meta = {
    get requestId(): string {
      return randomUUID();
    },
  };
  for (const [tag, pid] of [
    ['A', A],
    ['B', B],
  ] as const) {
    const d = await t.doctor();
    const scope = await t.patientScope(pid);
    const h = await t.as(scope, (tx) =>
      t.svc.hold(tx, meta, {
        patientId: pid,
        serviceId: SVC,
        locationId: tag === 'A' ? A1 : A1,
        clinicianId: d.principalId,
        startsAt: slotStart(30 + (tag === 'A' ? 0 : 1)).toISOString(),
        mode: 'in_person',
      }),
    );
    reservation[tag] =
      (h as unknown as { id?: string; reservationId?: string }).id ??
      (h as unknown as { reservationId: string }).reservationId;
  }

  // INT02-R4-F01: the M3 tables (documents, staff alerts, check-in/queue/waitlist, telehealth) for patient A and patient B, so that no
  // matrix cell is vacuous. Written by the superuser; one row per table per patient, keyed to the hold made above.
  for (const [tag, pid, account] of [
    ['A', A, linkA],
    ['B', B, linkB],
  ] as const) {
    // Two visits of their own (the holds above stay as the set_status tests expect them): one checked in, one by video.
    const visitDoc = await t.doctor();
    const resId = await seedVisit(
      pid,
      visitDoc.principalId,
      'checked_in',
      'in_person',
      40 + (tag === 'A' ? 0 : 1),
    );
    const videoId = await seedVisit(
      pid,
      visitDoc.principalId,
      'confirmed',
      'video',
      50 + (tag === 'A' ? 0 : 1),
    );
    const docId = uid();
    await sa(
      `INSERT INTO documents.document (id, organisation_id, patient_id, classification, status, uploaded_by, upload_channel)
            VALUES ($1,$2,$3,'insurance_card','awaiting_upload',$4,'staff')`,
      [docId, ORG, pid, doc.principalId],
    );
    await sa(
      `INSERT INTO documents.document_version (document_id, version, organisation_id, patient_id, object_key, bucket, size_bytes, content_type, declared_content_type)
            VALUES ($1,1,$2,$3,$4,'quarantine',1024,'application/pdf','application/pdf')`,
      [docId, ORG, pid, `q/${randomUUID().replaceAll('-', '')}`],
    );
    // The hold trigger accepts a placement only from a Google-realm staff caller, so the fixture writes it under those settings.
    await saStaffWrite(
      doc.principalId,
      `INSERT INTO documents.legal_hold (id, organisation_id, document_id, patient_id, action, reason, by_person_id)
            VALUES ($1,$2,$3,$4,'placed','Legal hold for the matrix, synthetic',$5)`,
      [uid(), ORG, docId, pid, doc.personId],
    );
    await sa(
      `INSERT INTO documents.deletion_request (id, organisation_id, document_id, patient_id, requested_by)
            VALUES ($1,$2,$3,$4,$5)`,
      [uid(), ORG, docId, pid, account.principalId],
    );
    const alertId = uid();
    await sa(
      `INSERT INTO notifications.staff_alert (id, organisation_id, type, severity, patient_id, resource_type, resource_id, target_kind, target_principal_ids)
            VALUES ($1,$2,'red_flag','high',$3,'questionnaire_response',$4,'principal',ARRAY[$5]::uuid[])`,
      [alertId, ORG, pid, uid(), doc.principalId],
    );
    await sa(
      `INSERT INTO notifications.staff_alert_event (id, organisation_id, alert_id, patient_id, kind) VALUES ($1,$2,$3,$4,'created')`,
      [uid(), ORG, alertId, pid],
    );
    await sa(
      `INSERT INTO scheduling.check_in (id, organisation_id, patient_id, location_id, method, by_principal_id, previsit_status)
            VALUES ($1,$2,$3,$4,'desk',$5,'{"questionnaire":true,"consents":true,"insurance":true}')`,
      [resId, ORG, pid, A1, doc.principalId],
    );
    await sa(
      `INSERT INTO scheduling.queue_entry (id, organisation_id, patient_id, location_id, stage) VALUES ($1,$2,$3,$4,'waiting')`,
      [resId, ORG, pid, A1],
    );
    const wlId = uid();
    await sa(
      `INSERT INTO scheduling.waitlist_entry (id, organisation_id, patient_id, service_id, "window")
            VALUES ($1,$2,$3,$4,tstzrange(now() + interval '10 days', now() + interval '11 days'))`,
      [wlId, ORG, pid, SVC],
    );
    await sa(
      `INSERT INTO scheduling.waitlist_offer (id, organisation_id, waitlist_entry_id, patient_id, occupancy_id, expires_at)
            VALUES ($1,$2,$3,$4,$5,now() + interval '1 day')`,
      [uid(), ORG, wlId, pid, resId],
    );
    const sessId = uid();
    await sa(
      `INSERT INTO telehealth.video_session (id, organisation_id, reservation_id, patient_id, clinician_principal_id) VALUES ($1,$2,$3,$4,$5)`,
      [sessId, ORG, videoId, pid, visitDoc.principalId],
    );
    const partId = uid();
    await sa(
      `INSERT INTO telehealth.participant (id, organisation_id, session_id, patient_id, role, principal_id) VALUES ($1,$2,$3,$4,'patient',$5)`,
      [partId, ORG, sessId, pid, account.principalId],
    );
    // A join token needs an admitted participant of a session with a meeting: the session gets its meeting, the participant is admitted.
    await sa(
      `UPDATE telehealth.video_session SET vendor = 'fakevendor', vendor_meeting_id = $2 WHERE id = $1`,
      [sessId, `meeting-${tag}`],
    );
    await sa(
      `UPDATE telehealth.participant SET admission = 'admitted', admitted_at = now(), admitted_by = $2 WHERE id = $1`,
      [partId, visitDoc.principalId],
    );
    await sa(
      `INSERT INTO telehealth.join_token (id, organisation_id, session_id, participant_id, patient_id, principal_id, expires_at)
            VALUES ($1,$2,$3,$4,$5,$6,now() + interval '10 minutes')`,
      [uid(), ORG, sessId, partId, pid, account.principalId],
    );
    await sa(
      `INSERT INTO telehealth.location_confirmation (id, organisation_id, reservation_id, patient_id, principal_id, stated_state, result)
            VALUES ($1,$2,$3,$4,$5,'${FIXTURE_STATES.licensed}','allowed')`,
      [uid(), ORG, videoId, pid, account.principalId],
    );
  }

  // INT03-F08c: the M4 tables (clinical chart, front door, notes, messaging, privacy) for patient A and patient B, so that no matrix cell is
  // vacuous. Written by the superuser; one row per table per patient. Where a guard trigger only admits the state through a multi-step,
  // role-specific path (privacy requests and export packages), the fixture writes the final state with user triggers off for that one
  // statement (session_replication_role = replica, superuser only); the table's constraints and row-level security still apply to every read.
  for (const [tag, pid, account, loc] of [
    ['A', A, linkA, A1],
    ['B', B, linkB, B1],
  ] as const) {
    const clin = await t.doctor();
    const cp = clin.principalId;
    await sa(
      `INSERT INTO clinical.problem (id, organisation_id, patient_id, display, coded, recorded_by) VALUES ($1,$2,$3,'Problem ${tag}',false,$4)`,
      [uid(), ORG, pid, cp],
    );
    await sa(
      `INSERT INTO clinical.allergy (id, organisation_id, patient_id, display, coded, category, recorded_by) VALUES ($1,$2,$3,'Allergy ${tag}',false,'drug',$4)`,
      [uid(), ORG, pid, cp],
    );
    await sa(
      `INSERT INTO clinical.medication_statement (id, organisation_id, patient_id, display, coded, recorded_by) VALUES ($1,$2,$3,'Medication ${tag}',false,$4)`,
      [uid(), ORG, pid, cp],
    );
    await sa(
      `INSERT INTO clinical.vital_sign (id, organisation_id, patient_id, loinc_code, value, unit, range_status, measured_at, by_principal_id)
            VALUES ($1,$2,$3,'8867-4',72,'/min','no_range',now(),$4)`,
      [uid(), ORG, pid, cp],
    );
    const encId = uid();
    await sa(
      `INSERT INTO clinical.encounter (id, organisation_id, patient_id, location_id, clinician_principal_id, mode, status, started_at) VALUES ($1,$2,$3,$4,$5,'in_person','in_consultation',now())`,
      [encId, ORG, pid, loc, cp],
    );
    await sa(
      `INSERT INTO clinical.consent_exception (id, organisation_id, encounter_id, patient_id, missing_templates, reason, by_principal_id)
            VALUES ($1,$2,$3,$4,ARRAY['privacy_notice'],'Consent deferred for the matrix, synthetic',$5)`,
      [uid(), ORG, encId, pid, cp],
    );
    // A co-signed note and its addendum: the guards admit these only through the sign and co-sign steps of two roles, so the final state is written directly.
    const noteId = uid();
    const supervisor = await t.doctor();
    await replicaWrite(
      `INSERT INTO clinical.note (id, organisation_id, encounter_id, patient_id, author_principal_id, template_id, body, status, submitted_for_cosign_at, cosign_required_from, signed_at, signed_by)
            VALUES ($1,$2,$3,$4,$5,'soap','{}'::jsonb,'signed',now(),$6,now(),$6)`,
      [noteId, ORG, encId, pid, cp, supervisor.principalId],
    );
    await replicaWrite(
      `INSERT INTO clinical.note_cosign (note_id, organisation_id, patient_id, supervisor_principal_id) VALUES ($1,$2,$3,$4)`,
      [noteId, ORG, pid, supervisor.principalId],
    );
    await replicaWrite(
      `INSERT INTO clinical.note_addendum (id, organisation_id, note_id, patient_id, author_principal_id, body) VALUES ($1,$2,$3,$4,$5,'Addendum for the matrix, synthetic')`,
      [uid(), ORG, noteId, pid, cp],
    );
    await sa(
      `INSERT INTO clinical.follow_up (id, organisation_id, patient_id, location_id, requested_by, due_on, reason)
            VALUES ($1,$2,$3,$4,$5,current_date + 14,'Follow-up for the matrix, synthetic')`,
      [uid(), ORG, pid, loc, cp],
    );
    await sa(
      `INSERT INTO clinical.questionnaire_response (id, organisation_id, patient_id, template_key, template_version, answers) VALUES ($1,$2,$3,'previsit',1,'{}'::jsonb)`,
      [uid(), ORG, pid],
    );
    await sa(
      `INSERT INTO clinical.referral (id, organisation_id, patient_id, from_location_id, from_principal_id, target_kind, target_external_text, reason)
            VALUES ($1,$2,$3,$4,$5,'external','External clinic, synthetic','Referral for the matrix, synthetic')`,
      [uid(), ORG, pid, loc, cp],
    );
    const triageVisit = await seedVisit(
      pid,
      cp,
      'checked_in',
      'in_person',
      60 + (tag === 'A' ? 0 : 1),
    );
    await sa(
      `INSERT INTO clinical.triage_assessment (id, organisation_id, check_in_id, patient_id, location_id, category, by_principal_id)
            VALUES ($1,$2,$3,$4,$5,'standard',$6)`,
      [uid(), ORG, triageVisit, pid, loc, cp],
    );
    // Messaging guards bind a thread, message and task to the calling principal's session; the fixture states the rows directly.
    const threadId = uid();
    await replicaWrite(
      `INSERT INTO messaging.thread (id, organisation_id, kind, patient_id, subject, location_id, created_by) VALUES ($1,$2,'patient',$3,'Thread ${tag}',$4,$5)`,
      [threadId, ORG, pid, loc, cp],
    );
    await replicaWrite(
      `INSERT INTO messaging.message (id, organisation_id, thread_id, patient_id, author_principal_id, body) VALUES ($1,$2,$3,$4,$5,'Message for the matrix, synthetic')`,
      [uid(), ORG, threadId, pid, cp],
    );
    await replicaWrite(
      `INSERT INTO messaging.task (id, organisation_id, patient_id, title, assignee_kind, assignee_principal_id, created_by)
            VALUES ($1,$2,$3,'Task ${tag}','principal',$4,$4)`,
      [uid(), ORG, pid, cp],
    );
    const reqId = uid();
    await sa(
      `INSERT INTO privacy.request (id, organisation_id, patient_id, kind, requested_by_principal_id, channel, due_at)
            VALUES ($1,$2,$3,'access',$4,'portal',now() + interval '30 days')`,
      [reqId, ORG, pid, account.principalId],
    );
    await replicaWrite(
      `UPDATE privacy.request SET status = 'in_progress', verification_method = 'synthetic check', verified_by_person_id = $2, verified_at = now(),
              decided_by_person_id = $2, decided_at = now() WHERE id = $1`,
      [reqId, clin.personId],
    );
    await sa(
      `INSERT INTO privacy.export_package (id, organisation_id, request_id, patient_id) VALUES ($1,$2,$3,$4)`,
      [uid(), ORG, reqId, pid],
    );
    const incId = uid();
    await sa(
      `INSERT INTO privacy.incident (id, organisation_id, title, description, severity, discovered_at)
            VALUES ($1,$2,'Incident ${tag}','Incident for the matrix, synthetic','low',now())`,
      [incId, ORG],
    );
    await sa(
      `INSERT INTO privacy.incident_patient (incident_id, patient_id, organisation_id) VALUES ($1,$2,$3)`,
      [incId, pid, ORG],
    );
  }

  // The tables under test: every table with row-level security, from the catalogue (not from a list in this file).
  const rows = await saRows<{ s: string; t: string; pid: boolean }>(
    `SELECT n.nspname AS s, c.relname AS t,
            EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'patient_id' AND NOT a.attisdropped) AS pid
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p') AND c.relrowsecurity AND n.nspname NOT IN ('queue', 'graphile_worker', 'pg_catalog', 'information_schema')
      ORDER BY 1, 2`,
  );
  tables = rows.map((r) => ({
    schema: r.s,
    name: r.t,
    hasPatientId: r.pid || (r.s === 'patient' && r.t === 'patient'),
    q: `${r.s}.${r.t}`,
  }));
});
after(async () => {
  await t?.close();
});

const patientCol = (tb: { schema: string; name: string }): string =>
  tb.schema === 'patient' && tb.name === 'patient' ? 'id' : 'patient_id';

// ---------------------------------------------------------------------------------------------------------------------------------
// (1) The callers: every audience and realm, and who each may legitimately see.
// ---------------------------------------------------------------------------------------------------------------------------------
interface CallerSpec {
  name: string;
  db: 'app_api' | 'app_worker';
  settings: () => ScopeSettings | null;
  /** Patients this caller may legitimately see rows of. Every other patient must show 0 rows in every table. */
  own: () => string[];
  /** Tables (schema.table) that are this caller's by design and therefore not subject to the per-patient rule. */
  exempt?: string[];
}
const staff = (locs: string[], extra: Partial<ScopeSettings> = {}): ScopeSettings => ({
  audience: 'staff',
  realm: 'google',
  orgId: ORG,
  principalId: staffPrincipalA.principalId as string,
  personId: staffPrincipalA.personId as string,
  locationIds: locs,
  ...extra,
});
const CALLERS: CallerSpec[] = [
  {
    name: 'staff of location A1',
    db: 'app_api',
    settings: () => staff([A1]),
    own: () => [A, A_other],
  },
  {
    name: 'staff of location A2 (second location, same organisation)',
    db: 'app_api',
    settings: () => staff([A2]),
    own: () => [],
  },
  {
    name: 'staff of location B1 (second clinic)',
    db: 'app_api',
    settings: () => staff([B1]),
    own: () => [B, B_other],
  },
  {
    name: 'staff of A1 and B1',
    db: 'app_api',
    settings: () => staff([A1, B1]),
    own: () => [A, A_other, B, B_other],
  },
  { name: 'staff with no location', db: 'app_api', settings: () => staff([]), own: () => [] },
  {
    name: 'staff of another organisation',
    db: 'app_api',
    settings: () => staff([A1], { orgId: ORG2 }),
    own: () => [],
  },
  {
    name: 'patient A (own account)',
    db: 'app_api',
    settings: () => ({
      audience: 'patient',
      realm: 'patient_pool',
      orgId: ORG,
      principalId: linkA.principalId,
      personId: linkA.personId,
      patientIds: [A],
    }),
    own: () => [A],
  },
  {
    name: 'patient B_other without a link (second patient at B1)',
    db: 'app_api',
    settings: () => ({
      audience: 'patient',
      realm: 'patient_pool',
      orgId: ORG,
      principalId: unlinked.principalId,
      personId: unlinked.personId,
      patientIds: [B_other],
    }),
    own: () => [B_other],
  },
  {
    name: 'patient B (second patient)',
    db: 'app_api',
    settings: () => ({
      audience: 'patient',
      realm: 'patient_pool',
      orgId: ORG,
      principalId: linkB.principalId,
      personId: linkB.personId,
      patientIds: [B],
    }),
    own: () => [B],
  },
  {
    name: 'patient without any link',
    db: 'app_api',
    settings: () => ({
      audience: 'patient',
      realm: 'patient_pool',
      orgId: ORG,
      principalId: unlinked.principalId,
      personId: unlinked.personId,
      patientIds: [],
    }),
    own: () => [],
  },
  {
    name: 'proxy of patient B',
    db: 'app_api',
    settings: () => ({
      audience: 'patient',
      realm: 'patient_pool',
      orgId: ORG,
      principalId: proxyB.principalId,
      personId: proxyB.personId,
      patientIds: [B],
      proxyPatientIds: [B],
    }),
    own: () => [B],
  },
  {
    name: 'admin_pool, no break-glass, no slice',
    db: 'app_api',
    settings: () => ({
      audience: 'staff',
      realm: 'admin_pool',
      orgId: ORG,
      principalId: staffPrincipalA.principalId as string,
      phiAccess: 'off',
    }),
    own: () => [],
    exempt: [
      'audit.event',
      'audit.btg_grant',
      'audit.btg_review',
      'audit.anchor',
      'audit.anchor_archive_receipt',
      'audit.export_job',
    ],
  },
  {
    name: 'admin_pool, phi_access limited, patient_label slice',
    db: 'app_api',
    settings: () => ({
      audience: 'staff',
      realm: 'admin_pool',
      orgId: ORG,
      principalId: staffPrincipalA.principalId as string,
      phiAccess: 'limited',
      complianceScopes: ['patient_label'],
    }),
    own: () => [],
    exempt: [
      'audit.event',
      'audit.btg_grant',
      'audit.btg_review',
      'audit.anchor',
      'audit.anchor_archive_receipt',
      'audit.export_job',
    ],
  },
  {
    name: 'partner',
    db: 'app_api',
    settings: () => ({ audience: 'partner', realm: 'partner_pool', orgId: ORG }),
    own: () => [],
  },
  {
    name: 'public',
    db: 'app_api',
    settings: () => ({ audience: 'public', orgId: ORG }),
    own: () => [],
  },
  {
    name: 'anonymous',
    db: 'app_api',
    settings: () => ({ audience: 'anonymous', orgId: ORG }),
    own: () => [],
  },
  {
    name: 'audience unset (webhook transaction)',
    db: 'app_api',
    settings: () => null,
    own: () => [],
  },
  {
    name: 'staff without an organisation',
    db: 'app_api',
    settings: () => {
      const s = staff([A1]);
      delete (s as { orgId?: string }).orgId;
      return s;
    },
    own: () => [],
  },
  {
    name: 'worker, system, patients-scope job for B',
    db: 'app_worker',
    settings: () => ({
      audience: 'system',
      realm: 'worker',
      orgId: ORG,
      jobScope: 'patients',
      jobPatientIds: [B],
    }),
    own: () => [B],
  },
  {
    name: 'worker, system, patients-scope job for A',
    db: 'app_worker',
    settings: () => ({
      audience: 'system',
      realm: 'worker',
      orgId: ORG,
      jobScope: 'patients',
      jobPatientIds: [A],
    }),
    own: () => [A],
  },
];

/** Tables whose rows may be seen with no organisation, anonymous or public by design (ARCHITECTURE 21.3 list); anything else is a defect. */
const PRE_AUTH_TABLES = new Set([
  'identity.session',
  'identity.person',
  'identity.principal',
  'identity.admin_credential',
  'identity.enrolment_token',
  'identity.webauthn_challenge',
  'kernel.rate_counter',
  'kernel.setting',
]);

// ---------------------------------------------------------------------------------------------------------------------------------
// (2) The matrix
// ---------------------------------------------------------------------------------------------------------------------------------
describe('AN-1 behavioural row-visibility matrix: one row per table with RLS, run as every audience and realm', () => {
  const matrix: Record<
    string,
    Record<string, { A?: Cell; A_other?: Cell; B?: Cell; all?: Cell }>
  > = {};

  test('the catalogue has the expected shape and every patient table holds a row for patient A and for patient B (no vacuous cell)', async () => {
    assert.ok(
      tables.length >= 50,
      `expected the 60+ tables with row-level security, found ${tables.length}`,
    );
    const pidTables = tables.filter((x) => x.hasPatientId);
    assert.ok(
      pidTables.length >= 17,
      `expected at least 17 patient-keyed tables, found ${pidTables.length}`,
    );
    const empty: string[] = [];
    for (const tb of pidTables) {
      const r = await saRows<{ a: string; b: string }>(
        `SELECT count(*) FILTER (WHERE ${patientCol(tb)} = $1)::text AS a, count(*) FILTER (WHERE ${patientCol(tb)} = $2)::text AS b FROM ${tb.q}`,
        [A, B],
      );
      const row = r[0] as { a: string; b: string };
      if (Number(row.a) === 0 || Number(row.b) === 0)
        empty.push(`${tb.q} (A=${row.a}, B=${row.b})`);
    }
    // audit.event and the merge-only tables carry rows of their own kind; each must still have rows for both patients.
    assert.deepEqual(
      empty,
      [],
      `tables without a seeded row for both patients make a 0 meaningless: ${empty.join('; ')}`,
    );
  });

  for (const caller of CALLERS) {
    test(`as ${caller.name}: no row of a patient outside its scope is visible in any table`, async () => {
      const c = await new Caller(t, caller.db, caller.settings()).open();
      const bad: string[] = [];
      const row: Record<string, { A?: Cell; A_other?: Cell; B?: Cell; all?: Cell }> = {};
      try {
        const own = new Set(caller.own());
        for (const tb of tables) {
          const cell: { A?: Cell; A_other?: Cell; B?: Cell; all?: Cell } = {};
          if (tb.hasPatientId) {
            const col = patientCol(tb);
            for (const [k, pid] of [
              ['A', A],
              ['A_other', A_other],
              ['B', B],
            ] as const) {
              cell[k] = await c.count(`SELECT count(*)::int AS n FROM ${tb.q} WHERE ${col} = $1`, [
                pid,
              ]);
              const outside = !own.has(pid);
              const exempt = caller.exempt?.includes(tb.q) === true;
              if (outside && !exempt && typeof cell[k] === 'number' && (cell[k] as number) > 0)
                bad.push(`${tb.q}: ${cell[k]} row(s) of patient ${k}`);
            }
          } else {
            cell.all = await c.count(`SELECT count(*)::int AS n FROM ${tb.q}`);
          }
          row[tb.q] = cell;
        }
        // Pre-authentication and tenant-less callers see no row of any table beyond the closed list.
        if (
          [
            'anonymous',
            'public',
            'audience unset (webhook transaction)',
            'staff without an organisation',
            'staff of another organisation',
          ].includes(caller.name)
        ) {
          for (const tb of tables) {
            if (PRE_AUTH_TABLES.has(tb.q)) continue;
            const n = await c.count(`SELECT count(*)::int AS n FROM ${tb.q}`);
            if (typeof n === 'number' && n > 0)
              bad.push(
                `${tb.q}: ${n} row(s) with no right to any (pre-authentication or no tenant)`,
              );
          }
        }
      } finally {
        await c.close();
      }
      matrix[caller.name] = row;
      assert.deepEqual(bad, [], `${caller.name}:\n  ${bad.join('\n  ')}`);
    });
  }

  test('positive control: staff of A1 reads its own patients in each T-STAFF table, staff of B1 reads its own (the matrix is not passing because nothing is readable)', async () => {
    const tstaff = [
      'patient.patient_contact',
      'patient.consent',
      'patient.insurance_coverage',
      'patient.communication_preference',
      'patient.care_relationship',
      'patient.care_team_member',
      'patient.duplicate_flag',
      'identity.proxy_grant',
      'notifications.notification',
      'notifications.delivery_receipt',
      'patient.patient',
      'patient.staff_scope',
      // INT02-R4-F01: the M3 tables, now seeded for both patients
      'documents.document',
      'documents.document_version',
      'documents.legal_hold',
      'documents.deletion_request',
      'scheduling.check_in',
      'scheduling.queue_entry',
      'scheduling.waitlist_entry',
      'scheduling.waitlist_offer',
      'telehealth.video_session',
      'telehealth.participant',
      'telehealth.join_token',
      'telehealth.location_confirmation',
    ];
    const cA = await new Caller(t, 'app_api', staff([A1])).open();
    const cB = await new Caller(t, 'app_api', staff([B1])).open();
    const missing: string[] = [];
    try {
      for (const q of tstaff) {
        const tb = tables.find((x) => x.q === q) as (typeof tables)[number];
        const col = patientCol(tb);
        if ((await cA.count(`SELECT count(*)::int AS n FROM ${q} WHERE ${col} = $1`, [A])) === 0)
          missing.push(`${q}: staff A1 sees nothing of A`);
        if ((await cB.count(`SELECT count(*)::int AS n FROM ${q} WHERE ${col} = $1`, [B])) === 0)
          missing.push(`${q}: staff B1 sees nothing of B`);
      }
    } finally {
      await cA.close();
      await cB.close();
    }
    assert.deepEqual(missing, []);
  });

  test('positive control: a patients-scope worker job reads the staff alert and its events of its own patient only (staff reach alerts through staff_scope_allows_patient, which is a stub returning false on this candidate)', async () => {
    const seen: string[] = [];
    for (const [tag, own, other] of [
      ['A', A, B],
      ['B', B, A],
    ] as const) {
      const c = await new Caller(t, 'app_worker', {
        audience: 'system',
        realm: 'worker',
        orgId: ORG,
        jobScope: 'patients',
        jobPatientIds: [own],
      }).open();
      try {
        for (const q of ['notifications.staff_alert', 'notifications.staff_alert_event']) {
          const sql = `SELECT count(*)::int AS n FROM ${q} WHERE patient_id = $1`;
          if ((await c.count(sql, [own])) !== 1)
            seen.push(`${q}: job for ${tag} cannot read ${tag}`);
          if ((await c.count(sql, [other])) !== 0)
            seen.push(`${q}: job for ${tag} reads the other patient`);
        }
      } finally {
        await c.close();
      }
    }
    assert.deepEqual(seen, []);
  });

  after(() => {
    const file = process.env['EHR_MATRIX_REPORT'];
    if (file !== undefined && file !== '')
      writeFileSync(file, JSON.stringify({ tables: tables.map((x) => x.q), matrix }, null, 2));
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// (3) Direct SQL writes as the other clinic (F01 reproduction statements, rolled back)
// ---------------------------------------------------------------------------------------------------------------------------------
describe('direct-SQL writes as staff of the second clinic change nothing of patient A (F01 statements)', () => {
  const cases: { name: string; sql: string }[] = [
    {
      name: 'withdraw a consent',
      sql: `UPDATE patient.consent SET status = 'withdrawn', withdrawn_at = now() WHERE patient_id = $1`,
    },
    {
      name: 'update insurance',
      sql: `UPDATE patient.insurance_coverage SET active = false WHERE patient_id = $1`,
    },
    { name: 'delete a contact', sql: `DELETE FROM patient.patient_contact WHERE patient_id = $1` },
    {
      name: 'update a contact',
      sql: `UPDATE patient.patient_contact SET name = 'Overwritten' WHERE patient_id = $1`,
    },
    {
      name: 'update a care-team member',
      sql: `UPDATE patient.care_team_member SET role = 'nurse' WHERE patient_id = $1`,
    },
    {
      name: 'update a duplicate flag',
      sql: `UPDATE patient.duplicate_flag SET status = 'not_duplicate', resolved_reason = 'staff' WHERE patient_id = $1`,
    },
    {
      name: 'cancel a notification',
      sql: `UPDATE notifications.notification SET status = 'cancelled' WHERE patient_id = $1`,
    },
  ];
  for (const k of cases)
    test(`staff of B1: ${k.name} of patient A touches 0 rows`, async () => {
      const c = await new Caller(t, 'app_api', staff([B1])).open();
      try {
        const r = await c.run(k.sql, [A]);
        if ('error' in r) return; // refused outright is fine
        assert.equal(
          r.rowCount,
          0,
          `${k.name}: ${r.rowCount} row(s) of patient A changed by staff of another clinic`,
        );
      } finally {
        await c.close();
      }
    });
  test('staff of B1: inserts a care-team member, a consent and a contact for patient A are refused', async () => {
    const c = await new Caller(t, 'app_api', staff([B1])).open();
    try {
      const doc = (await t.doctor()).principalId;
      const ins = [
        await c.run(
          `INSERT INTO patient.care_team_member (id, organisation_id, patient_id, principal_id, role) VALUES ($1,$2,$3,$4,'nurse')`,
          [uid(), ORG, A, doc],
        ),
        await c.run(
          `INSERT INTO patient.consent (id, organisation_id, patient_id, template_key, template_version, template_language) VALUES ($1,$2,$3,'x',1,'en')`,
          [uid(), ORG, A],
        ),
        await c.run(
          `INSERT INTO patient.patient_contact (id, organisation_id, patient_id, kind, name) VALUES ($1,$2,$3,'emergency','Planted')`,
          [uid(), ORG, A],
        ),
      ];
      const names = ['care-team member', 'consent', 'contact'];
      const accepted = ins.flatMap((r, i) => ('error' in r ? [] : [names[i]]));
      assert.deepEqual(
        accepted,
        [],
        `inserts for another clinic patient accepted: ${accepted.join(', ')}`,
      );
    } finally {
      await c.close();
    }
  });
  test('the same kind of statement as staff of A1 does reach patient A (the statements are valid)', async () => {
    const c = await new Caller(t, 'app_api', staff([A1])).open();
    try {
      const r = await c.run(
        `UPDATE patient.insurance_coverage SET active = false WHERE patient_id = $1`,
        [A],
      );
      assert.ok(
        !('error' in r),
        `control statement failed: ${'error' in r ? r.error + ' ' + r.message : ''}`,
      );
      assert.equal((r as { rowCount: number }).rowCount, 1);
    } finally {
      await c.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// (4) TC-AZ-05, (5) TC-AZ-06
// ---------------------------------------------------------------------------------------------------------------------------------
describe('TC-AZ-05: direct DB connection as the reporting role and as the public and limited audiences', () => {
  test('reporting_ro is refused on every patient-keyed table and on the patient root, merge and booking tables', async () => {
    const c = await new Caller(t, 'reporting_ro', null).open();
    const allowed: string[] = [];
    try {
      for (const tb of tables.filter(
        (x) =>
          x.hasPatientId ||
          x.schema === 'patient' ||
          x.schema === 'scheduling' ||
          x.schema === 'notifications' ||
          x.q === 'audit.event',
      )) {
        const r = await c.run(`SELECT count(*) AS n FROM ${tb.q}`);
        if (!('error' in r)) allowed.push(`${tb.q} (${(r.rows[0] as Row)['n']} rows)`);
        else assert.equal(r.error, '42501', `${tb.q}: refused with ${r.error}, not 42501`);
      }
    } finally {
      await c.close();
    }
    assert.deepEqual(allowed, [], `reporting_ro can read: ${allowed.join(', ')}`);
  });
  test('reporting_ro cannot read the PHI views either (any view or materialized view in patient, scheduling, notifications, identity)', async () => {
    const views = await saRows<{ n: string }>(
      `SELECT n.nspname || '.' || c.relname AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('v', 'm') AND n.nspname IN ('patient', 'scheduling', 'notifications', 'audit')`,
    );
    const c = await new Caller(t, 'reporting_ro', null).open();
    const bad: string[] = [];
    try {
      for (const v of views) {
        const r = await c.run(`SELECT count(*) AS n FROM ${v.n}`);
        if (!('error' in r)) bad.push(v.n);
      }
    } finally {
      await c.close();
    }
    assert.deepEqual(bad, []);
  });
  for (const who of ['public', 'limited'] as const)
    test(`audience ${who} returns nothing from any patient-keyed table`, async () => {
      const s: ScopeSettings =
        who === 'public'
          ? { audience: 'public', orgId: ORG }
          : {
              audience: 'staff',
              realm: 'admin_pool',
              orgId: ORG,
              principalId: staffPrincipalA.principalId as string,
              phiAccess: 'limited',
              complianceScopes: ['patient_label'],
            };
      const c = await new Caller(t, 'app_api', s).open();
      const bad: string[] = [];
      try {
        for (const tb of tables.filter((x) => x.hasPatientId && !x.q.startsWith('audit.'))) {
          const n = await c.count(`SELECT count(*)::int AS n FROM ${tb.q}`);
          if (typeof n === 'number' && n > 0) bad.push(`${tb.q}: ${n}`);
        }
      } finally {
        await c.close();
      }
      assert.deepEqual(bad, []);
    });
});

describe('TC-AZ-06: SET ROLE to each function-owner role and select every patient-keyed table', () => {
  const roles = [
    'patient_scope_owner',
    'patient_match_owner',
    'scheduling_booking_owner',
    'integration_receiver_owner',
    'queue_owner',
    'identity_signin_ro',
    'directory_ro',
    // INT04-F02b (HEAAA-466): owns identity.bootstrap_admins; its policies are gated on current_user and audience `system`.
    'identity_bootstrap_owner',
  ];
  const ownerSettings: ScopeSettings = {
    audience: 'system',
    realm: 'worker',
    orgId: ORG,
    jobScope: 'org',
  };
  test('every table has FORCE ROW LEVEL SECURITY, so an owner role is subject to its policies', async () => {
    const r = await saRows<{ t: string }>(
      `SELECT n.nspname || '.' || c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r','p') AND c.relrowsecurity AND NOT c.relforcerowsecurity AND n.nspname NOT IN ('queue', 'graphile_worker')`,
    );
    assert.deepEqual(r, []);
  });
  for (const role of roles)
    test(`as ${role}: nothing of the patient tables beyond what its role-targeted policies and column grants allow`, async () => {
      const c = await new Caller(t, superUser(), ownerSettings, role).open();
      const seen: string[] = [];
      try {
        for (const tb of tables.filter((x) => x.hasPatientId)) {
          const r = await c.run(`SELECT count(*) AS n FROM ${tb.q}`);
          if (!('error' in r) && Number((r.rows[0] as Row)['n']) > 0)
            seen.push(`${tb.q}=${(r.rows[0] as Row)['n']}`);
        }
        const identity = await c.run(`SELECT * FROM patient.patient LIMIT 1`);
        if (role === 'patient_match_owner') {
          // Identity columns only: the whole-row select must be refused, the column list allowed.
          assert.ok(
            'error' in identity && identity.error === '42501',
            'patient_match_owner read whole patient rows',
          );
          const cols = await c.run(
            `SELECT count(*) AS n FROM (SELECT given_name, family_name, date_of_birth, mrn FROM patient.patient) x`,
          );
          assert.ok(
            !('error' in cols),
            'patient_match_owner cannot read the identity columns it needs',
          );
        }
      } finally {
        await c.close();
      }
      const allowedFor: Record<string, string[]> = {
        scheduling_booking_owner: ['scheduling.slot_reservation', 'patient.patient'], // the merge guard reads the patient root (SBR-12)
        patient_scope_owner: [
          'patient.staff_scope',
          'patient.care_relationship',
          'patient.patient',
          'patient.duplicate_flag',
          'patient.consent',
        ],
      };
      const unexpected = seen.filter(
        (s) => !(allowedFor[role] ?? []).some((a) => s.startsWith(a + '=')),
      );
      assert.deepEqual(unexpected, [], `${role} reads: ${unexpected.join(', ')}`);
    });
  // INT04-F02b (decision log test 9, "the M-5 behavioural check is extended with app_bootstrap and sees no rows"): the login role of the
  // bootstrap command holds no table privilege, so in the system audience, as every other, every table refuses or returns nothing.
  for (const audience of ['system', 'staff'] as const)
    test(`as the app_bootstrap login (audience ${audience}): no table of the matrix returns a row`, async () => {
      const settings: ScopeSettings =
        audience === 'system'
          ? ownerSettings
          : {
              audience: 'staff',
              realm: 'admin_pool',
              orgId: ORG,
              principalId: id(9901),
              phiAccess: 'limited',
              complianceScopes: [],
            };
      const c = await new Caller(t, 'app_bootstrap', settings).open();
      const seen: string[] = [];
      try {
        for (const tb of tables) {
          const r = await c.run(`SELECT count(*) AS n FROM ${tb.q}`);
          if (!('error' in r) && Number((r.rows[0] as Row)['n']) > 0)
            seen.push(`${tb.q}=${(r.rows[0] as Row)['n']}`);
        }
      } finally {
        await c.close();
      }
      assert.deepEqual(seen, []);
    });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// (6) TC-AZ-07: every definer function from every caller that should not hold it
// ---------------------------------------------------------------------------------------------------------------------------------
describe('TC-AZ-07: each definer function refuses the callers that must not hold it', () => {
  const uuidArr = (xs: string[]): string => `ARRAY[${xs.map((x) => `'${x}'`).join(',')}]::uuid[]`;
  const callerSet: Record<string, () => ScopeSettings | null> = {
    anonymous: () => ({ audience: 'anonymous', orgId: ORG }),
    public: () => ({ audience: 'public', orgId: ORG }),
    partner: () => ({ audience: 'partner', realm: 'partner_pool', orgId: ORG }),
    unset: () => null,
    patient: () => ({
      audience: 'patient',
      realm: 'patient_pool',
      orgId: ORG,
      principalId: linkB.principalId,
      personId: linkB.personId,
      patientIds: [B],
    }),
    'staff admin_pool': () => ({
      audience: 'staff',
      realm: 'admin_pool',
      orgId: ORG,
      principalId: staffPrincipalA.principalId as string,
      phiAccess: 'limited',
      complianceScopes: ['patient_label'],
    }),
    'staff google no location': () => staff([]),
    'system job_scope org': () => ({
      audience: 'system',
      realm: 'worker',
      orgId: ORG,
      jobScope: 'org',
    }),
    'system job_scope patients': () => ({
      audience: 'system',
      realm: 'worker',
      orgId: ORG,
      jobScope: 'patients',
      jobPatientIds: [B],
    }),
    'patient A': () => ({
      audience: 'patient',
      realm: 'patient_pool',
      orgId: ORG,
      principalId: linkA.principalId,
      personId: linkA.personId,
      patientIds: [A],
    }),
    'staff google A1': () => staff([A1]),
    'staff google B1': () => staff([B1]),
  };
  // Which callers must be refused. Everything not listed as entitled is refused; entitled-but-wrong-scope cases are in section (7) below.
  const everyone = Object.keys(callerSet);
  interface FnCase {
    fn: string;
    call: () => string;
    entitled: string[];
  }
  const fns: FnCase[] = [
    {
      fn: 'patient.request_merge',
      call: () => `SELECT patient.request_merge('${uid()}', '${A}', '${A_other}', 'dup')`,
      entitled: ['staff google A1', 'staff google B1'],
    },
    {
      fn: 'patient.get_merge_request',
      call: () => `SELECT * FROM patient.get_merge_request('${uid()}')`,
      entitled: ['staff google A1', 'staff google B1', 'staff google no location'],
    },
    {
      fn: 'patient.decide_merge',
      call: () => `SELECT patient.decide_merge('${uid()}', '${uid()}', 'approve')`,
      entitled: ['staff google A1', 'staff google B1'],
    },
    {
      fn: 'patient.load_merge_job',
      call: () => `SELECT * FROM patient.load_merge_job('${uid()}')`,
      entitled: ['system job_scope org'],
    },
    {
      fn: 'patient.begin_merge',
      call: () => `SELECT patient.begin_merge('${uid()}')`,
      entitled: ['system job_scope patients'],
    },
    {
      fn: 'patient.complete_merge',
      call: () => `SELECT patient.complete_merge('${uid()}', '{}'::jsonb, '{}'::jsonb)`,
      entitled: ['system job_scope patients'],
    },
    {
      fn: 'patient.fail_merge',
      call: () => `SELECT patient.fail_merge('${uid()}', 'x')`,
      entitled: ['system job_scope org'],
    },
    {
      fn: 'patient.verify_staff_scope',
      call: () => `SELECT * FROM patient.verify_staff_scope()`,
      entitled: ['system job_scope org'],
    },
    {
      fn: 'patient.lock_patients',
      call: () => `SELECT patient.lock_patients(${uuidArr([A])}, 'key_share')`,
      entitled: [
        'patient',
        'patient A',
        'staff google A1',
        'staff google B1',
        'staff google no location',
        'staff admin_pool',
        'system job_scope org',
        'system job_scope patients',
      ],
    },
    {
      fn: 'patient.end_care_relationship',
      call: () => `SELECT patient.end_care_relationship('${uid()}', '${A}', '${A1}', 'x')`,
      entitled: ['staff google A1', 'staff google B1'],
    },
    {
      fn: 'patient.attach',
      call: () => `SELECT patient.attach('${uid()}', '${uid()}', '${A}', '${A1}', false)`,
      entitled: ['staff google A1', 'staff google B1'],
    },
    {
      fn: 'patient.register',
      call: () =>
        `SELECT patient.register('${uid()}', '${A1}', NULL, false, 'G', 'F', NULL, NULL, '1990-01-01', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
      entitled: ['patient', 'patient A', 'staff google A1', 'staff google B1'],
    },
    {
      fn: 'patient.match_candidates',
      call: () =>
        `SELECT * FROM patient.match_candidates('${uid()}', 'Given', 'Family', '1980-05-17', NULL, NULL, NULL, '${A1}')`,
      entitled: ['staff google A1', 'staff google B1'],
    },
    {
      fn: 'patient.identity_label',
      call: () => `SELECT patient.identity_label('${uid()}', '${A}', 'audit.event', '${uid()}')`,
      entitled: ['staff admin_pool'],
    },
    {
      fn: 'scheduling.expire_holds',
      call: () => `SELECT scheduling.expire_holds(10)`,
      entitled: ['system job_scope org', 'system job_scope patients'],
    },
    {
      fn: 'scheduling.set_status',
      call: () => `SELECT scheduling.set_status('${uid()}', 'held', 'confirmed')`,
      entitled: [
        'patient',
        'patient A',
        'staff google A1',
        'staff google B1',
        'staff google no location',
        'system job_scope org',
        'system job_scope patients',
      ],
    },
    {
      fn: 'scheduling.occupy',
      call: () =>
        `SELECT scheduling.occupy('${uid()}', '${A1}', '${uid()}', NULL, tstzrange(now() + interval '400 days', now() + interval '400 days 30 minutes', '[)'), 60, false, NULL, 0)`,
      entitled: [
        'patient',
        'patient A',
        'staff google A1',
        'staff google B1',
        'staff google no location',
        'system job_scope org',
        'system job_scope patients',
      ],
    },
  ];
  for (const f of fns)
    test(`${f.fn} is refused to every caller that does not hold it`, async () => {
      const accepted: string[] = [];
      for (const who of everyone.filter((w) => !f.entitled.includes(w))) {
        const c = await new Caller(t, 'app_api', callerSet[who]?.() ?? null).open();
        try {
          const r = await c.run(f.call());
          if (!('error' in r)) accepted.push(who);
        } finally {
          await c.close();
        }
      }
      assert.deepEqual(accepted, [], `${f.fn} answered: ${accepted.join(', ')}`);
    });

  // (7) Entitled audience, wrong patient, reservation, clinic or missing key: the cases F02, F04 and F08 are about.
  test(
    'SEC03-F02 scheduling.set_status: another patient and another clinic cannot move the reservation of patient A',
    openCase('SEC03-F02'),
    async () => {
      const results: string[] = [];
      for (const [who, to] of [
        ['patient', 'cancelled_patient'],
        ['staff google B1', 'cancelled_patient'],
      ] as const) {
        const c = await new Caller(t, 'app_api', callerSet[who]?.() ?? null).open();
        try {
          const r = await c.run(
            `SELECT scheduling.set_status('${reservation.A}', 'held', '${to}') AS r`,
          );
          if (!('error' in r))
            results.push(`${who} -> ${to}: ${JSON.stringify((r.rows[0] as Row)['r'])}`);
        } finally {
          await c.close();
        }
      }
      assert.deepEqual(results, [], `set_status accepted: ${results.join('; ')}`);
    },
  );

  test(
    'SEC03-F04 patient.ensure_care_relationship: patient A (for a clinic of their choice), patient B and staff of B1 cannot add a relationship for patient A',
    openCase('SEC03-F04'),
    async () => {
      const accepted: string[] = [];
      const callers: [string, string, string][] = [
        ['patient A', A, B1], // a patient adds a clinic to their own record (referral is staff business)
        ['staff google B1', A, B1], // another clinic adds itself to a patient it cannot see
        ['patient', A, B1], // another patient
      ];
      for (const [who, pid, loc] of callers) {
        const c = await new Caller(t, 'app_api', callerSet[who]?.() ?? null).open();
        try {
          await c.run(`SELECT patient.lock_patients(${uuidArr([pid])}, 'no_key_update')`);
          const r = await c.run(
            `SELECT patient.ensure_care_relationship('${uid()}', '${pid}', '${loc}', 'referral') AS r`,
          );
          if (!('error' in r)) accepted.push(`${who} for A at ${loc === B1 ? 'B1' : 'A1'}`);
        } finally {
          await c.close();
        }
      }
      assert.deepEqual(accepted, [], `ensure_care_relationship accepted: ${accepted.join('; ')}`);
    },
  );

  test(
    "SEC03-F08 patient.identity_label (TC-AZ-08 steps 1 and 3): refused without the patient_label key or the compliance realm (the referencing-record check is the API layer's, O-5: patient/identity-label.dbtest.ts)",
    openCase('SEC03-F08'),
    async () => {
      const accepted: string[] = [];
      const settings: Record<string, ScopeSettings> = {
        'no key': {
          audience: 'staff',
          realm: 'admin_pool',
          orgId: ORG,
          principalId: staffPrincipalA.principalId as string,
          phiAccess: 'limited',
          complianceScopes: ['privacy_request'],
        },
        'full access, no slice': {
          audience: 'staff',
          realm: 'admin_pool',
          orgId: ORG,
          principalId: staffPrincipalA.principalId as string,
          phiAccess: 'full',
        },
        'google realm': {
          audience: 'staff',
          realm: 'google',
          orgId: ORG,
          principalId: staffPrincipalA.principalId as string,
          phiAccess: 'limited',
          complianceScopes: ['patient_label'],
          locationIds: [A1],
        },
      };
      for (const [name, s] of Object.entries(settings)) {
        const c = await new Caller(t, 'app_api', s).open();
        try {
          const r = await c.run(
            `SELECT patient.identity_label('${uid()}', '${A}', 'audit.event', '${uid()}')`,
          );
          if (!('error' in r)) accepted.push(name);
        } finally {
          await c.close();
        }
      }
      assert.deepEqual(accepted, [], `identity_label answered: ${accepted.join('; ')}`);
    },
  );

  test(
    'SEC03-F08 patient.identity_label succeeds for the compliance caller with the key and a visible referencing record (TC-AZ-08 step 3 positive)',
    openCase('SEC03-F08'),
    async () => {
      const ev = await saRows<{ id: string }>(
        `SELECT event_id::text AS id FROM audit.event LIMIT 1`,
      );
      const c = await new Caller(t, 'app_api', {
        audience: 'staff',
        realm: 'admin_pool',
        orgId: ORG,
        principalId: staffPrincipalA.principalId as string,
        phiAccess: 'limited',
        complianceScopes: ['patient_label'],
      }).open();
      try {
        const r = await c.run(
          `SELECT patient.identity_label('${uid()}', '${A}', 'audit.event', '${(ev[0] as { id: string }).id}') AS r`,
        );
        assert.ok(
          !('error' in r),
          `identity_label failed: ${'error' in r ? r.error + ' ' + r.message : ''}`,
        );
      } finally {
        await c.close();
      }
    },
  );
});

// ---------------------------------------------------------------------------------------------------------------------------------
// DF-13 (ARCHITECTURE 21.6, A-2.4; SEC03-F13 item 5, SEC03-F07): patient.caller_sees(id) is the hand-written twin of the patient-root
// policies of 0702. For every audience and realm, a second location, a second clinic, a second organisation, a proxy and a break-glass
// grant, it must equal "the root row is visible to that caller under RLS". caller_sees is internal (no application role holds EXECUTE),
// so it is called as patient_scope_owner, which is how the definer functions reach it.
// ---------------------------------------------------------------------------------------------------------------------------------
describe('DF-13: patient.caller_sees(id) equals "the patient root is visible under RLS" for every audience and realm', () => {
  const extra: CallerSpec[] = [
    {
      name: 'staff of A2 holding a break-glass grant on B',
      db: 'app_api',
      settings: () => staff([A2], { btgPatientIds: [B] }),
      own: () => [B],
    },
    {
      name: 'staff of A1 holding a break-glass grant on B',
      db: 'app_api',
      settings: () => staff([A1], { btgPatientIds: [B] }),
      own: () => [A, A_other, B],
    },
    {
      name: 'staff of another organisation holding a break-glass grant on A',
      db: 'app_api',
      settings: () => staff([A1], { orgId: ORG2, btgPatientIds: [A] }),
      own: () => [],
    },
    {
      name: 'admin_pool holding a break-glass grant on A',
      db: 'app_api',
      settings: () => ({
        audience: 'staff',
        realm: 'admin_pool',
        orgId: ORG,
        principalId: staffPrincipalA.principalId as string,
        phiAccess: 'limited',
        btgPatientIds: [A],
      }),
      own: () => [A],
    },
    {
      name: 'staff in a realm that is neither google nor admin_pool, with a break-glass grant on A and location A1',
      db: 'app_api',
      settings: () => staff([A1], { realm: 'partner_pool', btgPatientIds: [A] }),
      own: () => [],
    },
    {
      name: 'patient of another organisation with A in the patient list',
      db: 'app_api',
      settings: () => ({
        audience: 'patient',
        realm: 'patient_pool',
        orgId: ORG2,
        principalId: linkA.principalId,
        personId: linkA.personId,
        patientIds: [A],
      }),
      own: () => [],
    },
    {
      name: 'worker, system, organisation-wide job',
      db: 'app_worker',
      settings: () => ({ audience: 'system', realm: 'worker', orgId: ORG, jobScope: 'org' }),
      own: () => [A, A_other, B, B_other],
    },
    {
      name: 'worker, system, job scope of another organisation',
      db: 'app_worker',
      settings: () => ({ audience: 'system', realm: 'worker', orgId: ORG2, jobScope: 'org' }),
      own: () => [],
    },
  ];
  /**
   * The one intended difference (2502 header): a proxy holds the patient in its list and is "seen" by caller_sees (the booking and
   * referral functions act for the proxied patient, D-7), but never reads the root row itself (T-PAT-OWN excludes proxy_patient_ids).
   */
  const isProxy = (c: CallerSpec): boolean => c.name.startsWith('proxy of');
  const rootScope = (c: CallerSpec): string[] => (isProxy(c) ? [] : c.own());
  const bothWays = { seen: 0, hidden: 0 };
  for (const caller of [...CALLERS, ...extra])
    test(`as ${caller.name}: caller_sees agrees with the RLS-visible root for A, A_other, B, B_other and an unknown ID`, async () => {
      const rls = await new Caller(t, caller.db, caller.settings()).open();
      const fn = await new Caller(t, superUser(), caller.settings(), 'patient_scope_owner').open();
      const mismatches: string[] = [];
      try {
        for (const [tag, pid] of [
          ['A', A],
          ['A_other', A_other],
          ['B', B],
          ['B_other', B_other],
          ['unknown', uid()],
        ] as const) {
          const visible =
            (await rls.count(`SELECT count(*)::int AS n FROM patient.patient WHERE id = $1`, [
              pid,
            ])) === 1;
          const r = await fn.run(`SELECT patient.caller_sees($1::uuid) AS s`, [pid]);
          assert.ok(
            !('error' in r),
            `caller_sees failed for ${tag}: ${'error' in r ? r.message : ''}`,
          );
          const sees = (r.rows[0] as Row)['s'];
          const expected = visible || (isProxy(caller) && caller.own().includes(pid));
          if (sees !== expected)
            mismatches.push(
              `${tag}: caller_sees=${String(sees)}, RLS-visible=${visible}, expected ${expected}`,
            );
          if (visible) bothWays.seen++;
          else bothWays.hidden++;
          // and the intended scope of the caller, so a pair of wrong-in-the-same-way answers cannot pass
          if (tag !== 'unknown')
            assert.equal(
              visible,
              rootScope(caller).includes(pid),
              `${caller.name}: RLS visibility of ${tag} is not the intended one`,
            );
        }
      } finally {
        await rls.close();
        await fn.close();
      }
      assert.deepEqual(mismatches, [], `caller_sees differs from RLS for ${caller.name}`);
    });
  test('the comparison is not vacuous: both visible and hidden roots occur', () => {
    assert.ok(bothWays.seen >= 10 && bothWays.hidden >= 50, JSON.stringify(bothWays));
  });
});

void id;
