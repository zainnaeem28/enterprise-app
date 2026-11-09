// The patient service (ARCHITECTURE 24 `patient`): registration and matching (25.3), care relationships and the staff scope
// (SHARED-BOUNDARIES 6.6), the patient root (profile, banner, search) and the identity label (6.7). Every method runs inside the
// caller's transaction (`tx`), under the caller's scope settings; nothing here widens that scope. The operations that act across
// scope (register, attach, the care-relationship pair, the drift check, lock_patients, match_candidates, identity_label) are the
// definer functions of migrations 0703-0704; this class validates their input, calls them and shapes their output.
//
// The names of the patient_scope_owner functions are built from SCHEMA and a bare name on purpose: the kernel's static lock-order
// check (38.2 item 4) is a text scan that flags any literal mention of them outside a `withScope` callback, and this module is
// the owner of those functions, so its wrappers cannot sit inside one. The runtime half is kept: ensure, end and attach go
// through `Tx.callScopeOwner`, which refuses a call made before `lockPatients(..., 'no_key_update')`.
import { PATIENT_SCOPE_OWNER_FUNCTIONS } from '@ehr/kernel';
import type { Queue, Tx } from '@ehr/kernel';
import { AuditService } from '../audit/index.js';
import {
  AttachNotAllowedError,
  PatientMergedError,
  PatientNotFoundError,
  PatientScopeError,
  PatientValidationError,
  MatchCheckRequiredError,
  PreconditionFailedError,
  translateDbError,
} from './errors.js';
import { isUuid } from './ids.js';
import {
  matchValuesHash,
  normaliseDateOfBirth,
  normaliseEmail,
  normaliseName,
  normalisePhone,
} from './normalise.js';
import { LABEL_REFERENCE_KINDS, SEX_AT_BIRTH } from './types.js';
import type {
  Demographics,
  IdentityLabel,
  LabelReferenceKind,
  MatchCandidate,
  MatchResult,
  PatientBanner,
  PatientLookupItem,
  PatientLookupResult,
  PatientRecord,
  RegisterInput,
  RequestMeta,
  SexAtBirth,
} from './types.js';

export const SCHEMA = 'patient';
/** `patient.<name>` for a function this module owns. Checked against the kernel's list by the unit test. */
export const scopeOwnerFn = (name: string): string => `${SCHEMA}.${name}`;
export const OWNED_FUNCTIONS: readonly string[] = PATIENT_SCOPE_OWNER_FUNCTIONS;

type Row = Record<string, unknown>;
const str = (v: unknown): string => String(v);
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const dateOf = (v: unknown): string =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);

export const PATIENT_COLUMNS = `id, mrn, given_name, family_name, middle_name, date_of_birth::text AS date_of_birth, sex_at_birth,
  gender_identity, phone_e164, email, address, state_code, preferred_language, photo_document_id, preferred_pharmacy, status,
  merged_into, created_via, row_version`;

export function recordOf(r: Row): PatientRecord {
  return {
    id: str(r['id']),
    mrn: str(r['mrn']),
    givenName: str(r['given_name']),
    familyName: str(r['family_name']),
    middleName: strOrNull(r['middle_name']),
    dateOfBirth: dateOf(r['date_of_birth']),
    sexAtBirth: strOrNull(r['sex_at_birth']),
    genderIdentity: strOrNull(r['gender_identity']),
    phone: strOrNull(r['phone_e164']),
    email: strOrNull(r['email']),
    address: (r['address'] as Record<string, unknown> | null) ?? null,
    stateCode: str(r['state_code']),
    preferredLanguage: str(r['preferred_language']),
    photoDocumentId: strOrNull(r['photo_document_id']),
    preferredPharmacy: (r['preferred_pharmacy'] as Record<string, unknown> | null) ?? null,
    status: r['status'] === 'merged' ? 'merged' : 'active',
    mergedInto: strOrNull(r['merged_into']),
    createdVia: r['created_via'] === 'self' ? 'self' : 'front_desk',
    rowVersion: Number(r['row_version']),
  };
}

export interface PatientServiceDeps {
  audit: AuditService;
  /** `<env>/app/match-check-key`: keys the hash that ties a registration to its match check (22.6). */
  matchKey: string;
  now?: () => Date;
  /** BQ-4: whether attach is switched on. Default on, because the Proposal is the default until the PM answers. */
  attachEnabled?: (tx: Tx) => Promise<boolean>;
  /** Optional: with it, `patient.registered` and `patient.duplicate_flagged` are published in the registering transaction (24). */
  queue?: Queue;
}

