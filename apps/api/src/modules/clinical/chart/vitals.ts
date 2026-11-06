// Vitals and their reference ranges (ARCHITECTURE 22.11 "Vital-sign reference ranges", 29.3, 29.4; AL-02; PRD RA-R1-24).
//
// `recordVitals` reads the patient's date of birth and `sex_at_birth` through `patient` (a downward call), takes the age in whole
// years at `measured_at` (the UTC calendar date), and picks the active range for the LOINC code whose `age_years` contains that age,
// a sex match winning over `any`. Then: no range -> `no_range`; a range stated in another unit -> `unit_mismatch` (no conversion in
// R1); otherwise `in_range` or `out_of_range` against `low` / `high`, both bounds inclusive. The status and the bounds used are stored
// on the row, so retiring or replacing a range later rewrites no history. A patient whose sex at birth is null or anything but
// `female` or `male` matches only `sex = 'any'` rows (N-7). Out of range never blocks saving.
//
// The table ships empty: the numbers are clinical content (D-12a, BQ-12). Nothing in this file contains a range value.
import type { Tx } from '@ehr/kernel';
import type { ChartAuditPort } from './audit-port.js';
import type { PatientService } from '../../patient/index.js';
import {
  ChartNotFoundError,
  ChartValidationError,
  InvalidTransitionError,
  translateDbError,
} from './errors.js';
import { isUuid, uuidv7 } from './ids.js';
import type { RangeStatus, RequestMeta, VitalRangeView, VitalView } from './types.js';

type Row = Record<string, unknown>;

export interface VitalsDeps {
  audit: ChartAuditPort;
  patients: Pick<PatientService, 'get' | 'mergedSurvivor'>;
  now?: () => Date;
}

export interface VitalInput {
  loincCode: unknown;
  value: unknown;
  unit: unknown;
  measuredAt: unknown;
}

export interface RecordVitalsInput {
  patientId: string;
  checkInId?: string;
  encounterId?: string;
  vitals: readonly VitalInput[];
}

export interface RecordedVitals {
  vitals: VitalView[];
  /** The LOINC codes with `out_of_range` (AC-09), each once. */
  outOfRange: string[];
}

export const MAX_VITALS_PER_CALL = 30;
/** Clock skew allowed for `measuredAt` (a device a few minutes ahead is not an error). */
const FUTURE_SKEW_MS = 5 * 60_000;

const LOINC = /^[0-9]{1,7}-[0-9]$/;
const UNIT = /^[A-Za-z0-9%/.[\]{}()*^_+-]{1,40}$/;
const MAX_ABS = 1_000_000;

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

const vitalOf = (r: Row): VitalView => ({
  vitalId: String(r['id']),
  loincCode: String(r['loinc_code']),
  value: numOrNull(r['value']),
  unit: r['unit'] === null || r['unit'] === undefined ? null : String(r['unit']),
  measuredAt: iso(r['measured_at']),
  rangeStatus: r['range_status'] as RangeStatus,
  rangeLow: numOrNull(r['range_low']),
  rangeHigh: numOrNull(r['range_high']),
  correctsId:
    r['corrects_id'] === null || r['corrects_id'] === undefined ? null : String(r['corrects_id']),
  enteredInError: r['entered_in_error'] === true,
});

const rangeOf = (r: Row): VitalRangeView => ({
  id: String(r['id']),
  loincCode: String(r['loinc_code']),
  unit: String(r['unit']),
  sex: r['sex'] as VitalRangeView['sex'],
  ageYears: {
    from: Number(r['age_from']),
    to: r['age_to'] === null || r['age_to'] === undefined ? null : Number(r['age_to']),
  },
  low: numOrNull(r['low']),
  high: numOrNull(r['high']),
  status: r['status'] as 'active' | 'retired',
  approvedByNote: String(r['approved_by_note']),
  createdAt: iso(r['created_at']),
  retiredAt:
    r['retired_at'] === null || r['retired_at'] === undefined ? null : iso(r['retired_at']),
});

