// The coded lists of the chart: problems, allergies, medications (ARCHITECTURE 22.11, 29.3; PRD RA-R1-09, ADR-010). A coded entry
// carries a `codeSystem` + `code` the caller chose from `/terminology/search`; the server looks the code up again and stores the
// concept's own display, so a client cannot attach a wrong name to a code. Free text is saved with `coded: false`. The rows are
// written under the caller's scope (RLS is the second line); the triggers of migration 1601 fix what may change.
//
// Every write names its row by (patientId, id) and takes the row lock, then checks the `If-Match` version, so two sessions editing
// one entry meet a 412 and never overwrite each other (CN-07, TC-CL-05 for the lists). The audit row names the fields that changed,
// never their values (RA-R1-19).
import type { Tx } from '@ehr/kernel';
import type { ChartAuditPort } from './audit-port.js';
import { decodeCursor, encodeCursor, parseLimit } from './cursor.js';
import {
  ChartNotFoundError,
  ChartValidationError,
  InvalidTransitionError,
  PreconditionFailedError,
  UncodedRequiresDisplayError,
  translateDbError,
} from './errors.js';
import { isUuid, uuidv7 } from './ids.js';
import type { TerminologyService } from './terminology.js';
import { ALLERGY_SYSTEMS, MEDICATION_SYSTEMS, PROBLEM_SYSTEMS } from './types.js';
import type {
  AllergyCategory,
  AllergySeverity,
  AllergyView,
  EntryStatus,
  MedicationStatus,
  MedicationView,
  ProblemView,
  RequestMeta,
} from './types.js';

type Row = Record<string, unknown>;