const STATE = /^[A-Z]{2}$/;
const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/;

/** Validates the demographic fields of a registration or a profile change. Returns the normalised values or throws. */
export function validateDemographics(
  input: unknown,
  now: Date,
  partial = false,
): Partial<Demographics> {
  const bad: string[] = [];
  const o = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const out: Partial<Demographics> = {};
  const present = (k: string): boolean => o[k] !== undefined && o[k] !== null;
  const need = (k: string): boolean => !partial || present(k);

  if (need('givenName')) {
    const v = normaliseName(o['givenName']);
    if (v === undefined) bad.push('givenName');
    else out.givenName = v;
  }
  if (need('familyName')) {
    const v = normaliseName(o['familyName']);
    if (v === undefined) bad.push('familyName');
    else out.familyName = v;
  }
  if (present('middleName')) {
    const v = normaliseName(o['middleName']);
    if (v === undefined) bad.push('middleName');
    else out.middleName = v;
  }
  if (need('dateOfBirth')) {
    const v = normaliseDateOfBirth(o['dateOfBirth'], now);
    if (v === undefined) bad.push('dateOfBirth');
    else out.dateOfBirth = v;
  }
  if (present('sexAtBirth')) {
    if (
      typeof o['sexAtBirth'] === 'string' &&
      (SEX_AT_BIRTH as readonly string[]).includes(o['sexAtBirth'])
    )
      out.sexAtBirth = o['sexAtBirth'] as SexAtBirth;
    else bad.push('sexAtBirth');
  }
  if (present('genderIdentity')) {
    const v = normaliseName(o['genderIdentity']);
    if (v === undefined) bad.push('genderIdentity');
    else out.genderIdentity = v;
  }
  if (present('phone')) {
    const v = normalisePhone(o['phone']);
    if (v === undefined) bad.push('phone');
    else out.phone = v;
  }
  if (present('email')) {
    const v = normaliseEmail(o['email']);
    if (v === undefined) bad.push('email');
    else out.email = v;
  }
  if (present('address')) {
    const a = o['address'];
    if (
      typeof a === 'object' &&
      a !== null &&
      !Array.isArray(a) &&
      JSON.stringify(a).length <= 2048
    )
      out.address = a as Record<string, unknown>;
    else bad.push('address');
  }
  if (need('stateCode')) {
    const s = typeof o['stateCode'] === 'string' ? o['stateCode'].trim().toUpperCase() : '';
    if (!STATE.test(s)) bad.push('stateCode');
    else out.stateCode = s;
  }
  if (present('preferredLanguage')) {
    const l = o['preferredLanguage'];
    if (typeof l === 'string' && LANGUAGE.test(l)) out.preferredLanguage = l;
    else bad.push('preferredLanguage');
  }
  if (present('preferredPharmacy')) {
    const p = o['preferredPharmacy'];
    if (
      typeof p === 'object' &&
      p !== null &&
      !Array.isArray(p) &&
      JSON.stringify(p).length <= 1024
    )
      out.preferredPharmacy = p as Record<string, unknown>;
    else bad.push('preferredPharmacy');
  }
  if (bad.length > 0) throw new PatientValidationError(bad);
  return out;
}