/** A decimal as the client sent it, kept as text for `numeric` (no binary float round trip), or undefined if it is not a finite number. */
function decimalText(v: unknown): string | undefined {
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || Math.abs(v) > MAX_ABS) return undefined;
    return String(v);
  }
  if (typeof v === 'string' && /^-?\d{1,7}(\.\d{1,6})?$/.test(v.trim())) return v.trim();
  return undefined;
}

interface Judged {
  status: RangeStatus;
  rangeId: string | null;
  low: string | null;
  high: string | null;
}

export class VitalsService {
  private readonly now: () => Date;

  constructor(private readonly deps: VitalsDeps) {
    this.now = deps.now ?? ((): Date => new Date());
  }

  private principal(tx: Tx): string {
    const p = tx.scope.principalId;
    if (tx.scope.audience !== 'staff' || p === undefined || !isUuid(p))
      throw new ChartNotFoundError();
    return p;
  }

  /**
   * The range decision for one value (the rule above), in SQL so the comparison is `numeric`, not a float. `sex` is the patient's
   * `sex_at_birth` as stored; anything but female or male is matched against `any` rows only.
   */
  private async judge(
    tx: Tx,
    loinc: string,
    unit: string,
    valueText: string,
    sexAtBirth: string | null,
    dateOfBirth: string,
    measuredAt: Date,
  ): Promise<Judged> {
    const sex = sexAtBirth === 'female' || sexAtBirth === 'male' ? sexAtBirth : 'any';
    const r = await tx.query(
      `WITH age AS (SELECT date_part('year', age(($5::timestamptz AT TIME ZONE 'UTC')::date, $4::date))::int AS years)
       SELECT r.id, r.unit, r.low, r.high,
              ((r.low IS NOT NULL AND $3::numeric < r.low) OR (r.high IS NOT NULL AND $3::numeric > r.high)) AS is_out
         FROM clinical.vital_range r, age
        WHERE r.status = 'active' AND r.loinc_code = $1 AND r.age_years @> age.years AND r.sex IN ('any', $2)
        ORDER BY (r.sex <> 'any') DESC
        LIMIT 1`,
      [loinc, sex, valueText, dateOfBirth, measuredAt.toISOString()],
    );
    const row = r.rows[0] as Row | undefined;
    if (row === undefined) return { status: 'no_range', rangeId: null, low: null, high: null };
    if (String(row['unit']) !== unit)
      return { status: 'unit_mismatch', rangeId: null, low: null, high: null };
    return {
      status: row['is_out'] === true ? 'out_of_range' : 'in_range',
      rangeId: String(row['id']),
      low: row['low'] === null ? null : String(row['low']),
      high: row['high'] === null ? null : String(row['high']),
    };
  }

  private validateOne(
    v: VitalInput,
    i: number,
    dob: string,
    bad: string[],
  ): {
    loinc: string;
    valueText: string;
    unit: string;
    measuredAt: Date;
  } | null {
    const before = bad.length;
    const loinc = typeof v.loincCode === 'string' ? v.loincCode : '';
    if (!LOINC.test(loinc)) bad.push(`vitals/${i}/loincCode`);
    const valueText = decimalText(v.value);
    if (valueText === undefined) bad.push(`vitals/${i}/value`);
    const unit = typeof v.unit === 'string' ? v.unit : '';
    if (!UNIT.test(unit)) bad.push(`vitals/${i}/unit`);
    const t = typeof v.measuredAt === 'string' ? Date.parse(v.measuredAt) : Number.NaN;
    if (
      Number.isNaN(t) ||
      t > this.now().getTime() + FUTURE_SKEW_MS ||
      t < Date.parse(`${dob}T00:00:00Z`)
    )
      bad.push(`vitals/${i}/measuredAt`);
    if (bad.length > before) return null;
    return { loinc, valueText: valueText as string, unit, measuredAt: new Date(t) };
  }

