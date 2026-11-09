// The ports of ports.ts over the real services of the other modules (the composition root calls `createFrontdoorPorts`; the tests
// do too, so what they exercise is the code that ships). Writes to another module go through its service. The few READS of another
// module's tables are plain SELECTs in the caller's own transaction, so that module's row-level security decides what is visible
// (the scheduling flow reads `patient.insurance_coverage` the same way): the check-in and reservation of the visit, the roster,
// the role holders, the service-location offer and the exact questionnaire version a response was started on.
import type { Queue, Tx } from '@ehr/kernel';
import type { OrganisationService } from '../../organisation/index.js';
import type { PatientRecordsService, PatientService } from '../../patient/index.js';
import type { Row } from './common.js';
import type { AlertTargets, FrontdoorPorts, RaiseAlertInput, RaisedAlert } from './ports.js';
import type { CheckInInfo, QuestionnaireTemplate, RequestMeta, TriageCategory } from './types.js';

export interface FrontdoorPortDeps {
  flow: {
    setTriageCategory(
      tx: Tx,
      meta: RequestMeta,
      entryId: string,
      category: TriageCategory,
    ): Promise<unknown>;
  };
  alerts: {
    raise(tx: Tx, input: RaiseAlertInput): Promise<RaisedAlert>;
    addEscalationTargets(tx: Tx, alertId: string, targets: AlertTargets): Promise<string[]>;
  };
  organisation: Pick<OrganisationService, 'consentTemplatesRequired'>;
  records: Pick<PatientRecordsService, 'requiredConsentStatus'>;
  patients: Pick<PatientService, 'lockForReferral' | 'ensureReferralCareRelationship'>;
  queue: Pick<Queue, 'publish'>;
}

const infoOf = (r: Row | undefined): CheckInInfo | undefined =>
  r === undefined
    ? undefined
    : {
        checkInId: String(r['id']),
        patientId: String(r['patient_id']),
        locationId: String(r['location_id']),
        serviceId:
          r['service_id'] === null || r['service_id'] === undefined
            ? null
            : String(r['service_id']),
      };

export function createFrontdoorPorts(d: FrontdoorPortDeps): FrontdoorPorts {
  return {
    checkIns: {
      async get(tx, id) {
        const r = await tx.query(
          `SELECT c.id, c.patient_id, c.location_id, r.service_id
             FROM scheduling.check_in c JOIN scheduling.slot_reservation r ON r.id = c.id WHERE c.id = $1::uuid`,
          [id],
        );
        return infoOf(r.rows[0] as Row | undefined);
      },
      async reservation(tx, id) {
        const r = await tx.query(
          `SELECT id, patient_id, location_id, service_id FROM scheduling.slot_reservation WHERE id = $1::uuid`,
          [id],
        );
        return infoOf(r.rows[0] as Row | undefined);
      },
      async setTriageCategory(tx, meta, id, category) {
        await d.flow.setTriageCategory(tx, meta, id, category);
      },
    },
    duty: {
      async onDuty(tx, locationId, duty, at) {
        // A roster entry names a principal who must still be active (a kill switch leaves the entry in place). A patients-scope job
        // (the escalation re-target) cannot read identity.principal (its read policy is org-scope jobs only), so there the roster alone
        // decides; an inactive on-call doctor then stays a target, which adds a recipient and never removes one.
        const checkActive = tx.scope.audience !== 'system';
        const r = await tx.query(
          `SELECT DISTINCT re.principal_id FROM scheduling.roster_entry re
             ${checkActive ? `JOIN identity.principal p ON p.id = re.principal_id AND p.status = 'active'` : ''}
            WHERE re.location_id = $1::uuid AND re.duty = $2 AND re.period @> $3::timestamptz
            ORDER BY re.principal_id`,
          [locationId, duty, at.toISOString()],
        );
        return (r.rows as Row[]).map((x) => String(x['principal_id']));
      },
      async permissionHoldersAt(tx, permission, locationId) {
        const r = await tx.query(
          `SELECT DISTINCT ra.principal_id
             FROM identity.role_assignment ra
             JOIN identity.role_permission rp ON rp.role_id = ra.role_id
             JOIN identity.principal p ON p.id = ra.principal_id AND p.status = 'active' AND p.realm = 'google'
            WHERE ra.revoked_at IS NULL AND rp.permission_key = $1 AND (ra.location_id = $2::uuid OR ra.location_id IS NULL)
            ORDER BY ra.principal_id`,
          [permission, locationId],
        );
        return (r.rows as Row[]).map((x) => String(x['principal_id']));
      },
    },
    alerts: {
      raise: (tx, input) => d.alerts.raise(tx, input),
      addTargets: (tx, alertId, targets) => d.alerts.addEscalationTargets(tx, alertId, targets),
    },
    catalog: {
      requiredConsents: async (tx, serviceId) =>
        (await d.organisation.consentTemplatesRequired(tx, serviceId)).map((t) => ({
          key: t.key,
          version: t.version,
        })),
      async questionnaireTemplate(tx, key, version): Promise<QuestionnaireTemplate | null> {
        // The version a response was started on stays readable after a newer one is published (the older one is retired, not gone).
        const r = await tx.query(
          version === undefined
            ? `SELECT key, version, schema FROM organisation.questionnaire_template WHERE key = $1 AND status = 'published' ORDER BY version DESC LIMIT 1`
            : `SELECT key, version, schema FROM organisation.questionnaire_template WHERE key = $1 AND version = $2 AND status IN ('published', 'retired')`,
          version === undefined ? [key] : [key, version],
        );
        const x = r.rows[0] as Row | undefined;
        if (x === undefined) return null;
        const schema = x['schema'];
        return {
          key: String(x['key']),
          version: Number(x['version']),
          schema:
            schema !== null && typeof schema === 'object'
              ? (schema as Record<string, unknown>)
              : {},
        };
      },
      async serviceOffered(tx, serviceId, locationId) {
        const r = await tx.query(
          `SELECT 1 FROM organisation.service_location sl
             JOIN organisation.service s ON s.id = sl.service_id AND s.active
             JOIN organisation.location l ON l.id = sl.location_id AND l.active
            WHERE sl.service_id = $1::uuid AND sl.location_id = $2::uuid`,
          [serviceId, locationId],
        );
        return r.rows.length > 0;
      },
    },
    consents: {
      status: (tx, patientId, templates) =>
        d.records.requiredConsentStatus(tx, patientId, templates),
    },
    care: {
      lockForReferral: (tx, referralId, patientId, mode) =>
        d.patients.lockForReferral(tx, referralId, patientId, mode),
      ensureForReferral: (tx, meta, referralId) =>
        d.patients.ensureReferralCareRelationship(tx, meta, referralId),
    },
    events: { publish: (tx, event, payload) => d.queue.publish(tx, event, payload) },
  };
}