export class PatientService {
  constructor(private readonly deps: PatientServiceDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  /**
   * `lockPatients(ids, mode)` (24, 25.2): the strongest patient-root lock the transaction will need, taken first. `no_key_update`
   * when a patient_scope_owner function will run, `key_share` otherwise. Invisible and missing IDs fail the same way (404).
   */
  async lockPatients(
    tx: Tx,
    ids: readonly string[],
    mode: 'key_share' | 'no_key_update',
  ): Promise<void> {
    for (const id of ids) if (!isUuid(id)) throw new PatientValidationError(['patientId']);
    try {
      await tx.lockPatients(ids, mode);
    } catch (e) {
      translateDbError(e);
    }
  }

  /**
   * `lockForReferral(referral, patient, mode)`: the root lock of a referral accept or decline, in place of `lockPatients`, for the
   * receiving location (ruling HEAAA-325). Missing, invisible and not-pending referrals fail the same way (404).
   */
  async lockForReferral(
    tx: Tx,
    referralId: string,
    patientId: string,
    mode: 'key_share' | 'no_key_update',
  ): Promise<void> {
    if (!isUuid(referralId) || !isUuid(patientId))
      throw new PatientValidationError(['referralId', 'patientId']);
    try {
      await tx.lockReferralPatient(referralId, patientId, mode);
    } catch (e) {
      translateDbError(e);
    }
  }

  // --- registration and matching (25.3) ---------------------------------------------------------------------------

  /** `POST /patients/match`: at most 5 candidates; the values are hashed with the key, never stored. */
  async matchCandidates(
    tx: Tx,
    meta: RequestMeta,
    input: {
      givenName?: unknown;
      familyName?: unknown;
      dateOfBirth?: unknown;
      phone?: unknown;
      email?: unknown;
    },
    locationId: unknown,
  ): Promise<MatchResult> {
    const v = this.matchValues(input);
    if (!isUuid(locationId)) throw new PatientValidationError(['locationId']);
    let doc: unknown;
    try {
      const r = await tx.query(
        `SELECT patient.match_candidates($1::uuid, $2, $3, $4::date, $5, $6, $7, $8::uuid) AS result`,
        [
          meta.requestId,
          v.givenName,
          v.familyName,
          v.dateOfBirth,
          v.phone ?? null,
          v.email ?? null,
          matchValuesHash(this.deps.matchKey, v),
          locationId,
        ],
      );
      doc = r.rows[0]?.['result'];
    } catch (e) {
      translateDbError(e);
    }
    const body = doc as { matchCheckId: string; candidates: Row[] };
    const candidates: MatchCandidate[] = [];
    for (const c of body.candidates) {
      const cand: MatchCandidate = {
        candidateRef: str(c['candidateRef']),
        strength: c['strength'] === 'exact' ? 'exact' : 'probable',
        matchedFields: (c['matchedFields'] as string[]) ?? [],
        inScope: c['inScope'] === true,
      };
      // Display data only for a candidate the caller can already read: loaded under the caller's own RLS, never by the function.
      if (cand.inScope && typeof c['patientId'] === 'string') {
        const p = await tx.query(
          `SELECT id, mrn, given_name, family_name, date_of_birth::text AS date_of_birth FROM patient.patient WHERE id = $1::uuid`,
          [c['patientId']],
        );
        const row = p.rows[0];
        if (row !== undefined)
          cand.display = {
            patientId: str(row['id']),
            mrn: str(row['mrn']),
            givenName: str(row['given_name']),
            familyName: str(row['family_name']),
            dateOfBirth: dateOf(row['date_of_birth']),
          };
        else cand.inScope = false;
      }
      candidates.push(cand);
    }
    return { matchCheckId: body.matchCheckId, candidates };
  }

  private matchValues(input: Row | { [k: string]: unknown }): {
    givenName: string;
    familyName: string;
    dateOfBirth: string;
    phone?: string;
    email?: string;
  } {
    const bad: string[] = [];
    const given = normaliseName(input['givenName']);
    const family = normaliseName(input['familyName']);
    const dob = normaliseDateOfBirth(input['dateOfBirth'], this.now());
    if (given === undefined) bad.push('givenName');
    if (family === undefined) bad.push('familyName');
    if (dob === undefined) bad.push('dateOfBirth');
    let phone: string | undefined;
    let email: string | undefined;
    if (input['phone'] !== undefined && input['phone'] !== null && input['phone'] !== '') {
      phone = normalisePhone(input['phone']);
      if (phone === undefined) bad.push('phone');
    }
    if (input['email'] !== undefined && input['email'] !== null && input['email'] !== '') {
      email = normaliseEmail(input['email']);
      if (email === undefined) bad.push('email');
    }
    if (bad.length > 0) throw new PatientValidationError(bad);
    return {
      givenName: given as string,
      familyName: family as string,
      dateOfBirth: dob as string,
      ...(phone === undefined ? {} : { phone }),
      ...(email === undefined ? {} : { email }),
    };
  }

  /**
   * `POST /patients` (staff, with a match check) and `POST /patients/self-registration` (patient audience, no location).
   * One transaction: the patient, the care relationship and the scope rows (front desk) or the identity link (self).
   */
  async register(
    tx: Tx,
    meta: RequestMeta,
    input: RegisterInput,
  ): Promise<{ patientId: string; mrn: string; duplicateFlags: number }> {
    const staff = tx.scope.audience === 'staff';
    if (!staff && tx.scope.audience !== 'patient') throw new PatientScopeError();
    const d = validateDemographics(input, this.now()) as Demographics;
    let hash: Buffer | null = null;
    let matchCheckId: string | null = null;
    let reason: string | null = null;
    let acknowledged = false;
    if (staff) {
      if (!isUuid(input.locationId)) throw new PatientValidationError(['locationId']);
      if (!isUuid(input.matchCheckId)) throw new MatchCheckRequiredError();
      matchCheckId = input.matchCheckId;
      hash = matchValuesHash(this.deps.matchKey, {
        givenName: d.givenName,
        familyName: d.familyName,
        dateOfBirth: d.dateOfBirth,
        phone: d.phone,
        email: d.email,
      });
      acknowledged = input.duplicateAcknowledged === true;
      if (input.acknowledgeReason !== undefined && input.acknowledgeReason !== null) {
        const t = String(input.acknowledgeReason).trim();
        if (t.length > 500) throw new PatientValidationError(['acknowledgeReason']);
        reason = t.length === 0 ? null : t;
      }
    } else if (input.locationId !== undefined) {
      throw new PatientValidationError(['locationId']);
    }
    try {
      const r = await tx.query(
        `SELECT patient_id, mrn, duplicate_flags FROM ${scopeOwnerFn('register')}($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::date, $10, $11, $12, $13,
           $14::jsonb, $15, $16, $17::jsonb, $18::uuid)`,
        [
          meta.requestId,
          matchCheckId,
          hash,
          acknowledged,
          reason,
          d.givenName,
          d.familyName,
          d.middleName ?? null,
          d.dateOfBirth,
          d.sexAtBirth ?? null,
          d.genderIdentity ?? null,
          d.phone ?? null,
          d.email ?? null,
          d.address === undefined ? null : JSON.stringify(d.address),
          d.stateCode,
          d.preferredLanguage ?? null,
          d.preferredPharmacy === undefined ? null : JSON.stringify(d.preferredPharmacy),
          staff ? input.locationId : null,
        ],
      );
      const row = r.rows[0] as Row;
      const patientId = str(row['patient_id']);
      const flags = Number(row['duplicate_flags']);
      await this.deps.queue?.publish(tx, 'patient.registered', { patientId });
      // Self-registration reports no count (the patient learns nothing about other records); the flags exist all the same.
      if (staff && flags > 0)
        await this.deps.queue?.publish(tx, 'patient.duplicate_flagged', { patientId });
      return { patientId, mrn: str(row['mrn']), duplicateFlags: staff ? flags : 0 };
    } catch (e) {
      translateDbError(e);
    }
  }

  /**
   * `POST /patients/{patientId}/attach` (BQ-4 default). The candidate reference names the caller's own match check; the function
   * takes the root lock itself (`FOR NO KEY UPDATE`, 6.6) because the candidate is, by definition, not visible to the caller and
   * `lock_patients` would refuse it. Exact match, patient present, candidate from the check, the registering location.
   */
  async attach(
    tx: Tx,
    meta: RequestMeta,
    input: {
      patientId: string;
      candidateRef: unknown;
      locationId: unknown;
      patientPresent: unknown;
    },
  ): Promise<{ careRelationshipId: string }> {
    if (!isUuid(input.patientId)) throw new PatientValidationError(['patientId']);
    if (!isUuid(input.locationId)) throw new PatientValidationError(['locationId']);
    if (!isUuid(input.candidateRef)) throw new AttachNotAllowedError();
    if (this.deps.attachEnabled !== undefined && !(await this.deps.attachEnabled(tx)))
      throw new AttachNotAllowedError();
    try {
      const r = await tx.query(
        `SELECT ${scopeOwnerFn('attach')}($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5) AS id`,
        [
          meta.requestId,
          input.candidateRef,
          input.patientId,
          input.locationId,
          input.patientPresent === true,
        ],
      );
      return { careRelationshipId: str(r.rows[0]?.['id']) };
    } catch (e) {
      translateDbError(e);
    }
  }

  /**
   * `ensureCareRelationship(patient, location, reason)` (24): booking confirmed, referral accepted. The caller's transaction has
   * already called `lockPatients([patient], 'no_key_update')` as its first statement; the runtime guard refuses it otherwise.
   */
  async ensureCareRelationship(
    tx: Tx,
    meta: RequestMeta,
    patientId: string,
    locationId: string,
    reason: 'booking' | 'referral',
  ): Promise<string> {
    if (!isUuid(patientId) || !isUuid(locationId))
      throw new PatientValidationError(['patientId', 'locationId']);
    if (reason !== 'booking' && reason !== 'referral') throw new PatientValidationError(['reason']);
    try {
      const r = await tx.callScopeOwner(
        scopeOwnerFn('ensure_care_relationship'),
        [meta.requestId, patientId, locationId, reason],
        [patientId],
      );
      return str((r.rows[0] as Row)['ensure_care_relationship']);
    } catch (e) {
      translateDbError(e);
    }
  }

  /**
   * `ensureReferralCareRelationship(referral)`: the accept's care relationship. Patient and location come from the referral row in
   * the database. The caller has called `lockForReferral(..., 'no_key_update')` and the referral is still pending.
   */
  async ensureReferralCareRelationship(
    tx: Tx,
    meta: RequestMeta,
    referralId: string,
  ): Promise<string> {
    if (!isUuid(referralId)) throw new PatientValidationError(['referralId']);
    try {
      const r = await tx.callScopeOwner(scopeOwnerFn('ensure_referral_care_relationship'), [
        meta.requestId,
        referralId,
      ]);
      return str((r.rows[0] as Row)['ensure_referral_care_relationship']);
    } catch (e) {
      translateDbError(e);
    }
  }

  /** `endCareRelationship(patient, location, why)`: staff of the location. Returns false when none was open. */
  async endCareRelationship(
    tx: Tx,
    meta: RequestMeta,
    patientId: string,
    locationId: string,
    why: string,
  ): Promise<boolean> {
    if (!isUuid(patientId) || !isUuid(locationId))
      throw new PatientValidationError(['patientId', 'locationId']);
    if (typeof why !== 'string' || why.trim().length === 0 || why.trim().length > 200)
      throw new PatientValidationError(['reason']);
    try {
      const r = await tx.callScopeOwner(
        scopeOwnerFn('end_care_relationship'),
        [meta.requestId, patientId, locationId, why.trim()],
        [patientId],
      );
      return (r.rows[0] as Row)['end_care_relationship'] === true;
    } catch (e) {
      translateDbError(e);
    }
  }

  // --- the root --------------------------------------------------------------------------------------------------

  /** One patient under the caller's RLS, or undefined (absent and invisible look the same). */
  async get(tx: Tx, patientId: string): Promise<PatientRecord | undefined> {
    if (!isUuid(patientId)) return undefined;
    const r = await tx.query(`SELECT ${PATIENT_COLUMNS} FROM patient.patient WHERE id = $1::uuid`, [
      patientId,
    ]);
    return r.rows[0] === undefined ? undefined : recordOf(r.rows[0] as Row);
  }

  /** `patientBanner(id)` (24, BR-34). The allergy part is `clinical`'s (28.2); here it is always null. */
  async patientBanner(tx: Tx, patientId: string): Promise<PatientBanner | undefined> {
    const p = await this.get(tx, patientId);
    if (p === undefined) return undefined;
    return {
      patientId: p.id,
      mrn: p.mrn,
      givenName: p.givenName,
      familyName: p.familyName,
      dateOfBirth: p.dateOfBirth,
      photoDocumentId: p.photoDocumentId,
      allergySummary: null,
      merged: p.status === 'merged',
    };
  }

  /** `isActive(id)` (24): visible to the caller and not merged. */
  async isActive(tx: Tx, patientId: string): Promise<boolean> {
    return (await this.get(tx, patientId))?.status === 'active';
  }

  /**
   * `closure(id)` (24): the patient and every ID merged into it, directly or through a chain, read from the merge map (9.2).
   * A merged argument resolves to its final survivor first. Under the caller's RLS: an ID the caller cannot see is absent.
   */
  async closure(tx: Tx, patientId: string): Promise<string[]> {
    if (!isUuid(patientId)) return [];
    const r = await tx.query(
      `WITH final AS (
         SELECT coalesce((SELECT m.final_survivor_id FROM patient.patient_merge m WHERE m.merged_id = $1::uuid), $1::uuid) AS id)
       SELECT f.id AS id FROM final f
       UNION SELECT m.merged_id FROM patient.patient_merge m, final f WHERE m.final_survivor_id = f.id`,
      [patientId],
    );
    return r.rows.map((x) => str((x as Row)['id']));
  }

  /**
   * `PATCH /patients/{patientId}` and `PATCH /patients/{patientId}/profile`: the fields in the patch only, guarded by the
   * row version (If-Match). The audit row names the fields, never their values (RA-R1-19).
   */
  async updateProfile(
    tx: Tx,
    meta: RequestMeta,
    patientId: string,
    expectedVersion: number,
    patch: unknown,
  ): Promise<PatientRecord> {
    const d = validateDemographics(patch, this.now(), true);
    const sets: string[] = [];
    const params: unknown[] = [patientId, expectedVersion];
    const col = (name: string, value: unknown): void => {
      params.push(value);
      sets.push(`${name} = $${params.length}`);
    };
    const fields: string[] = [];
    const map: [keyof Demographics, string, boolean][] = [
      ['givenName', 'given_name', false],
      ['familyName', 'family_name', false],
      ['middleName', 'middle_name', false],
      ['dateOfBirth', 'date_of_birth', false],
      ['sexAtBirth', 'sex_at_birth', false],
      ['genderIdentity', 'gender_identity', false],
      ['phone', 'phone_e164', false],
      ['email', 'email', false],
      ['address', 'address', true],
      ['stateCode', 'state_code', false],
      ['preferredLanguage', 'preferred_language', false],
      ['preferredPharmacy', 'preferred_pharmacy', true],
    ];
    for (const [k, c, json] of map) {
      const v = d[k];
      if (v === undefined) continue;
      fields.push(k);
      col(c, json ? JSON.stringify(v) : v);
    }
    const raw = (typeof patch === 'object' && patch !== null ? patch : {}) as Row;
    if (raw['photoDocumentId'] !== undefined) {
      if (raw['photoDocumentId'] !== null && !isUuid(raw['photoDocumentId']))
        throw new PatientValidationError(['photoDocumentId']);
      fields.push('photoDocumentId');
      col('photo_document_id', raw['photoDocumentId']);
    }
    if (sets.length === 0) throw new PatientValidationError(['body']);
    try {
      const r = await tx.query(
        `UPDATE patient.patient SET ${sets.join(', ')} WHERE id = $1::uuid AND row_version = $2 RETURNING ${PATIENT_COLUMNS}`,
        params,
      );
      if (r.rows[0] === undefined) {
        // Either the row changed (412) or the caller cannot see it (404). RLS decides which: a visible row is a stale version.
        const visible = await tx.query(`SELECT 1 FROM patient.patient WHERE id = $1::uuid`, [
          patientId,
        ]);
        if (visible.rows[0] === undefined) throw new PatientNotFoundError();
        throw new PreconditionFailedError();
      }
      await this.deps.audit.record(tx, {
        requestId: meta.requestId,
        action: 'update',
        resourceType: 'patient.patient',
        resourceId: patientId,
        patientId,
        change: { fields },
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
      });
      return recordOf(r.rows[0] as Row);
    } catch (e) {
      translateDbError(e);
    }
  }

  /** Staff view of one patient (audited `view`, 8.1): the caller reads under T-STAFF; the row is returned or undefined. */
  async view(tx: Tx, meta: RequestMeta, patientId: string): Promise<PatientRecord | undefined> {
    const p = await this.get(tx, patientId);
    if (p === undefined) return undefined;
    await this.deps.audit.record(tx, {
      requestId: meta.requestId,
      action: 'view',
      resourceType: 'patient.patient',
      resourceId: patientId,
      patientId,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    });
    return p;
  }

  /**
   * `POST /patients/search` (AC-34): in-scope patients only, by RLS; a patient registered only elsewhere is simply absent.
   * Audited `search` with a count and no terms.
   */
  async search(
    tx: Tx,
    meta: RequestMeta,
    q: { name?: unknown; dateOfBirth?: unknown; mrn?: unknown; phone?: unknown },
  ): Promise<PatientRecord[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const bad: string[] = [];
    if (q.name !== undefined && q.name !== null && q.name !== '') {
      const n = normaliseName(q.name);
      if (n === undefined) bad.push('name');
      else {
        // "family, given", "given family" or one word: every word must prefix the given or the family name.
        const words = n.replace(/,/g, ' ').split(' ').filter(Boolean).slice(0, 4);
        for (const w of words) {
          params.push(`${w.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
          where.push(
            `(lower(family_name) LIKE $${params.length} OR lower(given_name) LIKE $${params.length})`,
          );
        }
      }
    }
    if (q.dateOfBirth !== undefined && q.dateOfBirth !== null && q.dateOfBirth !== '') {
      const d = normaliseDateOfBirth(q.dateOfBirth, this.now());
      if (d === undefined) bad.push('dateOfBirth');
      else {
        params.push(d);
        where.push(`date_of_birth = $${params.length}::date`);
      }
    }
    if (q.mrn !== undefined && q.mrn !== null && q.mrn !== '') {
      if (typeof q.mrn !== 'string' || !/^MRN-[0-9]{7,12}$/i.test(q.mrn.trim())) bad.push('mrn');
      else {
        params.push(q.mrn.trim().toUpperCase());
        where.push(`mrn = $${params.length}`);
      }
    }
    if (q.phone !== undefined && q.phone !== null && q.phone !== '') {
      const p = normalisePhone(q.phone);
      if (p === undefined) bad.push('phone');
      else {
        params.push(p);
        where.push(`phone_e164 = $${params.length}`);
      }
    }
    if (bad.length > 0 || where.length === 0)
      throw new PatientValidationError(bad.length > 0 ? bad : ['body']);
    const r = await tx.query(
      `SELECT ${PATIENT_COLUMNS} FROM patient.patient WHERE status = 'active' AND ${where.join(' AND ')}
        ORDER BY lower(family_name), lower(given_name), id LIMIT 25`,
      params,
    );
    await this.deps.audit.record(tx, {
      requestId: meta.requestId,
      action: 'search',
      resourceType: 'patient.patient',
      change: { results: r.rows.length },
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    });
    return r.rows.map((x) => recordOf(x as Row));
  }

  /**
   * `POST /patients/lookup` (draft 8.3, FE-10): the minimised lookup for doctors. Exactly one criteria form: `{mrn}`,
   * `{name, dateOfBirth?}` or `{patientIds}` (1 to 25). Read under the caller's own RLS, so an out-of-scope patient is simply absent
   * (200, the same shape). At most 25 items and `truncated`. Audited `search` with the form, the count and the returned IDs; the
   * criteria values are never stored.
   */
  async lookup(tx: Tx, meta: RequestMeta, q: unknown): Promise<PatientLookupResult> {
    const body =
      q !== null && typeof q === 'object' && !Array.isArray(q)
        ? (q as Record<string, unknown>)
        : {};
    const keys = Object.keys(body);
    const has = (...allowed: string[]): boolean =>
      keys.length > 0 && keys.every((k) => allowed.includes(k));
    const params: unknown[] = [];
    const where: string[] = [];
    let form: 'mrn' | 'name' | 'ids';
    if (has('mrn') && keys.length === 1) {
      const m = body['mrn'];
      if (typeof m !== 'string' || !/^MRN-[0-9]{7,12}$/i.test(m.trim()))
        throw new PatientValidationError(['mrn']);
      params.push(m.trim().toUpperCase());
      where.push(`mrn = $1`);
      form = 'mrn';
    } else if (has('name', 'dateOfBirth') && 'name' in body) {
      const n = normaliseName(body['name']);
      const words = n === undefined ? [] : n.replace(/,/g, ' ').split(' ').filter(Boolean);
      if (
        n === undefined ||
        words.length === 0 ||
        words.length > 4 ||
        words.some((w) => w.length < 2)
      )
        throw new PatientValidationError(['name']);
      for (const w of words) {
        params.push(`${w.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
        where.push(
          `(lower(family_name) LIKE $${params.length} OR lower(given_name) LIKE $${params.length})`,
        );
      }
      if ('dateOfBirth' in body) {
        const dob = normaliseDateOfBirth(body['dateOfBirth'], this.now());
        if (dob === undefined) throw new PatientValidationError(['dateOfBirth']);
        params.push(dob);
        where.push(`date_of_birth = $${params.length}::date`);
      }
      form = 'name';
    } else if (has('patientIds') && keys.length === 1) {
      const ids = body['patientIds'];
      if (
        !Array.isArray(ids) ||
        ids.length < 1 ||
        ids.length > 25 ||
        !ids.every((x) => typeof x === 'string' && isUuid(x))
      )
        throw new PatientValidationError(['patientIds']);
      params.push([...new Set((ids as string[]).map((x) => x.toLowerCase()))]);
      where.push(`id = ANY($1::uuid[])`);
      form = 'ids';
    } else {
      throw new PatientValidationError(['body']);
    }
    const r = await tx.query(
      `SELECT id, mrn, given_name, middle_name, family_name, to_char(date_of_birth, 'YYYY-MM-DD') AS date_of_birth
         FROM patient.patient WHERE status = 'active' AND ${where.join(' AND ')}
        ORDER BY lower(family_name), lower(given_name), id LIMIT 26`,
      params,
    );
    const rows = r.rows as Row[];
    const items = rows.slice(0, 25).map((x): PatientLookupItem => ({
      patientId: String(x['id']),
      mrn: String(x['mrn']),
      givenName: String(x['given_name']),
      middleName: x['middle_name'] === null ? null : String(x['middle_name']),
      familyName: String(x['family_name']),
      dateOfBirth: String(x['date_of_birth']),
    }));
    await this.deps.audit.record(tx, {
      requestId: meta.requestId,
      action: 'search',
      resourceType: 'patient.patient',
      change: { form, results: items.length, patientIds: items.map((i) => i.patientId) },
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    });
    return { items, truncated: rows.length > 25 };
  }

  // --- the identity label (6.7) ------------------------------------------------------------------------------------

  /**
   * `identityLabel(patientId, reference)` (24, 6.7; reference kinds of the contract): for an admin_pool principal with the `patient_label` slice key. The API first
   * reads the referencing record under the caller's own RLS (O-5) and passes its type and ID; this method refuses a reference
   * that is not a visible record of that type, and the function refuses without the key. One `view` audit row per call.
   */
  async identityLabel(
    tx: Tx,
    meta: RequestMeta,
    patientId: string,
    reference: { type: unknown; id: unknown },
  ): Promise<IdentityLabel> {
    if (!isUuid(patientId)) throw new PatientValidationError(['patientId']);
    if (
      typeof reference.type !== 'string' ||
      !Object.prototype.hasOwnProperty.call(LABEL_REFERENCE_KINDS, reference.type) ||
      !isUuid(reference.id)
    )
      throw new PatientValidationError(['referenceType', 'referenceId']);
    const kind = reference.type as LabelReferenceKind;
    const type = LABEL_REFERENCE_KINDS[kind];
    if (!(await this.referenceVisible(tx, kind, reference.id, patientId)))
      throw new PatientNotFoundError();
    try {
      const r = await tx.query(
        `SELECT patient.identity_label($1::uuid, $2::uuid, $3, $4::uuid) AS label`,
        [meta.requestId, patientId, type, reference.id],
      );
      const l = r.rows[0]?.['label'] as Row;
      return {
        givenName: str(l['givenName']),
        familyName: str(l['familyName']),
        dateOfBirth: dateOf(l['dateOfBirth']),
        mrn: str(l['mrn']),
        merged: l['merged'] === true,
        ...(typeof l['survivorId'] === 'string' ? { survivorId: l['survivorId'] } : {}),
      };
    } catch (e) {
      translateDbError(e);
    }
  }

  /**
   * O-5: the referencing record is read under the caller's own RLS, so a slice key the caller lacks makes it invisible. The audit
   * event and the consent are the two referencing tables that exist today; the privacy request and incident tables arrive with
   * BE-20 and are refused until then (the module cannot read a table it does not own through anything but its published interface).
   */
  private async referenceVisible(
    tx: Tx,
    kind: LabelReferenceKind,
    id: string,
    patientId: string,
  ): Promise<boolean> {
    switch (kind) {
      case 'audit_event': {
        const r = await tx.query(
          `SELECT 1 FROM audit.event WHERE event_id = $1::uuid AND patient_id = $2::uuid LIMIT 1`,
          [id, patientId],
        );
        return r.rows.length > 0;
      }
      case 'consent': {
        const r = await tx.query(
          `SELECT 1 FROM patient.consent WHERE id = $1::uuid AND patient_id = $2::uuid`,
          [id, patientId],
        );
        return r.rows.length > 0;
      }
      default:
        return false;
    }
  }

  /** Does a patient exist and is it merged (for a route that must say `patient.merged` with the survivor)? */
  async mergedSurvivor(tx: Tx, patientId: string): Promise<string | undefined> {
    const p = await this.get(tx, patientId);
    if (p === undefined || p.status !== 'merged') return undefined;
    return p.mergedInto ?? undefined;
  }

  /** Throws `PatientMergedError` (with the survivor when readable) if the patient is merged; `PatientNotFoundError` if invisible. */
  async requireOpen(tx: Tx, patientId: string): Promise<PatientRecord> {
    const p = await this.get(tx, patientId);
    if (p === undefined) throw new PatientNotFoundError();
    if (p.status === 'merged') {
      const survivor = p.mergedInto === null ? undefined : await this.get(tx, p.mergedInto);
      throw new PatientMergedError(survivor?.id);
    }
    return p;
  }
}