  /** `clinical.recordVitals` (24); the route is `POST /check-ins/{id}/vitals` (BE-18). One transaction, all or none. */
  async recordVitals(tx: Tx, meta: RequestMeta, input: RecordVitalsInput): Promise<RecordedVitals> {
    const principal = this.principal(tx);
    if (!isUuid(input.patientId)) throw new ChartNotFoundError();
    const pid = input.patientId.toLowerCase();
    const bad: string[] = [];
    if (input.checkInId !== undefined && !isUuid(input.checkInId)) bad.push('checkInId');
    if (input.encounterId !== undefined && !isUuid(input.encounterId)) bad.push('encounterId');
    if (
      !Array.isArray(input.vitals) ||
      input.vitals.length < 1 ||
      input.vitals.length > MAX_VITALS_PER_CALL
    )
      throw new ChartValidationError([...bad, 'vitals']);
    try {
      await tx.lockPatients([pid], 'key_share');
      const patient = await this.deps.patients.get(tx, pid);
      if (patient === undefined) throw new ChartNotFoundError();
      const checked = input.vitals.map((v, i) =>
        v === null || typeof v !== 'object'
          ? (bad.push(`vitals/${i}`), null)
          : this.validateOne(v, i, patient.dateOfBirth, bad),
      );
      if (bad.length > 0) throw new ChartValidationError(bad);

      const out: VitalView[] = [];
      for (const c of checked) {
        if (c === null) continue;
        const j = await this.judge(
          tx,
          c.loinc,
          c.unit,
          c.valueText,
          patient.sexAtBirth ?? null,
          patient.dateOfBirth,
          c.measuredAt,
        );
        const id = uuidv7();
        const r = await tx.query(
          `INSERT INTO clinical.vital_sign (id, organisation_id, patient_id, encounter_id, check_in_id, loinc_code, value, unit, range_status,
                                            range_id, range_low, range_high, measured_at, by_principal_id, created_by)
           VALUES ($1::uuid, kernel.uuid1('app.org_id'), $2::uuid, $3, $4, $5, $6::numeric, $7, $8, $9, $10::numeric, $11::numeric, $12::timestamptz, $13::uuid, $13::uuid)
           RETURNING *`,
          [
            id,
            pid,
            input.encounterId ?? null,
            input.checkInId ?? null,
            c.loinc,
            c.valueText,
            c.unit,
            j.status,
            j.rangeId,
            j.low,
            j.high,
            c.measuredAt.toISOString(),
            principal,
          ],
        );
        out.push(vitalOf(r.rows[0] as Row));
      }
      const outOfRange = [
        ...new Set(out.filter((v) => v.rangeStatus === 'out_of_range').map((v) => v.loincCode)),
      ];
      await this.deps.audit.record(tx, {
        requestId: meta.requestId,
        action: 'create',
        resourceType: 'clinical.vital_sign',
        patientId: pid,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        change: { count: out.length, outOfRange: outOfRange.length },
      });
      return { vitals: out, outOfRange };
    } catch (e) {
      translateDbError(e);
    }
  }