export interface ListsDeps {
  audit: ChartAuditPort;
  terminology: TerminologyService;
  /** HMAC key of the list cursors. */
  cursorKey: string;
  now?: () => Date;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ListQuery {
  status?: string;
  limit?: unknown;
  cursor?: unknown;
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const dateOnly = (v: unknown): string | null =>
  v === null || v === undefined
    ? null
    : v instanceof Date
      ? v.toISOString().slice(0, 10)
      : String(v).slice(0, 10);
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (v: unknown): v is string =>
  typeof v === 'string' && DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

const PROBLEM_STATUSES: readonly EntryStatus[] = [
  'active',
  'resolved',
  'inactive',
  'entered_in_error',
];
const MEDICATION_STATUSES: readonly MedicationStatus[] = ['active', 'stopped', 'entered_in_error'];
const CATEGORIES: readonly AllergyCategory[] = ['drug', 'food', 'environment'];
const SEVERITIES: readonly AllergySeverity[] = ['mild', 'moderate', 'severe', 'unknown'];

const problemOf = (r: Row): ProblemView => ({
  id: String(r['id']),
  patientId: String(r['patient_id']),
  codeSystem: strOrNull(r['code_system']),
  code: strOrNull(r['code']),
  display: String(r['display']),
  coded: r['coded'] === true,
  status: r['status'] as EntryStatus,
  onsetDate: dateOnly(r['onset_date']),
  resolvedDate: dateOnly(r['resolved_date']),
  recordedByPrincipalId: String(r['recorded_by']),
  createdAt: iso(r['created_at']),
  version: Number(r['row_version']),
});
const allergyOf = (r: Row): AllergyView => ({
  id: String(r['id']),
  patientId: String(r['patient_id']),
  codeSystem: strOrNull(r['code_system']),
  code: strOrNull(r['code']),
  display: String(r['display']),
  coded: r['coded'] === true,
  category: r['category'] as AllergyCategory,
  reaction: strOrNull(r['reaction']),
  severity: r['severity'] as AllergySeverity,
  status: r['status'] as EntryStatus,
  onsetDate: dateOnly(r['onset_date']),
  resolvedDate: dateOnly(r['resolved_date']),
  recordedByPrincipalId: String(r['recorded_by']),
  createdAt: iso(r['created_at']),
  version: Number(r['row_version']),
});
const medicationOf = (r: Row): MedicationView => ({
  id: String(r['id']),
  patientId: String(r['patient_id']),
  codeSystem: r['rxnorm_code'] === null || r['rxnorm_code'] === undefined ? null : 'rxnorm',
  code: strOrNull(r['rxnorm_code']),
  display: String(r['display']),
  coded: r['coded'] === true,
  doseText: strOrNull(r['dose_text']),
  status: r['status'] as MedicationStatus,
  startDate: dateOnly(r['start_date']),
  endDate: dateOnly(r['end_date']),
  recordedByPrincipalId: String(r['recorded_by']),
  createdAt: iso(r['created_at']),
  version: Number(r['row_version']),
});

interface Coding {
  codeSystem: string | null;
  code: string | null;
  display: string;
  coded: boolean;
}

type Kind = 'problem' | 'allergy' | 'medication';
interface KindSpec {
  table: string;
  resource: string;
  systems: readonly string[];
  statuses: readonly string[];
  /** The columns holding the system and code ({@link Coding} maps onto them). */
  systemCol: string | null;
  codeCol: string;
  resolvedStatus: string;
  /** `resolved_date` / `end_date`: set to today when the entry is resolved / stopped without one. */
  endCol: string;
}
const SPECS: Record<Kind, KindSpec> = {
  problem: {
    table: 'clinical.problem',
    resource: 'clinical.problem',
    systems: PROBLEM_SYSTEMS,
    statuses: PROBLEM_STATUSES,
    systemCol: 'code_system',
    codeCol: 'code',
    resolvedStatus: 'resolved',
    endCol: 'resolved_date',
  },
  allergy: {
    table: 'clinical.allergy',
    resource: 'clinical.allergy',
    systems: ALLERGY_SYSTEMS,
    statuses: PROBLEM_STATUSES,
    systemCol: 'code_system',
    codeCol: 'code',
    resolvedStatus: 'resolved',
    endCol: 'resolved_date',
  },
  medication: {
    table: 'clinical.medication_statement',
    resource: 'clinical.medication_statement',
    systems: MEDICATION_SYSTEMS,
    statuses: MEDICATION_STATUSES,
    systemCol: null,
    codeCol: 'rxnorm_code',
    resolvedStatus: 'stopped',
    endCol: 'end_date',
  },
};

export class ChartListsService {
  private readonly now: () => Date;

  constructor(private readonly deps: ListsDeps) {
    this.now = deps.now ?? ((): Date => new Date());
  }

  private principal(tx: Tx): string {
    const p = tx.scope.principalId;
    if (tx.scope.audience !== 'staff' || p === undefined || !isUuid(p))
      throw new ChartNotFoundError();
    return p;
  }

  private patientIdOf(patientId: string): string {
    if (!isUuid(patientId)) throw new ChartNotFoundError();
    return patientId.toLowerCase();
  }

  /**
   * Coded or free text. A code needs its system from the kind's list and must be an active concept of that system (it came from the
   * picker); the stored display is the concept's. Without a code the entry is free text and needs its text.
   */
  private async coding(
    tx: Tx,
    kind: Kind,
    raw: { codeSystem?: unknown; code?: unknown; display?: unknown },
    current?: { coded: boolean },
  ): Promise<Coding> {
    const spec = SPECS[kind];
    const hasCode = raw.code !== undefined && raw.code !== null && raw.code !== '';
    const hasSystem =
      raw.codeSystem !== undefined && raw.codeSystem !== null && raw.codeSystem !== '';
    if (hasCode || hasSystem) {
      const system = kind === 'medication' && !hasSystem ? 'rxnorm' : raw.codeSystem;
      const bad: string[] = [];
      if (typeof system !== 'string' || !spec.systems.includes(system)) bad.push('codeSystem');
      if (typeof raw.code !== 'string' || raw.code.length > 40) bad.push('code');
      if (bad.length > 0) throw new ChartValidationError(bad);
      const concept = await this.deps.terminology.find(tx, system as string, raw.code as string);
      if (concept === undefined) throw new ChartValidationError(['code'], 'clinical.code_unknown');
      return {
        codeSystem: kind === 'medication' ? null : concept.system,
        code: concept.code,
        display: concept.display.slice(0, 200),
        coded: true,
      };
    }
    if (current?.coded === true) throw new ChartValidationError(['code']);
    const display = typeof raw.display === 'string' ? raw.display.trim() : '';
    if (display.length === 0) throw new UncodedRequiresDisplayError();
    if (display.length > 200) throw new ChartValidationError(['display']);
    return { codeSystem: null, code: null, display, coded: false };
  }

  private optionalDate(raw: Record<string, unknown>, field: string, bad: string[]): string | null {
    const v = raw[field];
    if (v === undefined || v === null) return null;
    if (!validDate(v)) bad.push(field);
    return typeof v === 'string' ? v : null;
  }

  // ===== reads ============================================================================================================
  private async page<T>(
    tx: Tx,
    kind: Kind,
    patientId: string,
    q: ListQuery,
    map: (r: Row) => T,
  ): Promise<Page<T>> {
    const spec = SPECS[kind];
    const pid = this.patientIdOf(patientId);
    const limit = parseLimit(q.limit);
    const params: unknown[] = [pid];
    let where = `patient_id = $1::uuid`;
    if (q.status !== undefined) {
      if (!spec.statuses.includes(q.status)) throw new ChartValidationError(['status']);
      params.push(q.status);
      where += ` AND status = $${params.length}`;
    }
    if (q.cursor !== undefined) {
      if (typeof q.cursor !== 'string') throw new ChartValidationError(['cursor']);
      const k = decodeCursor(this.deps.cursorKey, q.cursor);
      if (!isUuid(k.i)) throw new ChartValidationError(['cursor']);
      params.push(k.c, k.i);
      where += ` AND (created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    }
    params.push(limit + 1);
    const r = await tx.query(
      `SELECT * FROM ${spec.table} WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length}::int`,
      params,
    );
    const rows = r.rows as Row[];
    const more = rows.length > limit;
    const slice = more ? rows.slice(0, limit) : rows;
    const last = slice[slice.length - 1];
    return {
      items: slice.map(map),
      nextCursor:
        more && last !== undefined
          ? encodeCursor(this.deps.cursorKey, { c: iso(last['created_at']), i: String(last['id']) })
          : null,
    };
  }

  private async viewed(tx: Tx, meta: RequestMeta, kind: Kind, patientId: string): Promise<void> {
    await this.deps.audit.record(tx, {
      requestId: meta.requestId,
      action: 'view',
      resourceType: SPECS[kind].resource,
      patientId: this.patientIdOf(patientId),
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    });
  }

  async listProblems(
    tx: Tx,
    meta: RequestMeta,
    patientId: string,
    q: ListQuery = {},
  ): Promise<Page<ProblemView>> {
    const page = await this.page(tx, 'problem', patientId, q, problemOf);
    await this.viewed(tx, meta, 'problem', patientId);
    return page;
  }

  async listAllergies(
    tx: Tx,
    meta: RequestMeta,
    patientId: string,
    q: ListQuery = {},
  ): Promise<Page<AllergyView>> {
    const page = await this.page(tx, 'allergy', patientId, q, allergyOf);
    await this.viewed(tx, meta, 'allergy', patientId);
    return page;
  }

  async listMedications(
    tx: Tx,
    meta: RequestMeta,
    patientId: string,
    q: ListQuery = {},
  ): Promise<Page<MedicationView>> {
    const page = await this.page(tx, 'medication', patientId, q, medicationOf);
    await this.viewed(tx, meta, 'medication', patientId);
    return page;
  }

  /** The chart summary's slices: every entry that is not entered in error, newest first, at most `limit`. */
  async summaryRows(
    tx: Tx,
    patientId: string,
    limit = 100,
  ): Promise<{ problems: ProblemView[]; allergies: AllergyView[]; medications: MedicationView[] }> {
    const pid = this.patientIdOf(patientId);
    const read = async (kind: Kind): Promise<Row[]> =>
      (
        await tx.query(
          `SELECT * FROM ${SPECS[kind].table} WHERE patient_id = $1::uuid AND status <> 'entered_in_error'
            ORDER BY created_at DESC, id DESC LIMIT $2::int`,
          [pid, limit],
        )
      ).rows as Row[];
    return {
      problems: (await read('problem')).map(problemOf),
      allergies: (await read('allergy')).map(allergyOf),
      medications: (await read('medication')).map(medicationOf),
    };
  }

  // ===== writes ===========================================================================================================
  async createProblem(
    tx: Tx,
    meta: RequestMeta,
    patientId: string,
    raw: Record<string, unknown>,
  ): Promise<ProblemView> {
    const principal = this.principal(tx);
    const pid = this.patientIdOf(patientId);
    const c = await this.coding(tx, 'problem', raw);
    const bad: string[] = [];
    const onset = this.optionalDate(raw, 'onsetDate', bad);
    const resolved = this.optionalDate(raw, 'resolvedDate', bad);
    if (bad.length > 0) throw new ChartValidationError(bad);
    const id = uuidv7();
    try {
      await tx.lockPatients([pid], 'key_share');
      const r = await tx.query(
        `INSERT INTO clinical.problem (id, organisation_id, patient_id, code_system, code, display, coded, onset_date, resolved_date, recorded_by, created_by)
         VALUES ($1::uuid, kernel.uuid1('app.org_id'), $2::uuid, $3, $4, $5, $6, $7::date, $8::date, $9::uuid, $9::uuid) RETURNING *`,
        [id, pid, c.codeSystem, c.code, c.display, c.coded, onset, resolved, principal],
      );
      await this.audited(tx, meta, 'create', 'clinical.problem', id, pid, { coded: c.coded });
      return problemOf(r.rows[0] as Row);
    } catch (e) {
      translateDbError(e);
    }
  }

  async createAllergy(
    tx: Tx,
    meta: RequestMeta,
    patientId: string,
    raw: Record<string, unknown>,
  ): Promise<AllergyView> {
    const principal = this.principal(tx);
    const pid = this.patientIdOf(patientId);
    const c = await this.coding(tx, 'allergy', raw);
    const bad: string[] = [];
    if (!CATEGORIES.includes(raw['category'] as AllergyCategory)) bad.push('category');
    const severity = raw['severity'] ?? 'unknown';
    if (!SEVERITIES.includes(severity as AllergySeverity)) bad.push('severity');
    const reaction = raw['reaction'] ?? null;
    if (
      reaction !== null &&
      (typeof reaction !== 'string' || reaction.length < 1 || reaction.length > 500)
    )
      bad.push('reaction');
    const onset = this.optionalDate(raw, 'onsetDate', bad);
    const resolved = this.optionalDate(raw, 'resolvedDate', bad);
    if (bad.length > 0) throw new ChartValidationError(bad);
    const id = uuidv7();
    try {
      await tx.lockPatients([pid], 'key_share');
      const r = await tx.query(
        `INSERT INTO clinical.allergy (id, organisation_id, patient_id, code_system, code, display, coded, category, reaction, severity, onset_date, resolved_date, recorded_by, created_by)
         VALUES ($1::uuid, kernel.uuid1('app.org_id'), $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10::date, $11::date, $12::uuid, $12::uuid) RETURNING *`,
        [
          id,
          pid,
          c.codeSystem,
          c.code,
          c.display,
          c.coded,
          raw['category'],
          reaction,
          severity,
          onset,
          resolved,
          principal,
        ],
      );
      await this.audited(tx, meta, 'create', 'clinical.allergy', id, pid, { coded: c.coded });
      return allergyOf(r.rows[0] as Row);
    } catch (e) {
      translateDbError(e);
    }
  }

  async createMedication(
    tx: Tx,
    meta: RequestMeta,
    patientId: string,
    raw: Record<string, unknown>,
  ): Promise<MedicationView> {
    const principal = this.principal(tx);
    const pid = this.patientIdOf(patientId);
    const c = await this.coding(tx, 'medication', raw);
    const bad: string[] = [];
    const dose = raw['doseText'] ?? null;
    if (dose !== null && (typeof dose !== 'string' || dose.length < 1 || dose.length > 200))
      bad.push('doseText');
    const start = this.optionalDate(raw, 'startDate', bad);
    const end = this.optionalDate(raw, 'endDate', bad);
    if (bad.length > 0) throw new ChartValidationError(bad);
    const id = uuidv7();
    try {
      await tx.lockPatients([pid], 'key_share');
      const r = await tx.query(
        `INSERT INTO clinical.medication_statement (id, organisation_id, patient_id, rxnorm_code, display, coded, dose_text, start_date, end_date, recorded_by, created_by)
         VALUES ($1::uuid, kernel.uuid1('app.org_id'), $2::uuid, $3, $4, $5, $6, $7::date, $8::date, $9::uuid, $9::uuid) RETURNING *`,
        [id, pid, c.code, c.display, c.coded, dose, start, end, principal],
      );
      await this.audited(tx, meta, 'create', 'clinical.medication_statement', id, pid, {
        coded: c.coded,
      });
      return medicationOf(r.rows[0] as Row);
    } catch (e) {
      translateDbError(e);
    }
  }

  /**
   * One PATCH for the three lists. The row is locked, the version checked, then only the fields in the patch are written. An entry
   * marked entered in error is final (409 clinical.invalid_transition). A coded entry keeps its code (422); an uncoded one can be
   * coded, or its text corrected.
   */
  private async patch(
    tx: Tx,
    meta: RequestMeta,
    kind: Kind,
    patientId: string,
    id: string,
    expectedVersion: number,
    raw: Record<string, unknown>,
  ): Promise<Row> {
    const spec = SPECS[kind];
    this.principal(tx);
    const pid = this.patientIdOf(patientId);
    if (!isUuid(id)) throw new ChartNotFoundError();
    try {
      await tx.lockPatients([pid], 'key_share');
      const cur = (
        await tx.query(
          `SELECT * FROM ${spec.table} WHERE id = $1::uuid AND patient_id = $2::uuid FOR UPDATE`,
          [id, pid],
        )
      ).rows[0] as Row | undefined;
      if (cur === undefined) throw new ChartNotFoundError();
      if (Number(cur['row_version']) !== expectedVersion) throw new PreconditionFailedError();
      if (cur['status'] === 'entered_in_error') throw new InvalidTransitionError();

      const sets: string[] = [];
      const params: unknown[] = [id, pid];
      const fields: string[] = [];
      const set = (col: string, value: unknown, field: string, cast = ''): void => {
        params.push(value);
        sets.push(`${col} = $${params.length}${cast}`);
        fields.push(field);
      };
      const bad: string[] = [];

      if (raw['status'] !== undefined) {
        if (typeof raw['status'] !== 'string' || !spec.statuses.includes(raw['status']))
          bad.push('status');
        else if (raw['status'] !== cur['status']) {
          set('status', raw['status'], 'status');
          // Resolving or stopping an entry dates it (today) unless the caller dated it; reactivating clears the date.
          if (
            raw['status'] === spec.resolvedStatus &&
            raw[kind === 'medication' ? 'endDate' : 'resolvedDate'] === undefined
          )
            set(spec.endCol, this.now().toISOString().slice(0, 10), spec.endCol, '::date');
          if (
            raw['status'] === 'active' &&
            raw[kind === 'medication' ? 'endDate' : 'resolvedDate'] === undefined
          )
            set(spec.endCol, null, spec.endCol, '::date');
        }
      }
      const dates: [string, string][] =
        kind === 'medication'
          ? [
              ['startDate', 'start_date'],
              ['endDate', 'end_date'],
            ]
          : [
              ['onsetDate', 'onset_date'],
              ['resolvedDate', 'resolved_date'],
            ];
      for (const [field, col] of dates) {
        if (raw[field] === undefined) continue;
        if (raw[field] !== null && !validDate(raw[field])) bad.push(field);
        else set(col, raw[field], col, '::date');
      }
      if (kind === 'allergy') {
        if (raw['severity'] !== undefined) {
          if (!SEVERITIES.includes(raw['severity'] as AllergySeverity)) bad.push('severity');
          else set('severity', raw['severity'], 'severity');
        }
        if (raw['reaction'] !== undefined) {
          const rx = raw['reaction'];
          if (rx !== null && (typeof rx !== 'string' || rx.length < 1 || rx.length > 500))
            bad.push('reaction');
          else set('reaction', rx, 'reaction');
        }
      }
      if (kind === 'medication' && raw['doseText'] !== undefined) {
        const d = raw['doseText'];
        if (d !== null && (typeof d !== 'string' || d.length < 1 || d.length > 200))
          bad.push('doseText');
        else set('dose_text', d, 'dose_text');
      }
      const touchesCoding =
        raw['code'] !== undefined ||
        raw['codeSystem'] !== undefined ||
        raw['display'] !== undefined;
      if (touchesCoding) {
        if (cur['coded'] === true) bad.push('code');
        else {
          const c = await this.coding(tx, kind, raw, { coded: false });
          if (spec.systemCol !== null) set(spec.systemCol, c.codeSystem, spec.systemCol);
          set(spec.codeCol, c.code, spec.codeCol);
          set('display', c.display, 'display');
          set('coded', c.coded, 'coded');
        }
      }
      if (bad.length > 0) throw new ChartValidationError(bad);
      if (sets.length === 0) throw new ChartValidationError(['body']);

      params.push(expectedVersion);
      const r = await tx.query(
        `UPDATE ${spec.table} SET ${sets.join(', ')} WHERE id = $1::uuid AND patient_id = $2::uuid AND row_version = $${params.length} RETURNING *`,
        params,
      );
      const row = r.rows[0] as Row | undefined;
      if (row === undefined) throw new PreconditionFailedError();
      await this.audited(tx, meta, 'update', spec.resource, id, pid, { fields });
      return row;
    } catch (e) {
      translateDbError(e);
    }
  }

  async updateProblem(
    tx: Tx,
    meta: RequestMeta,
    patientId: string,
    id: string,
    version: number,
    raw: Record<string, unknown>,
  ): Promise<ProblemView> {
    return problemOf(await this.patch(tx, meta, 'problem', patientId, id, version, raw));
  }

  async updateAllergy(
    tx: Tx,
    meta: RequestMeta,
    patientId: string,
    id: string,
    version: number,
    raw: Record<string, unknown>,
  ): Promise<AllergyView> {
    return allergyOf(await this.patch(tx, meta, 'allergy', patientId, id, version, raw));
  }

  async updateMedication(
    tx: Tx,
    meta: RequestMeta,
    patientId: string,
    id: string,
    version: number,
    raw: Record<string, unknown>,
  ): Promise<MedicationView> {
    return medicationOf(await this.patch(tx, meta, 'medication', patientId, id, version, raw));
  }

  private async audited(
    tx: Tx,
    meta: RequestMeta,
    action: 'create' | 'update',
    resourceType: string,
    resourceId: string,
    patientId: string,
    change: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.audit.record(tx, {
      requestId: meta.requestId,
      action,
      resourceType,
      resourceId,
      patientId,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      change,
    });
  }
}
