// The records that hang off the patient root (ARCHITECTURE 22.6): contacts, insurance coverage and its eligibility result,
// consents, communication preferences, the care team and the duplicate-flag work queue. They are ordinary rows under the
// caller's own RLS (T-PAT-OWN for the patient, T-STAFF for staff); every method runs in the caller's transaction and the
// database refuses what the scope does not allow. The service checks shape and state first so the answer is a registry code
// and not a database error.
import type { Queue, Tx } from '@ehr/kernel';
import { normaliseText } from '../../platform/limits.js';
import { AuditService } from '../audit/index.js';
import {
  ChannelUnavailableError,
  ConsentNotPendingError,
  PatientNotFoundError,
  PatientScopeError,
  PatientValidationError,
  PreconditionFailedError,
  translateDbError,
} from './errors.js';
import { isUuid, uuidv7 } from './ids.js';
import { normaliseEmail, normaliseName, normalisePhone } from './normalise.js';
import type { RequestMeta } from './types.js';

type Row = Record<string, unknown>;
const str = (v: unknown): string => String(v);
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const iso = (v: unknown): string | null =>
  v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v);
const dateOnly = (v: unknown): string | null =>
  v === null || v === undefined
    ? null
    : v instanceof Date
      ? v.toISOString().slice(0, 10)
      : String(v).slice(0, 10);

/** `organisation` publishes the consent templates (24); `patient` asks only whether a version is still published. */
export interface ConsentTemplatePort {
  isPublished(tx: Tx, key: string, version: number): Promise<boolean>;
}

/** `identity` knows which principals are staff. `patient` asks before it puts one on a care team. */
export interface StaffDirectoryPort {
  isStaffPrincipal(tx: Tx, principalId: string): Promise<boolean>;
}

export interface RecordsDeps {
  audit: AuditService;
  consentTemplates: ConsentTemplatePort;
  staff: StaffDirectoryPort;
  /** Optional: with it, `patient.consent_signed` is published in the signing transaction (24). */
  queue?: Queue;
  now?: () => Date;
}

export const CHANNELS = ['email', 'sms', 'push', 'in_app'] as const;
export type Channel = (typeof CHANNELS)[number];

export interface ContactView {
  id: string;
  patientId: string;
  kind: 'emergency' | 'next_of_kin';
  name: string;
  relationship: string | null;
  phone: string | null;
  email: string | null;
  rowVersion: number;
}
export interface CoverageView {
  id: string;
  patientId: string;
  payerName: string;
  memberId: string;
  groupNumber: string | null;
  frontDocumentId: string | null;
  backDocumentId: string | null;
  eligibilityStatus: string;
  verifiedAt: string | null;
  active: boolean;
  rowVersion: number;
}
export interface ConsentView {
  id: string;
  patientId: string;
  templateKey: string;
  templateVersion: number;
  status: 'pending' | 'signed' | 'superseded' | 'withdrawn';
  signedAt: string | null;
  signerRelationship: string | null;
  signatureDocumentId: string | null;
  withdrawnAt: string | null;
}
export interface PreferenceView {
  patientId: string;
  channels: Channel[];
  reminderChannel: Channel | null;
  language: string;
  quietHours: { start: string; end: string; timeZone: string } | null;
  marketingOptIn: false;
  stored: boolean;
  rowVersion: number | null;
}
export interface CareTeamView {
  id: string;
  patientId: string;
  principalId: string;
  role: string;
  fromDate: string;
  toDate: string | null;
}
export interface DuplicateFlagView {
  id: string;
  patientId: string;
  /** Present only when the candidate is inside the caller's scope. */
  candidatePatientId: string | null;
  strength: 'exact' | 'probable';
  source: 'self_registration' | 'front_desk';
  status: string;
  createdAt: string;
}

const contactOf = (r: Row): ContactView => ({
  id: str(r['id']),
  patientId: str(r['patient_id']),
  kind: r['kind'] === 'emergency' ? 'emergency' : 'next_of_kin',
  name: str(r['name']),
  relationship: strOrNull(r['relationship']),
  phone: strOrNull(r['phone']),
  email: strOrNull(r['email']),
  rowVersion: Number(r['row_version']),
});
const coverageOf = (r: Row): CoverageView => ({
  id: str(r['id']),
  patientId: str(r['patient_id']),
  payerName: str(r['payer_name']),
  memberId: str(r['member_id']),
  groupNumber: strOrNull(r['group_number']),
  frontDocumentId: strOrNull(r['front_document_id']),
  backDocumentId: strOrNull(r['back_document_id']),
  eligibilityStatus: str(r['eligibility_status']),
  verifiedAt: iso(r['verified_at']),
  active: r['active'] === true,
  rowVersion: Number(r['row_version']),
});
const consentOf = (r: Row): ConsentView => ({
  id: str(r['id']),
  patientId: str(r['patient_id']),
  templateKey: str(r['template_key']),
  templateVersion: Number(r['template_version']),
  status: r['status'] as ConsentView['status'],
  signedAt: iso(r['signed_at']),
  signerRelationship: strOrNull(r['signer_relationship']),
  signatureDocumentId: strOrNull(r['signature_document_id']),
  withdrawnAt: iso(r['withdrawn_at']),
});