  /**
   * A correction is a new row (TDR-10): `{ enteredInError: true }` withdraws the value, `{ value, unit, measuredAt? }` replaces it.
   * The row corrected stays as it was. A row is corrected at most once (the end of the chain is the current value), so a second
   * correction of the same row is `409 clinical.invalid_transition`, also when two requests race. When the patient has since been
   * merged, the correction is written on the survivor (22.11).
   */
  async correctVital(
    tx: Tx,
    meta: RequestMeta,
    vitalId: string,
    input: { enteredInError?: boolean; value?: unknown; unit?: unknown; measuredAt?: unknown },
  ): Promise<VitalView> {
    const principal = this.principal(tx);
    if (!isUuid(vitalId)) throw new ChartNotFoundError();
    const orig = (
      await tx.query(`SELECT * FROM clinical.vital_sign WHERE id = $1::uuid`, [vitalId])
    ).rows[0] as Row | undefined;
    if (orig === undefined) throw new ChartNotFoundError();
    if (orig['entered_in_error'] === true) throw new InvalidTransitionError();
    const origPatient = String(orig['patient_id']);
    try {
      const survivor = (await this.deps.patients.mergedSurvivor(tx, origPatient)) ?? origPatient;
      await tx.lockPatients([survivor], 'key_share');
      const patient = await this.deps.patients.get(tx, survivor);
      if (patient === undefined) throw new ChartNotFoundError();
      const id = uuidv7();
      let params: unknown[];
      if (input.enteredInError === true) {
        params = [
          id,
          survivor,
          orig['encounter_id'],
          orig['check_in_id'],
          orig['loinc_code'],
          null,
          null,
          'no_range',
          null,
          null,
          null,
          iso(orig['measured_at']),
          principal,
          vitalId,
          true,
        ];
      } else {
        const bad: string[] = [];
        const c = this.validateOne(
          {
            loincCode: orig['loinc_code'],
            value: input.value,
            unit: input.unit,
            measuredAt: input.measuredAt ?? iso(orig['measured_at']),
          },
          0,
          patient.dateOfBirth,
          bad,
        );
        if (c === null)
          throw new ChartValidationError(bad.map((b) => b.replace(/^vitals\/0\//, '')));
        const j = await this.judge(
          tx,
          c.loinc,
          c.unit,
          c.valueText,
          patient.sexAtBirth ?? null,
          patient.dateOfBirth,
          c.measuredAt,
        );
        params = [
          id,
          survivor,
          orig['encounter_id'],
          orig['check_in_id'],
          c.loinc,
          c.valueText,
          c.unit,
          j.status,
          j.rangeId,
          j.low,
          j.high,
          c.measuredAt.toISOString(),
          principal,
          vitalId,
          false,
        ];
      }
      const r = await tx.query(
        `INSERT INTO clinical.vital_sign (id, organisation_id, patient_id, encounter_id, check_in_id, loinc_code, value, unit, range_status,
                                          range_id, range_low, range_high, measured_at, by_principal_id, created_by, corrects_id, entered_in_error)
         VALUES ($1::uuid, kernel.uuid1('app.org_id'), $2::uuid, $3, $4, $5, $6::numeric, $7, $8, $9, $10::numeric, $11::numeric, $12::timestamptz, $13::uuid, $13::uuid, $14::uuid, $15)
         RETURNING *`,
        params,
      );
      await this.deps.audit.record(tx, {
        requestId: meta.requestId,
        action: 'update',
        resourceType: 'clinical.vital_sign',
        resourceId: id,
        patientId: survivor,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        change: { corrects: vitalId, enteredInError: input.enteredInError === true },
      });
      return vitalOf(r.rows[0] as Row);
    } catch (e) {
      translateDbError(e);
    }
  }

  /**
   * Recent vitals for the chart summary: the current value of each chain (not corrected by a later row, not entered in error),
   * newest measurement first, in the vital shape of the record call.
   */
  async recent(tx: Tx, patientId: string, limit = 20): Promise<VitalView[]> {
    if (!isUuid(patientId)) throw new ChartNotFoundError();
    const r = await tx.query(
      `SELECT * FROM clinical.vital_sign v
        WHERE v.patient_id = $1::uuid AND NOT v.entered_in_error
          AND NOT EXISTS (SELECT 1 FROM clinical.vital_sign c WHERE c.corrects_id = v.id)
        ORDER BY v.measured_at DESC, v.id DESC LIMIT $2::int`,
      [patientId, limit],
    );
    return (r.rows as Row[]).map(vitalOf);
  }

  // ===== reference ranges (29.4) ==========================================================================================
  async listRanges(tx: Tx, filter: { status?: string } = {}): Promise<VitalRangeView[]> {
    if (filter.status !== undefined && filter.status !== 'active' && filter.status !== 'retired')
      throw new ChartValidationError(['status']);
    const r = await tx.query(
      `SELECT r.*, lower(r.age_years) AS age_from, upper(r.age_years) AS age_to FROM clinical.vital_range r
        WHERE ($1::text IS NULL OR r.status = $1)
        ORDER BY r.loinc_code, r.sex, lower(r.age_years), r.created_at, r.id`,
      [filter.status ?? null],
    );
    return (r.rows as Row[]).map(rangeOf);
  }

  /** `POST /admin/vital-ranges`: a new active range. An overlap with an active range of the same code and sex is `409 clinical.vital_range_overlap`. */
  async createRange(
    tx: Tx,
    meta: RequestMeta,
    raw: Record<string, unknown>,
  ): Promise<VitalRangeView> {
    const principal = this.principal(tx);
    const bad: string[] = [];
    const loinc = typeof raw['loincCode'] === 'string' ? raw['loincCode'] : '';
    if (!LOINC.test(loinc)) bad.push('loincCode');
    const unit = typeof raw['unit'] === 'string' ? raw['unit'] : '';
    if (!UNIT.test(unit)) bad.push('unit');
    const sex = raw['sex'];
    if (sex !== 'any' && sex !== 'female' && sex !== 'male') bad.push('sex');
    const age = raw['ageYears'] as { from?: unknown; to?: unknown } | null | undefined;
    const from = age?.from;
    const to = age?.to;
    if (typeof from !== 'number' || !Number.isInteger(from) || from < 0 || from > 150)
      bad.push('ageYears/from');
    if (
      to !== undefined &&
      to !== null &&
      (typeof to !== 'number' ||
        !Number.isInteger(to) ||
        to > 150 ||
        (typeof from === 'number' && to <= from))
    )
      bad.push('ageYears/to');
    const low = raw['low'] === undefined || raw['low'] === null ? null : decimalText(raw['low']);
    const high =
      raw['high'] === undefined || raw['high'] === null ? null : decimalText(raw['high']);
    if (raw['low'] !== undefined && raw['low'] !== null && low === undefined) bad.push('low');
    if (raw['high'] !== undefined && raw['high'] !== null && high === undefined) bad.push('high');
    if (low === null && high === null) bad.push('low', 'high');
    if (typeof low === 'string' && typeof high === 'string' && Number(low) >= Number(high))
      bad.push('low', 'high');
    const note = typeof raw['approvedByNote'] === 'string' ? raw['approvedByNote'].trim() : '';
    if (note.length < 10 || note.length > 1000) bad.push('approvedByNote');
    if (bad.length > 0) throw new ChartValidationError([...new Set(bad)]);
    const id = uuidv7();
    try {
      const r = await tx.query(
        `INSERT INTO clinical.vital_range (id, organisation_id, loinc_code, unit, sex, age_years, low, high, approved_by_note, created_by)
         VALUES ($1::uuid, kernel.uuid1('app.org_id'), $2, $3, $4, int4range($5::int, $6::int, '[)'), $7::numeric, $8::numeric, $9, $10::uuid)
         RETURNING *, lower(age_years) AS age_from, upper(age_years) AS age_to`,
        [id, loinc, unit, sex, from, to ?? null, low, high, note, principal],
      );
      await this.deps.audit.record(tx, {
        requestId: meta.requestId,
        action: 'config_change',
        resourceType: 'clinical.vital_range',
        resourceId: id,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        change: { op: 'create', loincCode: loinc, sex },
      });
      return rangeOf(r.rows[0] as Row);
    } catch (e) {
      translateDbError(e);
    }
  }

  /** `POST /admin/vital-ranges/{id}/retire`: retiring is final and changes no stored vital. Retiring a retired range is 409. */
  async retireRange(tx: Tx, meta: RequestMeta, id: string): Promise<VitalRangeView> {
    const principal = this.principal(tx);
    if (!isUuid(id)) throw new ChartNotFoundError();
    try {
      const cur = (
        await tx.query(`SELECT status FROM clinical.vital_range WHERE id = $1::uuid FOR UPDATE`, [
          id,
        ])
      ).rows[0] as Row | undefined;
      if (cur === undefined) throw new ChartNotFoundError();
      if (cur['status'] !== 'active') throw new InvalidTransitionError();
      const r = await tx.query(
        `UPDATE clinical.vital_range SET status = 'retired', retired_at = $2::timestamptz, retired_by = $3::uuid WHERE id = $1::uuid
         RETURNING *, lower(age_years) AS age_from, upper(age_years) AS age_to`,
        [id, this.now().toISOString(), principal],
      );
      await this.deps.audit.record(tx, {
        requestId: meta.requestId,
        action: 'config_change',
        resourceType: 'clinical.vital_range',
        resourceId: id,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        change: { op: 'retire' },
      });
      return rangeOf(r.rows[0] as Row);
    } catch (e) {
      translateDbError(e);
    }
  }
}
