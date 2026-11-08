// The consent gate of a consultation (ARCHITECTURE 25.5 "Start consultation", 22.11 consent_exception; PRD RA-R1-08; BR-09).
//
// `ConsentGateService.start` is what `POST /encounters` (BE-17) calls inside its transaction, before the encounter moves to
// `in_consultation`: it lists the service's required consent templates that are not `signed` in the required version (the latest
// published one; an older signed version is `outdated`, a withdrawn or superseded one does not count), and
//   * none missing: the consultation may start, nothing is recorded;
//   * some missing and no exception: `409 clinical.consents_missing`, naming the template KEYS (catalogue keys, not patient data);
//   * some missing and `emergencyException.reason` (10..500 characters): one append-only `clinical.consent_exception` row naming the
//     missing templates, the reason and the caller, and an audit row `consent_exception`; the consultation may start.
// The caller has locked the patient (25.5, once per transaction). The signed consents it relies on are locked FOR SHARE until the transaction ends, so a withdrawal cannot slip in between the check
// and the start (the withdrawing transaction waits, then the next start is refused). RA-R1-08 acceptance (the rule text) is BLOCKED
// until D-12a names the safety reviewer; this is the mechanism and its tests.
import type { Tx } from '@ehr/kernel';
import type { ChartAuditPort } from '../chart/audit-port.js';
import { staffPrincipal } from './common.js';
import type { Row } from './common.js';
import {
  ConsentsMissingError,
  FrontdoorNotFoundError,
  FrontdoorValidationError,
  translateDbError,
} from './errors.js';
import { isUuid, uuidv7 } from './ids.js';
import type { CatalogPort, ConsentPort } from './ports.js';
import type { ConsentGateResult, RequestMeta } from './types.js';

export interface ConsentGateDeps {
  audit: ChartAuditPort;
  catalog: Pick<CatalogPort, 'requiredConsents'>;
  consents: ConsentPort;
}

export interface GateInput {
  encounterId: string;
  patientId: string;
  serviceId: string;
  emergencyException?: { reason?: unknown } | undefined;
}

export const MIN_REASON = 10;
export const MAX_REASON = 500;

export class ConsentGateService {
  constructor(private readonly deps: ConsentGateDeps) {}

  /** The required templates of the service not signed in the required version, as keys, sorted. Reads only. */
  async missing(tx: Tx, patientId: string, serviceId: string): Promise<string[]> {
    if (!isUuid(patientId) || !isUuid(serviceId))
      throw new FrontdoorValidationError(['patientId', 'serviceId']);
    const latest = new Map<string, number>();
    for (const t of await this.deps.catalog.requiredConsents(tx, serviceId))
      latest.set(t.key, Math.max(latest.get(t.key) ?? 0, t.version));
    const required = [...latest].map(([key, version]) => ({ key, version }));
    if (required.length === 0) return [];
    const status = await this.deps.consents.status(tx, patientId, required);
    const missing = status.filter((s) => s.status !== 'signed').map((s) => s.key);
    // Hold the signed ones: a withdrawal of a consent the start relies on waits for this transaction.
    const signed = required.filter((r) => !missing.includes(r.key)).map((r) => r.key);
    if (signed.length > 0)
      await tx.query(
        `SELECT id FROM patient.consent WHERE patient_id = $1::uuid AND status = 'signed' AND template_key = ANY($2::text[]) ORDER BY id FOR SHARE`,
        [patientId, signed],
      );
    return missing.sort();
  }

  async start(tx: Tx, meta: RequestMeta, input: GateInput): Promise<ConsentGateResult> {
    const principal = staffPrincipal(tx);
    const bad: string[] = [];
    if (!isUuid(input.encounterId)) bad.push('encounterId');
    if (!isUuid(input.patientId)) bad.push('patientId');
    if (!isUuid(input.serviceId)) bad.push('serviceId');
    let reason: string | undefined;
    if (input.emergencyException !== undefined && input.emergencyException !== null) {
      const r = input.emergencyException.reason;
      const t = typeof r === 'string' ? r.trim() : '';
      if (t.length < MIN_REASON || t.length > MAX_REASON) bad.push('emergencyException/reason');
      else reason = t;
    }
    if (bad.length > 0) throw new FrontdoorValidationError(bad);
    const pid = input.patientId.toLowerCase();
    try {
      // The caller (the encounter start, BE-17) holds the patient lock: 25.5 "lock patient", once per transaction (25.2).
      const missing = await this.missing(tx, pid, input.serviceId.toLowerCase());
      if (missing.length === 0) return { missing };
      if (reason === undefined) throw new ConsentsMissingError(missing);
      const id = uuidv7();
      const r = await tx.query(
        `INSERT INTO clinical.consent_exception (id, organisation_id, encounter_id, patient_id, missing_templates, reason, by_principal_id, created_by)
         VALUES ($1::uuid, kernel.uuid1('app.org_id'), $2::uuid, $3::uuid, $4::text[], $5, $6::uuid, $6::uuid) RETURNING id`,
        [id, input.encounterId.toLowerCase(), pid, missing, reason, principal],
      );
      await this.deps.audit.record(tx, {
        requestId: meta.requestId,
        action: 'consent_exception',
        resourceType: 'clinical.consent_exception',
        resourceId: id,
        patientId: pid,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        // Template keys only: the reason is free text and stays in the exception row (RA-R1-19).
        change: { missingTemplates: missing, encounterId: input.encounterId.toLowerCase() },
      });
      return { missing, exceptionId: String((r.rows[0] as Row)['id']) };
    } catch (e) {
      translateDbError(e);
    }
  }

  /** The recorded exceptions of a patient (compliance sees them through the consents slice; staff through their scope). */
  async exceptionsFor(tx: Tx, patientId: string): Promise<Row[]> {
    if (!isUuid(patientId)) throw new FrontdoorNotFoundError();
    const r = await tx.query(
      `SELECT id, encounter_id, missing_templates, by_principal_id, created_at FROM clinical.consent_exception WHERE patient_id = $1::uuid ORDER BY created_at DESC LIMIT 200`,
      [patientId],
    );
    return r.rows as Row[];
  }
}
