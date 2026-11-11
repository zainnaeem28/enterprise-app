// identity.proxy_grant (ARCHITECTURE 4, 22.4, ST-06; owner ruling 2026-11-11 C item 3, D-7, RA-R1-20a/20b). The table, its RLS and the
// scope contribution are owned here; other modules read them only through this interface (`patientAccessOf`, `listForPatient`).
//
//   * The default scope is appointments only. The patient grants `messages` and `documents` one by one (`setScopes`).
//   * An adult patient invites a proxy by e-mail (`invite`); staff link a parent or guardian of a minor after checking the
//     relationship document (`staffLink`). Both create an invitation that the proxy accepts with an account whose own address is the
//     invited one AND the e-mail code sent to that address (`accept`). The code is made, hashed and mailed by the worker job
//     `identity.send_proxy_invite`; this tier never sees it before the proxy types it.
//   * A guardian grant carries the dates the age rules need (valid_until = last day of access, adolescent_from = the 13th birthday).
//     The scope builder and the row-level security read them through identity.proxy_effective_scopes, so ages 13-17 are
//     appointments only and access ends on the 18th birthday without any job having run (the job tidies and sends the notice).
//   * Patient or staff revoke, a proxy leaves; each is effective in the next request because access is rebuilt from the table.
//   * Every change is audited in the same transaction.
// Every value (18, 13, the notice days, the invitation lifetime, the attempts) is a kernel.setting row (settings-catalogue.ts).
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Queue, Tx } from '@ehr/kernel';
import type { AuditService } from '../audit/index.js';
import {
  IdentityScopeError,
  IdentityValidationError,
  ProxyConflictError,
  ProxyNotAllowedError,
  ProxyRulesNotConfiguredError,
} from './errors.js';
import { isUuid, uuidv7 } from './ids.js';
import { PROXY_SCOPES } from './types.js';
import type { PatientAccess, ProxyScope } from './types.js';

export const PROXY_RELATIONSHIPS = ['parent', 'guardian', 'carer', 'other'] as const;
export type ProxyRelationship = (typeof PROXY_RELATIONSHIPS)[number];

/** The relationships staff may link for a minor (a carer or "other" is the patient's own choice once they are adult). */
export const GUARDIAN_RELATIONSHIPS = ['parent', 'guardian'] as const;

/** The classes of document that can show a relationship (birth certificate, court order, signed consent, an upload staff reviewed). */
export const RELATIONSHIP_DOCUMENT_CLASSES = [
  'id_document',
  'consent',
  'external_record',
  'patient_upload_other',
] as const;

export const SEND_INVITE_JOB = 'identity.send_proxy_invite';

/** The settings the rules read (values in settings-catalogue.ts). */
export const PROXY_SETTING_KEYS = [
  'proxy_age_of_majority',
  'proxy_adolescent_min_age',
  'proxy_age_out_notice_days',
  'proxy_invite_hours',
  'proxy_code_max_attempts',
] as const;
export type ProxySettingKey = (typeof PROXY_SETTING_KEYS)[number];