const COVERAGE_COLS = `id, patient_id, payer_name, member_id, group_number, front_document_id, back_document_id,
  eligibility_status, verified_at, active, row_version`;
const CONSENT_COLS = `id, patient_id, template_key, template_version, status, signed_at, signer_relationship,
  signature_document_id, withdrawn_at`;
const CONTACT_COLS = `id, patient_id, kind, name, relationship, phone, email, row_version`;

const TEMPLATE_KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;
const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function text(v: unknown, max: number, min = 1): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = normaliseText(v).replace(/\s+/g, ' ').trim();
  return s.length < min || s.length > max ? undefined : s;
}

export class PatientRecordsService {
  constructor(private readonly deps: RecordsDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private async audit(
    tx: Tx,
    meta: RequestMeta,
    resourceType: string,
    resourceId: string,
    patientId: string,
    action: 'create' | 'update' | 'view',
    change?: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.audit.record(tx, {
      requestId: meta.requestId,
      action,
      resourceType,
      resourceId,
      patientId,
      ...(change === undefined ? {} : { change }),
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    });
  }

  // --- contacts ----------------------------------------------------------------------------------------------------

  async listContacts(tx: Tx, patientId: string): Promise<ContactView[]> {
    const r = await tx.query(
      `SELECT ${CONTACT_COLS} FROM patient.patient_contact WHERE patient_id = $1::uuid ORDER BY created_at, id`,
      [patientId],
    );
    return r.rows.map((x) => contactOf(x as Row));
  }

  private contactInput(b: unknown, partial: boolean): Row {
    const o = (typeof b === 'object' && b !== null ? b : {}) as Row;
    const bad: string[] = [];
    const out: Row = {};
    if (!partial || o['kind'] !== undefined) {
      if (o['kind'] === 'emergency' || o['kind'] === 'next_of_kin') out['kind'] = o['kind'];
      else bad.push('kind');
    }
    if (!partial || o['name'] !== undefined) {
      const n = text(o['name'], 200);
      if (n === undefined) bad.push('name');
      else out['name'] = n;
    }
    if (o['relationship'] !== undefined && o['relationship'] !== null) {
      const n = text(o['relationship'], 100);
      if (n === undefined) bad.push('relationship');
      else out['relationship'] = n;
    }
    if (o['phone'] !== undefined && o['phone'] !== null) {
      const n = normalisePhone(o['phone']);
      if (n === undefined) bad.push('phone');
      else out['phone'] = n;
    }
    if (o['email'] !== undefined && o['email'] !== null) {
      const n = normaliseEmail(o['email']);
      if (n === undefined) bad.push('email');
      else out['email'] = n;
    }
    if (bad.length > 0) throw new PatientValidationError(bad);
    if (Object.keys(out).length === 0) throw new PatientValidationError(['body']);
    return out;
  }

  async addContact(
    tx: Tx,
    meta: RequestMeta,
    patientId: string,
    body: unknown,
  ): Promise<ContactView> {
    const c = this.contactInput(body, false);
    if (c['phone'] === undefined && c['email'] === undefined)
      throw new PatientValidationError(['phone', 'email']);
    const id = uuidv7();
    try {
      const r = await tx.query(
        `INSERT INTO patient.patient_contact (id, organisation_id, patient_id, kind, name, relationship, phone, email, created_by)
         VALUES ($1::uuid, kernel.uuid1('app.org_id'), $2::uuid, $3, $4, $5, $6, $7, kernel.uuid1('app.principal_id')) RETURNING ${CONTACT_COLS}`,
        [
          id,
          patientId,
          c['kind'],
          c['name'],
          c['relationship'] ?? null,
          c['phone'] ?? null,
          c['email'] ?? null,
        ],
      );
      await this.audit(tx, meta, 'patient.patient_contact', id, patientId, 'create');
      return contactOf(r.rows[0] as Row);
    } catch (e) {
      translateDbError(e);
    }
  }

  async updateContact(
    tx: Tx,
    meta: RequestMeta,
    patientId: string,
    id: string,
    version: number,
    body: unknown,
  ): Promise<ContactView> {
    if (!isUuid(id)) throw new PatientNotFoundError();
    const c = this.contactInput(body, true);
    const sets: string[] = [];
    const params: unknown[] = [id, patientId, version];
    for (const [k, v] of Object.entries(c)) {
      params.push(v);
      sets.push(`${k === 'kind' ? 'kind' : k} = $${params.length}`);
    }
    try {
      const r = await tx.query(
        `UPDATE patient.patient_contact SET ${sets.join(', ')} WHERE id = $1::uuid AND patient_id = $2::uuid AND row_version = $3 RETURNING ${CONTACT_COLS}`,
        params,
      );
      if (r.rows[0] === undefined)
        await this.missingOrStale(tx, 'patient.patient_contact', id, patientId);
      await this.audit(tx, meta, 'patient.patient_contact', id, patientId, 'update', {
        fields: Object.keys(c),
      });
      return contactOf(r.rows[0] as Row);
    } catch (e) {
      translateDbError(e);
    }
  }

  async deleteContact(tx: Tx, meta: RequestMeta, patientId: string, id: string): Promise<void> {
    if (!isUuid(id)) throw new PatientNotFoundError();
    try {
      const r = await tx.query(
        `DELETE FROM patient.patient_contact WHERE id = $1::uuid AND patient_id = $2::uuid`,
        [id, patientId],
      );
      if ((r.rowCount ?? 0) === 0) throw new PatientNotFoundError();
      await this.audit(tx, meta, 'patient.patient_contact', id, patientId, 'update', {
        deleted: true,
      });
    } catch (e) {
      translateDbError(e);
    }
  }

  /** A write that matched no row: invisible or absent is 404, visible but at another version is 412. */
  private async missingOrStale(
    tx: Tx,
    table: string,
    id: string,
    patientId: string,
  ): Promise<never> {
    const seen = await tx.query(
      `SELECT 1 FROM ${table} WHERE id = $1::uuid AND patient_id = $2::uuid`,
      [id, patientId],
    );
    if (seen.rows[0] === undefined) throw new PatientNotFoundError();
    throw new PreconditionFailedError();
  }

  // --- insurance ---------------------------------------------------------------------------------------------------

  async listCoverages(tx: Tx, patientId: string): Promise<CoverageView[]> {
    const r = await tx.query(
      `SELECT ${COVERAGE_COLS} FROM patient.insurance_coverage WHERE patient_id = $1::uuid ORDER BY created_at, id`,
      [patientId],
    );
    return r.rows.map((x) => coverageOf(x as Row));
  }

  private coverageInput(b: unknown, partial: boolean): Row {
    const o = (typeof b === 'object' && b !== null ? b : {}) as Row;
    const bad: string[] = [];
    const out: Row = {};
    for (const [k, col, max, req] of [
      ['payerName', 'payer_name', 200, true],
      ['memberId', 'member_id', 100, true],
      ['groupNumber', 'group_number', 100, false],
    ] as const) {
      if (o[k] === undefined || o[k] === null) {
        if (req && !partial) bad.push(k);
        continue;
      }
      const t = text(o[k], max);
      if (t === undefined) bad.push(k);
      else out[col] = t;
    }
    for (const [k, col] of [
      ['frontDocumentId', 'front_document_id'],
      ['backDocumentId', 'back_document_id'],
    ] as const) {
      if (o[k] === undefined) continue;
      if (o[k] === null || isUuid(o[k])) out[col] = o[k];
      else bad.push(k);
    }
    if (o['active'] !== undefined) {
      if (typeof o['active'] === 'boolean') out['active'] = o['active'];
      else bad.push('active');
    }
    if (bad.length > 0) throw new PatientValidationError(bad);
    if (Object.keys(out).length === 0) throw new PatientValidationError(['body']);
    return out;
  }

  async addCoverage(
    tx: Tx,
    meta: RequestMeta,
    patientId: string,
    body: unknown,
  ): Promise<CoverageView> {
    const c = this.coverageInput(body, false);
    const id = uuidv7();
    try {
      const r = await tx.query(
        `INSERT INTO patient.insurance_coverage (id, organisation_id, patient_id, payer_name, member_id, group_number, front_document_id, back_document_id, created_by)
         VALUES ($1::uuid, kernel.uuid1('app.org_id'), $2::uuid, $3, $4, $5, $6, $7, kernel.uuid1('app.principal_id')) RETURNING ${COVERAGE_COLS}`,
        [
          id,
          patientId,
          c['payer_name'],
          c['member_id'],
          c['group_number'] ?? null,
          c['front_document_id'] ?? null,
          c['back_document_id'] ?? null,
        ],
      );
      await this.audit(tx, meta, 'patient.insurance_coverage', id, patientId, 'create');
      return coverageOf(r.rows[0] as Row);
    } catch (e) {
      translateDbError(e);
    }
  }

  async updateCoverage(
    tx: Tx,
    meta: RequestMeta,
    patientId: string,
    id: string,
    version: number,
    body: unknown,
  ): Promise<CoverageView> {
    if (!isUuid(id)) throw new PatientNotFoundError();
    const c = this.coverageInput(body, true);
    const sets: string[] = [];
    const params: unknown[] = [id, patientId, version];
    for (const [k, v] of Object.entries(c)) {
      params.push(v);
      sets.push(`${k} = $${params.length}`);
    }
    try {
      const r = await tx.query(
        `UPDATE patient.insurance_coverage SET ${sets.join(', ')} WHERE id = $1::uuid AND patient_id = $2::uuid AND row_version = $3 RETURNING ${COVERAGE_COLS}`,
        params,
      );
      if (r.rows[0] === undefined)
        await this.missingOrStale(tx, 'patient.insurance_coverage', id, patientId);
      await this.audit(tx, meta, 'patient.insurance_coverage', id, patientId, 'update', {
        fields: Object.keys(c),
      });
      return coverageOf(r.rows[0] as Row);
    } catch (e) {
      translateDbError(e);
    }
  }

  /** `PUT /insurance-coverages/{id}/eligibility` (staff, RA-R1-29): the result, who verified and when. */
  async recordEligibility(
    tx: Tx,
    meta: RequestMeta,
    id: string,
    version: number,
    status: unknown,
  ): Promise<CoverageView> {
    if (!isUuid(id)) throw new PatientNotFoundError();
    if (
      status !== 'verified_active' &&
      status !== 'verified_inactive' &&
      status !== 'unable_to_verify'
    )
      throw new PatientValidationError(['status']);
    const principal = tx.scope.principalId;
    if (tx.scope.audience !== 'staff' || principal === undefined) throw new PatientScopeError();
    try {
      const r = await tx.query(
        `UPDATE patient.insurance_coverage SET eligibility_status = $3, verified_at = now(), verified_by = $4::uuid
          WHERE id = $1::uuid AND row_version = $2 RETURNING ${COVERAGE_COLS}`,
        [id, version, status, principal],
      );
      if (r.rows[0] === undefined) {
        const seen = await tx.query(
          `SELECT 1 FROM patient.insurance_coverage WHERE id = $1::uuid`,
          [id],
        );
        if (seen.rows[0] === undefined) throw new PatientNotFoundError();
        throw new PreconditionFailedError();
      }
      const view = coverageOf(r.rows[0] as Row);
      await this.audit(tx, meta, 'patient.insurance_coverage', id, view.patientId, 'update', {
        eligibility: status,
      });
      return view;
    } catch (e) {
      translateDbError(e);
    }
  }

  async coveragePatient(tx: Tx, id: string): Promise<string | undefined> {
    if (!isUuid(id)) return undefined;
    const r = await tx.query(
      `SELECT patient_id FROM patient.insurance_coverage WHERE id = $1::uuid`,
      [id],
    );
    return r.rows[0] === undefined ? undefined : str((r.rows[0] as Row)['patient_id']);
  }

  // --- consents (BR-09, 22.6) --------------------------------------------------------------------------------------

  async listConsents(tx: Tx, patientId: string): Promise<ConsentView[]> {
    const r = await tx.query(
      `SELECT ${CONSENT_COLS} FROM patient.consent WHERE patient_id = $1::uuid ORDER BY template_key, template_version, created_at`,
      [patientId],
    );
    return r.rows.map((x) => consentOf(x as Row));
  }

  async consentPatient(tx: Tx, consentId: string): Promise<string | undefined> {
    if (!isUuid(consentId)) return undefined;
    const r = await tx.query(`SELECT patient_id FROM patient.consent WHERE id = $1::uuid`, [
      consentId,
    ]);
    return r.rows[0] === undefined ? undefined : str((r.rows[0] as Row)['patient_id']);
  }

  /**
   * Asks the patient to sign a published template version: a pending row, or the one already open (the unique index decides, so
   * asking twice returns the same row). Called by the booking and clinical flows through the published interface.
   */
  async requestConsent(
    tx: Tx,
    meta: RequestMeta,
    patientId: string,
    templateKey: unknown,
    templateVersion: unknown,
  ): Promise<ConsentView> {
    if (!isUuid(patientId)) throw new PatientValidationError(['patientId']);
    if (typeof templateKey !== 'string' || !TEMPLATE_KEY.test(templateKey))
      throw new PatientValidationError(['templateKey']);
    if (!Number.isInteger(templateVersion) || (templateVersion as number) < 1)
      throw new PatientValidationError(['templateVersion']);
    if (!(await this.deps.consentTemplates.isPublished(tx, templateKey, templateVersion as number)))
      throw new PatientValidationError(['templateKey']);
    const id = uuidv7();
    try {
      const ins = await tx.query(
        `INSERT INTO patient.consent (id, organisation_id, patient_id, template_key, template_version, status, created_by)
         VALUES ($1::uuid, kernel.uuid1('app.org_id'), $2::uuid, $3, $4, 'pending', kernel.uuid1('app.principal_id'))
         ON CONFLICT (patient_id, template_key, template_version) WHERE status = 'pending' DO NOTHING RETURNING ${CONSENT_COLS}`,
        [id, patientId, templateKey, templateVersion],
      );
      if (ins.rows[0] !== undefined) {
        await this.audit(tx, meta, 'patient.consent', id, patientId, 'create', {
          status: 'pending',
        });
        return consentOf(ins.rows[0] as Row);
      }
      const existing = await tx.query(
        `SELECT ${CONSENT_COLS} FROM patient.consent WHERE patient_id = $1::uuid AND template_key = $2 AND template_version = $3 AND status = 'pending'`,
        [patientId, templateKey, templateVersion],
      );
      if (existing.rows[0] === undefined) throw new PatientNotFoundError();
      return consentOf(existing.rows[0] as Row);
    } catch (e) {
      translateDbError(e);
    }
  }

  /**
   * `POST /consents/{consentId}/sign` (patient; staff may witness). The pending row becomes `signed` and an earlier signed version
   * of the same template becomes `superseded`, in this transaction (22.6 draft 6). `typedName` is the signature (BR-09 evidence).
   * A proxy never signs: the policies are T-PAT-OWN and the signer relationship is checked there as well.
   */
  async signConsent(
    tx: Tx,
    meta: RequestMeta,
    consentId: string,
    body: unknown,
  ): Promise<ConsentView> {
    if (!isUuid(consentId)) throw new PatientNotFoundError();
    const o = (typeof body === 'object' && body !== null ? body : {}) as Row;
    const typedName = text(o['typedName'], 200);
    if (typedName === undefined) throw new PatientValidationError(['typedName']);
    if (
      o['signatureDocumentId'] !== undefined &&
      o['signatureDocumentId'] !== null &&
      !isUuid(o['signatureDocumentId'])
    )
      throw new PatientValidationError(['signatureDocumentId']);
    const principal = tx.scope.principalId;
    const audience = tx.scope.audience;
    if (principal === undefined || (audience !== 'patient' && audience !== 'staff'))
      throw new PatientScopeError();
    try {
      const cur = await tx.query(
        `SELECT ${CONSENT_COLS} FROM patient.consent WHERE id = $1::uuid FOR UPDATE`,
        [consentId],
      );
      const c = cur.rows[0] as Row | undefined;
      if (c === undefined) throw new PatientNotFoundError();
      if (c['status'] !== 'pending') throw new ConsentNotPendingError();
      const key = str(c['template_key']);
      const version = Number(c['template_version']);
      const patientId = str(c['patient_id']);
      // "Signed templates": the version signed must still be a published one, otherwise the patient would sign text that is no
      // longer the clinic's current wording. A newer version is a new pending row (requestConsent), never a silent upgrade.
      if (!(await this.deps.consentTemplates.isPublished(tx, key, version)))
        throw new ConsentNotPendingError();
      await tx.query(
        `UPDATE patient.consent SET status = 'superseded' WHERE patient_id = $1::uuid AND template_key = $2 AND status = 'signed'`,
        [patientId, key],
      );
      const r = await tx.query(
        `UPDATE patient.consent SET status = 'signed', signer_principal_id = $2::uuid, signer_relationship = $3, signed_name = $4,
                signature_document_id = $5::uuid
          WHERE id = $1::uuid AND status = 'pending' RETURNING ${CONSENT_COLS}`,
        [
          consentId,
          principal,
          audience === 'patient' ? 'self' : 'staff_witnessed',
          typedName,
          o['signatureDocumentId'] ?? null,
        ],
      );
      if (r.rows[0] === undefined) throw new ConsentNotPendingError();
      await this.audit(tx, meta, 'patient.consent', consentId, patientId, 'update', {
        status: 'signed',
        templateKey: key,
        templateVersion: version,
      });
      await this.deps.queue?.publish(tx, 'patient.consent_signed', { patientId, consentId });
      return consentOf(r.rows[0] as Row);
    } catch (e) {
      translateDbError(e);
    }
  }

  /**
   * `requiredConsentStatus(patient, templates)` (24, BR-09): per required template, `signed` (this version or later), `outdated`
   * (signed, but an older version than required), `pending` (asked, not signed) or `missing`.
   */
  async requiredConsentStatus(
    tx: Tx,
    patientId: string,
    templates: readonly { key: string; version: number }[],
  ): Promise<
    { key: string; version: number; status: 'signed' | 'outdated' | 'pending' | 'missing' }[]
  > {
    if (!isUuid(patientId)) throw new PatientValidationError(['patientId']);
    const r = await tx.query(
      `SELECT template_key, template_version, status FROM patient.consent
        WHERE patient_id = $1::uuid AND status IN ('signed', 'pending') AND template_key = ANY($2::text[])`,
      [patientId, templates.map((t) => t.key)],
    );
    return templates.map((t) => {
      const rows = r.rows.filter((x) => (x as Row)['template_key'] === t.key) as Row[];
      const signed = rows.filter((x) => x['status'] === 'signed');
      if (signed.some((x) => Number(x['template_version']) >= t.version))
        return { ...t, status: 'signed' as const };
      if (rows.some((x) => x['status'] === 'pending' && Number(x['template_version']) >= t.version))
        return { ...t, status: 'pending' as const };
      return { ...t, status: signed.length > 0 ? ('outdated' as const) : ('missing' as const) };
    });
  }

  // --- communication preferences -----------------------------------------------------------------------------------

  async getPreferences(tx: Tx, patientId: string): Promise<PreferenceView | undefined> {
    const p = await tx.query(
      `SELECT phone_e164, email, preferred_language FROM patient.patient WHERE id = $1::uuid`,
      [patientId],
    );
    const pat = p.rows[0] as Row | undefined;
    if (pat === undefined) return undefined;
    const r = await tx.query(
      `SELECT channels, reminder_channel, language, quiet_hours, row_version FROM patient.communication_preference WHERE patient_id = $1::uuid`,
      [patientId],
    );
    const row = r.rows[0] as Row | undefined;
    if (row === undefined)
      return {
        patientId,
        channels: pat['email'] ? ['email', 'in_app'] : ['in_app'],
        reminderChannel: null,
        language: str(pat['preferred_language']),
        quietHours: null,
        marketingOptIn: false,
        stored: false,
        rowVersion: null,
      };
    return {
      patientId,
      channels: row['channels'] as Channel[],
      reminderChannel: (row['reminder_channel'] as Channel | null) ?? null,
      language: str(row['language']),
      quietHours: (row['quiet_hours'] as PreferenceView['quietHours']) ?? null,
      marketingOptIn: false,
      stored: true,
      rowVersion: Number(row['row_version']),
    };
  }

  /**
   * `PUT /patients/{patientId}/communication-preferences`: replaces the stored preference. `422 patient.channel_unavailable` when
   * a chosen channel has no address on the record (SMS without a phone, e-mail without an address). `in_app` is always kept: a
   * patient cannot opt out of the in-app notice (TC-NT-04). `ifMatch` is the row version; absent only while nothing is stored.
   */
  async putPreferences(
    tx: Tx,
    meta: RequestMeta,
    patientId: string,
    ifMatch: number | undefined,
    body: unknown,
  ): Promise<PreferenceView> {
    const o = (typeof body === 'object' && body !== null ? body : {}) as Row;
    const bad: string[] = [];
    const channelsIn = Array.isArray(o['channels']) ? (o['channels'] as unknown[]) : undefined;
    if (
      channelsIn === undefined ||
      !channelsIn.every((c) => typeof c === 'string' && (CHANNELS as readonly string[]).includes(c))
    )
      bad.push('channels');
    let reminder: Channel | null = null;
    if (o['reminderChannel'] !== undefined && o['reminderChannel'] !== null) {
      if (
        typeof o['reminderChannel'] === 'string' &&
        (CHANNELS as readonly string[]).includes(o['reminderChannel'])
      )
        reminder = o['reminderChannel'] as Channel;
      else bad.push('reminderChannel');
    }
    if (typeof o['language'] !== 'string' || !LANGUAGE.test(o['language'])) bad.push('language');
    if (o['marketingOptIn'] !== undefined && o['marketingOptIn'] !== false)
      bad.push('marketingOptIn');
    let quiet: PreferenceView['quietHours'] = null;
    if (o['quietHours'] !== undefined && o['quietHours'] !== null) {
      const q = o['quietHours'] as Row;
      if (
        typeof q === 'object' &&
        typeof q['start'] === 'string' &&
        HHMM.test(q['start']) &&
        typeof q['end'] === 'string' &&
        HHMM.test(q['end']) &&
        q['start'] !== q['end'] &&
        typeof q['timeZone'] === 'string' &&
        isTimeZone(q['timeZone'])
      )
        quiet = { start: q['start'], end: q['end'], timeZone: q['timeZone'] };
      else bad.push('quietHours');
    }
    if (bad.length > 0) throw new PatientValidationError(bad);
    const channels = [...new Set([...(channelsIn as Channel[]), 'in_app' as Channel])];
    if (reminder !== null && !channels.includes(reminder))
      throw new PatientValidationError(['reminderChannel']);
    const pat = (
      await tx.query(`SELECT phone_e164, email FROM patient.patient WHERE id = $1::uuid`, [
        patientId,
      ])
    ).rows[0] as Row | undefined;
    if (pat === undefined) throw new PatientNotFoundError();
    if (
      (channels.includes('sms') && !pat['phone_e164']) ||
      (channels.includes('email') && !pat['email'])
    )
      throw new ChannelUnavailableError();
    try {
      const existing = await tx.query(
        `SELECT row_version FROM patient.communication_preference WHERE patient_id = $1::uuid`,
        [patientId],
      );
      if (existing.rows[0] === undefined) {
        await tx.query(
          `INSERT INTO patient.communication_preference (patient_id, organisation_id, channels, reminder_channel, language, quiet_hours, created_by)
           VALUES ($1::uuid, kernel.uuid1('app.org_id'), $2::text[], $3, $4, $5::jsonb, kernel.uuid1('app.principal_id'))`,
          [
            patientId,
            channels,
            reminder,
            o['language'],
            quiet === null ? null : JSON.stringify(quiet),
          ],
        );
      } else {
        if (ifMatch === undefined || ifMatch !== Number((existing.rows[0] as Row)['row_version']))
          throw new PreconditionFailedError();
        await tx.query(
          `UPDATE patient.communication_preference SET channels = $2::text[], reminder_channel = $3, language = $4, quiet_hours = $5::jsonb
            WHERE patient_id = $1::uuid AND row_version = $6`,
          [
            patientId,
            channels,
            reminder,
            o['language'],
            quiet === null ? null : JSON.stringify(quiet),
            ifMatch,
          ],
        );
      }
      await this.audit(
        tx,
        meta,
        'patient.communication_preference',
        patientId,
        patientId,
        'update',
        { channels },
      );
    } catch (e) {
      translateDbError(e);
    }
    return (await this.getPreferences(tx, patientId)) as PreferenceView;
  }

  // --- care team (BQ-5 resolver, 22.6) -----------------------------------------------------------------------------

  async listCareTeam(tx: Tx, patientId: string): Promise<CareTeamView[]> {
    const r = await tx.query(
      `SELECT id, patient_id, principal_id, role, from_date::text AS from_date, to_date::text AS to_date
         FROM patient.care_team_member WHERE patient_id = $1::uuid ORDER BY to_date NULLS FIRST, from_date, id`,
      [patientId],
    );
    return r.rows.map((x) => {
      const row = x as Row;
      return {
        id: str(row['id']),
        patientId: str(row['patient_id']),
        principalId: str(row['principal_id']),
        role: str(row['role']),
        fromDate: dateOnly(row['from_date']) as string,
        toDate: dateOnly(row['to_date']),
      };
    });
  }

  async addCareTeamMember(
    tx: Tx,
    meta: RequestMeta,
    patientId: string,
    body: unknown,
  ): Promise<CareTeamView> {
    const o = (typeof body === 'object' && body !== null ? body : {}) as Row;
    const bad: string[] = [];
    if (!isUuid(o['principalId'])) bad.push('principalId');
    if (!['primary_clinician', 'clinician', 'nurse', 'coordinator'].includes(String(o['role'])))
      bad.push('role');
    if (bad.length > 0) throw new PatientValidationError(bad);
    const principalId = o['principalId'] as string;
    if (!(await this.deps.staff.isStaffPrincipal(tx, principalId)))
      throw new PatientValidationError(['principalId']);
    const id = uuidv7();
    try {
      const dup = await tx.query(
        `SELECT 1 FROM patient.care_team_member WHERE patient_id = $1::uuid AND principal_id = $2::uuid AND role = $3 AND to_date IS NULL`,
        [patientId, principalId, o['role']],
      );
      if (dup.rows[0] !== undefined)
        return (await this.listCareTeam(tx, patientId)).find(
          (m) => m.principalId === principalId && m.role === o['role'] && m.toDate === null,
        ) as CareTeamView;
      await tx.query(
        `INSERT INTO patient.care_team_member (id, organisation_id, patient_id, principal_id, role, created_by)
         VALUES ($1::uuid, kernel.uuid1('app.org_id'), $2::uuid, $3::uuid, $4, kernel.uuid1('app.principal_id'))`,
        [id, patientId, principalId, o['role']],
      );
      await this.audit(tx, meta, 'patient.care_team_member', id, patientId, 'create', {
        role: o['role'],
      });
    } catch (e) {
      translateDbError(e);
    }
    return (await this.listCareTeam(tx, patientId)).find((m) => m.id === id) as CareTeamView;
  }

  async endCareTeamMember(
    tx: Tx,
    meta: RequestMeta,
    patientId: string,
    memberId: string,
  ): Promise<void> {
    if (!isUuid(memberId)) throw new PatientNotFoundError();
    try {
      const r = await tx.query(
        `UPDATE patient.care_team_member SET to_date = current_date, end_reason = 'staff'
          WHERE id = $1::uuid AND patient_id = $2::uuid AND to_date IS NULL`,
        [memberId, patientId],
      );
      if ((r.rowCount ?? 0) === 0) throw new PatientNotFoundError();
      await this.audit(tx, meta, 'patient.care_team_member', memberId, patientId, 'update', {
        ended: true,
      });
    } catch (e) {
      translateDbError(e);
    }
  }

  // --- duplicate flags (BR-37 work queue) ----------------------------------------------------------------------------

  /**
   * `GET /duplicate-flags?locationId&status`: the flags of patients cared for at the location. The candidate's ID is shown only
   * when the candidate is inside the caller's scope (the staff_scope read applies the caller's own location filter).
   */
  async listDuplicateFlags(
    tx: Tx,
    q: { locationId: unknown; status?: unknown },
  ): Promise<DuplicateFlagView[]> {
    if (!isUuid(q.locationId)) throw new PatientValidationError(['locationId']);
    const status = q.status ?? 'open';
    if (!['open', 'not_duplicate', 'merge_requested', 'resolved'].includes(String(status)))
      throw new PatientValidationError(['status']);
    const r = await tx.query(
      `SELECT f.id, f.patient_id, f.strength, f.source, f.status, f.created_at,
              CASE WHEN EXISTS (SELECT 1 FROM patient.staff_scope s2 WHERE s2.patient_id = f.candidate_patient_id) THEN f.candidate_patient_id END AS candidate_patient_id
         FROM patient.duplicate_flag f
        WHERE f.status = $2 AND EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = f.patient_id AND s.location_id = $1::uuid)
        ORDER BY f.created_at, f.id LIMIT 100`,
      [q.locationId, status],
    );
    return r.rows.map((x) => {
      const row = x as Row;
      return {
        id: str(row['id']),
        patientId: str(row['patient_id']),
        candidatePatientId: strOrNull(row['candidate_patient_id']),
        strength: row['strength'] === 'exact' ? 'exact' : 'probable',
        source: row['source'] === 'front_desk' ? 'front_desk' : 'self_registration',
        status: str(row['status']),
        createdAt: iso(row['created_at']) as string,
      };
    });
  }

  /** Staff decide that a flag is not a duplicate. Not routed in R1 (the catalogue has no resolve route); kept for the merge flow. */
  async dismissFlag(tx: Tx, meta: RequestMeta, flagId: string): Promise<boolean> {
    if (!isUuid(flagId)) throw new PatientNotFoundError();
    const principal = tx.scope.principalId;
    if (tx.scope.audience !== 'staff' || principal === undefined) throw new PatientScopeError();
    try {
      const r = await tx.query(
        `UPDATE patient.duplicate_flag SET status = 'not_duplicate', resolved_by = $2::uuid, resolved_reason = 'staff'
          WHERE id = $1::uuid AND status = 'open' RETURNING patient_id`,
        [flagId, principal],
      );
      if (r.rows[0] === undefined) return false;
      await this.audit(
        tx,
        meta,
        'patient.duplicate_flag',
        flagId,
        str((r.rows[0] as Row)['patient_id']),
        'update',
        { status: 'not_duplicate' },
      );
      return true;
    } catch (e) {
      translateDbError(e);
    }
  }

  // --- compliance slice (6.7) ----------------------------------------------------------------------------------------

  /**
   * `GET /admin/consents` (slice `consents`, 6.7): consent type, template version, status, timestamps, signer relationship and the
   * signature document. No patient ID: compliance reaches a name only through `identity_label`, with this row's ID as the reference.
   */
  async sliceConsents(
    tx: Tx,
    q: { referenceId?: unknown; limit?: unknown },
  ): Promise<Omit<ConsentView, 'patientId'>[]> {
    const limit = Math.min(
      Math.max(typeof q.limit === 'number' && Number.isInteger(q.limit) ? q.limit : 100, 1),
      200,
    );
    const params: unknown[] = [limit];
    let where = '';
    if (q.referenceId !== undefined && q.referenceId !== null && q.referenceId !== '') {
      if (!isUuid(q.referenceId)) throw new PatientValidationError(['referenceId']);
      params.push(q.referenceId);
      where = `WHERE id = $2::uuid`;
    }
    const r = await tx.query(
      `SELECT id, template_key, template_version, status, signed_at, signer_relationship, withdrawn_at, signature_document_id
         FROM patient.consent ${where} ORDER BY created_at DESC, id LIMIT $1`,
      params,
    );
    return r.rows.map((x) => {
      const row = x as Row;
      return {
        id: str(row['id']),
        templateKey: str(row['template_key']),
        templateVersion: Number(row['template_version']),
        status: row['status'] as ConsentView['status'],
        signedAt: iso(row['signed_at']),
        signerRelationship: strOrNull(row['signer_relationship']),
        signatureDocumentId: strOrNull(row['signature_document_id']),
        withdrawnAt: iso(row['withdrawn_at']),
      };
    });
  }
}

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return tz.length <= 64;
  } catch {
    return false;
  }
}

// `normaliseName` is part of this module's validation vocabulary; re-exported for the controller's use.
export { normaliseName };