export interface ProxyRequestMeta {
  requestId: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface ProxyGrantView {
  id: string;
  patientId: string;
  relationship: ProxyRelationship;
  /** The legacy field: always `appointments` (the default scope). `scopes` is what was granted. */
  scope: 'appointments';
  /** Granted by the patient (staff for a minor under the adolescent age). */
  scopes: ProxyScope[];
  /** In force today: the grant, narrowed by the age rules and by validity. */
  effectiveScopes: ProxyScope[];
  guardian: boolean;
  patientDisplayName: string;
  /** `invited`: waiting for the proxy to accept; the other values are the stored status. */
  status: 'invited' | 'requested' | 'verified' | 'active' | 'revoked' | 'expired';
  /** Masked address of an open invitation, for the person who sent it. */
  inviteeHint?: string;
  validUntil?: string;
}

const COLS = `id, patient_id, relationship, patient_display_name, status, scopes, guardian, proxy_principal_id, invited_email, valid_until,
  identity.proxy_effective_scopes(scopes, guardian, adolescent_from, valid_until) AS effective_scopes`;

const maskEmail = (e: string): string => {
  const at = e.lastIndexOf('@');
  return at < 1 ? '***' : `${e.slice(0, 1)}***${e.slice(at)}`;
};

const scopesOf = (v: unknown): ProxyScope[] =>
  (Array.isArray(v) ? v : []).filter((x): x is ProxyScope =>
    (PROXY_SCOPES as readonly string[]).includes(String(x)),
  );

const iso = (v: unknown): string | undefined =>
  v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === 'string' ? v.slice(0, 10) : undefined;

const view = (r: Record<string, unknown>): ProxyGrantView => {
  const open = r['status'] === 'requested' || r['status'] === 'verified';
  const invited = open && r['proxy_principal_id'] === null;
  const validUntil = iso(r['valid_until']);
  return {
    id: r['id'] as string,
    patientId: r['patient_id'] as string,
    relationship: r['relationship'] as ProxyRelationship,
    scope: 'appointments',
    scopes: scopesOf(r['scopes']),
    effectiveScopes: r['status'] === 'active' ? scopesOf(r['effective_scopes']) : [],
    guardian: r['guardian'] === true,
    patientDisplayName: r['patient_display_name'] as string,
    status: invited ? 'invited' : (r['status'] as ProxyGrantView['status']),
    ...(invited && typeof r['invited_email'] === 'string'
      ? { inviteeHint: maskEmail(r['invited_email']) }
      : {}),
    ...(validUntil === undefined ? {} : { validUntil }),
  };
};

const EMAIL = /^[^\s@<>()[\],;:\\"]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,24}$/;

/** Validates and normalises a scope list: appointments always, only known scopes, no duplicates. */
export function normaliseScopes(input: unknown): ProxyScope[] | undefined {
  if (input === undefined) return ['appointments'];
  if (!Array.isArray(input)) return undefined;
  const out = new Set<ProxyScope>(['appointments']);
  for (const s of input) {
    if (typeof s !== 'string' || !(PROXY_SCOPES as readonly string[]).includes(s)) return undefined;
    out.add(s as ProxyScope);
  }
  return PROXY_SCOPES.filter((s) => out.has(s));
}

/** SHA-256(salt || code). The code is short and single-use; the attempts limit, not the hash, is what stops guessing. */
export function hashInviteCode(salt: Buffer, code: string): Buffer {
  return createHash('sha256').update(salt).update(code, 'utf8').digest();
}

export interface ProxyServiceDeps {
  audit: AuditService;
  queue: Queue;
  now?: () => Date;
}

export type AcceptOutcome =
  | { kind: 'accepted'; grant: ProxyGrantView }
  | { kind: 'invalid' };

export class ProxyService {
  constructor(private readonly deps: ProxyServiceDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  /** An organisation setting as a positive integer; a missing row fails closed (the rules are not configured). */
  async intSetting(tx: Tx, key: ProxySettingKey): Promise<number> {
    const r = await tx.query(
      `SELECT value FROM kernel.setting WHERE key = $1 AND location_id IS NULL`,
      [key],
    );
    const v = r.rows[0]?.['value'];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new ProxyRulesNotConfiguredError();
    return v;
  }

  private async audit(
    tx: Tx,
    meta: ProxyRequestMeta,
    action: 'create' | 'update',
    grantId: string,
    patientId: string,
    change: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.audit.record(tx, {
      requestId: meta.requestId,
      action,
      resourceType: 'identity.proxy_grant',
      resourceId: grantId,
      patientId,
      change,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    });
  }

  /**
   * A signed-in account asks for access to a patient it already knows: a `requested` row for itself and nothing more. No route calls this
   * since ruling C (invitations replaced the self-request); it stays because the T-PRINCIPAL(proxy) INSERT policy it exercises stays.
   */
  async request(
    tx: Tx,
    input: { patientId: string; relationship: ProxyRelationship; patientDisplayName: string },
  ): Promise<string> {
    const principalId = tx.scope.principalId;
    if (tx.scope.audience !== 'patient' || principalId === undefined || tx.scope.orgId === undefined)
      throw new IdentityScopeError();
    const bad: string[] = [];
    if (!isUuid(input.patientId)) bad.push('patientId');
    if (!PROXY_RELATIONSHIPS.includes(input.relationship)) bad.push('relationship');
    const name = input.patientDisplayName.trim();
    if (name.length < 1 || name.length > 100) bad.push('patientDisplayName');
    if (bad.length > 0) throw new IdentityValidationError(bad);
    const id = uuidv7();
    await tx.query(
      `INSERT INTO identity.proxy_grant (id, organisation_id, proxy_principal_id, patient_id, relationship, scope, patient_display_name, status, created_by)
       VALUES ($1, $2, $3, $4, $5, 'appointments', $6, 'requested', $3)`,
      [id, tx.scope.orgId, principalId, input.patientId, input.relationship, name],
    );
    return id;
  }

  /** A patient session on its own record (never as a proxy). */
  private selfScope(tx: Tx, patientId: string): string {
    const s = tx.scope;
    if (
      s.audience !== 'patient' ||
      s.principalId === undefined ||
      s.orgId === undefined ||
      !(s.patientIds ?? []).includes(patientId) ||
      (s.proxyPatientIds ?? []).includes(patientId)
    )
      throw new IdentityScopeError();
    return s.principalId;
  }

  private async queueInvite(tx: Tx, grantId: string): Promise<void> {
    await this.deps.queue.enqueue(tx, SEND_INVITE_JOB, { grantId }, { jobKey: `proxy_invite_${grantId}` });
  }

  /**
   * The patient invites a proxy. Patient only, adult only (the age of majority is a setting): a minor's guardians are linked by staff.
   * Creates the invitation; the worker mails the code to the address.
   */
  async invite(
    tx: Tx,
    meta: ProxyRequestMeta,
    patientId: string,
    input: { email: unknown; relationship: unknown; scopes?: unknown },
  ): Promise<ProxyGrantView> {
    if (!isUuid(patientId)) throw new IdentityValidationError(['patientId']);
    const principalId = this.selfScope(tx, patientId);
    const bad: string[] = [];
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    if (!EMAIL.test(email) || email.length > 254) bad.push('email');
    const relationship = input.relationship as ProxyRelationship;
    if (!PROXY_RELATIONSHIPS.includes(relationship)) bad.push('relationship');
    const scopes = normaliseScopes(input.scopes);
    if (scopes === undefined) bad.push('scopes');
    if (bad.length > 0 || scopes === undefined) throw new IdentityValidationError(bad);

    const majority = await this.intSetting(tx, 'proxy_age_of_majority');
    const p = (
      await tx.query(
        `SELECT given_name, family_name, date_of_birth,
                (date_of_birth + make_interval(years => $2::int))::date <= current_date AS adult
           FROM patient.patient WHERE id = $1`,
        [patientId, majority],
      )
    ).rows[0];
    if (p === undefined) throw new IdentityScopeError();
    if (p['adult'] !== true) throw new ProxyNotAllowedError();
    const self = await tx.query(`SELECT 1 FROM identity.principal WHERE id = $1 AND email = $2`, [
      principalId,
      email,
    ]);
    if (self.rows.length > 0) throw new ProxyNotAllowedError(); // inviting yourself

    const given = String(p['given_name']).trim();
    const family = String(p['family_name']).trim();
    const display = `${given} ${family.slice(0, 1)}.`.slice(0, 100);
    const id = uuidv7();
    try {
      await tx.query(
        `INSERT INTO identity.proxy_grant (id, organisation_id, proxy_principal_id, patient_id, relationship, scope, scopes, patient_display_name,
                                           status, source, invited_email, created_by)
         VALUES ($1, $2, NULL, $3, $4, 'appointments', $5::text[], $6, 'requested', 'patient_invite', $7, $8)`,
        [id, tx.scope.orgId, patientId, relationship, scopes, display, email, principalId],
      );
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ProxyConflictError();
      throw e;
    }
    await this.queueInvite(tx, id);
    await this.audit(tx, meta, 'create', id, patientId, {
      event: 'proxy_invited',
      relationship,
      scopes,
    });
    return this.one(tx, id);
  }

  /**
   * Staff link a parent or guardian of a minor. Staff of a location the patient is cared for at (the policy), holding
   * `identity.proxy.verify` (the route), after checking a relationship document of THIS patient. Creates a verified invitation.
   */
  async staffLink(
    tx: Tx,
    meta: ProxyRequestMeta,
    patientId: string,
    input: { email: unknown; relationship: unknown; documentId: unknown; scopes?: unknown },
  ): Promise<ProxyGrantView> {
    const s = tx.scope;
    if (s.audience !== 'staff' || s.principalId === undefined || s.orgId === undefined)
      throw new IdentityScopeError();
    if (!isUuid(patientId)) throw new IdentityValidationError(['patientId']);
    const bad: string[] = [];
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    if (!EMAIL.test(email) || email.length > 254) bad.push('email');
    const relationship = input.relationship as (typeof GUARDIAN_RELATIONSHIPS)[number];
    if (!GUARDIAN_RELATIONSHIPS.includes(relationship)) bad.push('relationship');
    if (!isUuid(input.documentId)) bad.push('documentId');
    const requested = normaliseScopes(input.scopes);
    if (requested === undefined) bad.push('scopes');
    if (bad.length > 0 || requested === undefined || !isUuid(input.documentId))
      throw new IdentityValidationError(bad);

    const majority = await this.intSetting(tx, 'proxy_age_of_majority');
    const adolescent = await this.intSetting(tx, 'proxy_adolescent_min_age');
    const p = (
      await tx.query(
        `SELECT given_name, family_name, date_of_birth, status,
                (date_of_birth + make_interval(years => $2::int))::date > current_date AS minor,
                (date_of_birth + make_interval(years => $3::int))::date > current_date AS under_adolescent
           FROM patient.patient WHERE id = $1`,
        [patientId, majority, adolescent],
      )
    ).rows[0];
    if (p === undefined || p['status'] !== 'active') throw new IdentityScopeError();
    // Guardian access exists for minors only; an adult patient invites their own proxies.
    if (p['minor'] !== true) throw new ProxyNotAllowedError();
    // The relationship document is the evidence: a clean, released document of this patient, of a class that can show a relationship.
    const doc = await tx.query(
      `SELECT 1 FROM documents.document
        WHERE id = $1 AND patient_id = $2 AND status IN ('clean', 'confirmed') AND classification = ANY($3::text[])`,
      [input.documentId, patientId, RELATIONSHIP_DOCUMENT_CLASSES],
    );
    if (doc.rows.length === 0) throw new ProxyNotAllowedError();
    // From the adolescent age on the guardian keeps appointments only whatever is asked; below it staff may grant more.
    const scopes: ProxyScope[] = p['under_adolescent'] === true ? requested : ['appointments'];

    const given = String(p['given_name']).trim();
    const family = String(p['family_name']).trim();
    const display = `${given} ${family.slice(0, 1)}.`.slice(0, 100);
    const id = uuidv7();
    try {
      await tx.query(
        `INSERT INTO identity.proxy_grant (id, organisation_id, proxy_principal_id, patient_id, relationship, scope, scopes, patient_display_name,
                                           status, source, invited_email, guardian, patient_birth_date, adolescent_from, valid_until,
                                           verified_by, verification_document_id, created_by)
         SELECT $1::uuid, $2::uuid, NULL, $3::uuid, $4::text, 'appointments', $5::text[], $6::text, 'verified', 'staff_link', $7::text, true, pt.date_of_birth,
                (pt.date_of_birth + make_interval(years => $9::int))::date,
                (pt.date_of_birth + make_interval(years => $10::int))::date - 1,
                $8::uuid, $11::uuid, $8::uuid
           FROM patient.patient pt WHERE pt.id = $3::uuid`,
        [id, s.orgId, patientId, relationship, scopes, display, email, s.principalId, adolescent, majority, input.documentId],
      );
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ProxyConflictError();
      throw e;
    }
    await this.queueInvite(tx, id);
    await this.audit(tx, meta, 'create', id, patientId, {
      event: 'guardian_linked',
      relationship,
      scopes,
      verificationDocumentId: input.documentId,
    });
    return this.one(tx, id);
  }

  /**
   * The proxy accepts with the e-mail code. Returns `invalid` (the controller answers 422 after this transaction commits, so the
   * attempt that was counted stays counted). The grant is visible only to the account whose own address was invited (RLS); the code
   * is the second factor. Wrong code, expired, used up, unknown id and another person's invitation are all the same answer.
   */
  async accept(tx: Tx, meta: ProxyRequestMeta, grantId: string, code: unknown): Promise<AcceptOutcome> {
    const principalId = tx.scope.principalId;
    if (tx.scope.audience !== 'patient' || principalId === undefined || tx.scope.orgId === undefined)
      throw new IdentityScopeError();
    if (!isUuid(grantId)) throw new IdentityValidationError(['grantId']);
    if (typeof code !== 'string' || !/^[0-9]{6,10}$/.test(code)) throw new IdentityValidationError(['code']);
    const maxAttempts = await this.intSetting(tx, 'proxy_code_max_attempts');

    const g = (
      await tx.query(
        `SELECT g.id, g.patient_id, g.guardian, g.source FROM identity.proxy_grant g
          WHERE g.id = $1 AND g.proxy_principal_id IS NULL AND g.status IN ('requested', 'verified') FOR UPDATE`,
        [grantId],
      )
    ).rows[0];
    if (g === undefined) return { kind: 'invalid' };
    const c = (
      await tx.query(
        `SELECT salt, code_hash, attempts, expires_at > now() AS live FROM identity.proxy_invite_code WHERE grant_id = $1 FOR UPDATE`,
        [grantId],
      )
    ).rows[0];
    if (c === undefined || c['live'] !== true || Number(c['attempts']) >= maxAttempts) return { kind: 'invalid' };
    await tx.query(`UPDATE identity.proxy_invite_code SET attempts = attempts + 1 WHERE grant_id = $1`, [grantId]);
    const given = hashInviteCode(c['salt'] as Buffer, code);
    const want = c['code_hash'] as Buffer;
    if (given.length !== want.length || !timingSafeEqual(given, want)) return { kind: 'invalid' };

    // The patient is never their own proxy (their own link already gives them full access).
    const own = await tx.query(
      `SELECT 1 FROM identity.patient_link WHERE principal_id = $1 AND patient_id = $2`,
      [principalId, g['patient_id']],
    );
    if (own.rows.length > 0) return { kind: 'invalid' };
    try {
      await tx.query(
        `UPDATE identity.proxy_grant SET proxy_principal_id = $2, status = 'active', accepted_at = now() WHERE id = $1`,
        [grantId, principalId],
      );
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ProxyConflictError();
      throw e;
    }
    await this.audit(tx, meta, 'update', grantId, g['patient_id'] as string, {
      event: 'proxy_accepted',
      source: g['source'],
      guardian: g['guardian'],
    });
    return { kind: 'accepted', grant: await this.one(tx, grantId) };
  }

  /** The patient changes what a proxy of theirs may see. Not for a guardian grant (a minor's guardian is staff-managed). */
  async setScopes(
    tx: Tx,
    meta: ProxyRequestMeta,
    patientId: string,
    grantId: string,
    scopes: unknown,
  ): Promise<ProxyGrantView | undefined> {
    this.selfScope(tx, patientId);
    if (!isUuid(grantId)) throw new IdentityValidationError(['grantId']);
    const next = normaliseScopes(scopes);
    if (next === undefined || scopes === undefined) throw new IdentityValidationError(['scopes']);
    const before = (
      await tx.query(
        `SELECT scopes, guardian FROM identity.proxy_grant
          WHERE id = $1 AND patient_id = $2 AND status IN ('requested', 'verified', 'active') FOR UPDATE`,
        [grantId, patientId],
      )
    ).rows[0];
    if (before === undefined) return undefined;
    if (before['guardian'] === true) throw new ProxyNotAllowedError();
    await tx.query(`UPDATE identity.proxy_grant SET scopes = $2::text[] WHERE id = $1`, [grantId, next]);
    await this.audit(tx, meta, 'update', grantId, patientId, {
      event: 'proxy_scopes_changed',
      from: scopesOf(before['scopes']),
      to: next,
    });
    return this.one(tx, grantId);
  }

  /** The patient (own scope, never a proxy) revokes a proxy or withdraws an invitation. Returns false when no open grant matched. */
  async revokeByPatient(
    tx: Tx,
    meta: ProxyRequestMeta,
    patientId: string,
    grantId: string,
  ): Promise<boolean> {
    this.selfScope(tx, patientId);
    if (!isUuid(grantId)) throw new IdentityValidationError(['grantId']);
    const r = await tx.query(
      `UPDATE identity.proxy_grant SET status = 'revoked', revoked_at = now(), revoke_reason = 'patient', ended_by = 'patient'
        WHERE id = $1 AND patient_id = $2 AND status IN ('requested', 'verified', 'active')
        RETURNING guardian`,
      [grantId, patientId],
    );
    if ((r.rowCount ?? 0) !== 1) return false;
    await this.audit(tx, meta, 'update', grantId, patientId, { event: 'proxy_revoked', by: 'patient' });
    return true;
  }

  /** Staff revoke a grant or invitation at any time (`identity.proxy.revoke`; the policy limits them to patients of their locations). */
  async staffRevoke(tx: Tx, meta: ProxyRequestMeta, patientId: string, grantId: string): Promise<boolean> {
    if (tx.scope.audience !== 'staff') throw new IdentityScopeError();
    if (!isUuid(patientId) || !isUuid(grantId)) throw new IdentityValidationError(['grantId']);
    const r = await tx.query(
      `UPDATE identity.proxy_grant SET status = 'revoked', revoked_at = now(), revoke_reason = 'staff', ended_by = 'staff'
        WHERE id = $1 AND patient_id = $2 AND status IN ('requested', 'verified', 'active')`,
      [grantId, patientId],
    );
    if ((r.rowCount ?? 0) !== 1) return false;
    await this.audit(tx, meta, 'update', grantId, patientId, { event: 'proxy_revoked', by: 'staff' });
    return true;
  }

  /** A proxy leaves: ends their own access to the patient. False when they hold no active grant with that id. */
  async leave(tx: Tx, meta: ProxyRequestMeta, grantId: string): Promise<boolean> {
    const principalId = tx.scope.principalId;
    if (tx.scope.audience !== 'patient' || principalId === undefined) throw new IdentityScopeError();
    if (!isUuid(grantId)) throw new IdentityValidationError(['grantId']);
    const r = await tx.query(
      `UPDATE identity.proxy_grant SET status = 'revoked', revoked_at = now(), revoke_reason = 'patient', ended_by = 'proxy'
        WHERE id = $1 AND proxy_principal_id = $2 AND status = 'active'
        RETURNING patient_id`,
      [grantId, principalId],
    );
    const row = r.rows[0];
    if (row === undefined) return false;
    await this.audit(tx, meta, 'update', grantId, row['patient_id'] as string, {
      event: 'proxy_left',
      by: 'proxy',
    });
    return true;
  }

  private async one(tx: Tx, id: string): Promise<ProxyGrantView> {
    const r = await tx.query(`SELECT ${COLS} FROM identity.proxy_grant WHERE id = $1`, [id]);
    const row = r.rows[0];
    // The writer always reads back what it wrote (its own policy allows it); an empty read would be a policy defect.
    if (row === undefined) throw new IdentityScopeError();
    return view(row);
  }

  /** The proxies and invitations of a patient: the patient's own scope (T-PAT-OWN) or staff of the patient's location (T-STAFF). */
  async listForPatient(tx: Tx, patientId: string): Promise<ProxyGrantView[]> {
    if (!isUuid(patientId)) throw new IdentityValidationError(['patientId']);
    const r = await tx.query(
      `SELECT ${COLS} FROM identity.proxy_grant WHERE patient_id = $1 ORDER BY created_at, id`,
      [patientId],
    );
    return r.rows.map(view);
  }

  /** The grants of the calling proxy (T-PRINCIPAL(proxy)), so they can tell linked patients apart without reading the patient. */
  async listMine(tx: Tx): Promise<ProxyGrantView[]> {
    if (tx.scope.audience !== 'patient' || tx.scope.principalId === undefined)
      throw new IdentityScopeError();
    const r = await tx.query(
      `SELECT ${COLS} FROM identity.proxy_grant WHERE proxy_principal_id = $1 ORDER BY created_at, id`,
      [tx.scope.principalId],
    );
    return r.rows.map(view);
  }
}

/** What a patient session may reach, as the scope builder computed it: the interface the patient module reads (24). */
export function patientAccessOf(
  patients: readonly PatientAccess[],
  patientId: string,
): PatientAccess | undefined {
  return patients.find((p) => p.patientId === patientId);
}
