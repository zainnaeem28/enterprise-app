// The patient banner and the allergy summary (ARCHITECTURE 24 `allergySummary`, 28.2; BR-34; AL-01; BQ-11).
//
// The API response layer adds `patientBanner` to every staff response marked `banner: true` by calling `patient`'s record (name,
// date of birth, MRN, photo) and `clinical.allergySummary` (the allergy part); the API layer sits above every module, so this adds no
// module edge. The allergy part is filled only when the caller passes the chart-read rule (assignment or BTG) or the pre-visit rule
// (`ChartAccess`); otherwise `allergies` is null and the UI says "Allergies not available with your current access" (never an empty
// block that reads as "none"). `none_recorded` is "No allergies recorded", never "No known allergies": R1 has no such assertion.
//
// When the part is filled the caller's transaction gets one audit row, resource `clinical.allergy_summary` (38.2 item 18); when it
// is null there is none. The read is one indexed statement on `clinical.allergy (patient_id, status)` under the caller's RLS.
import type { Tx } from '@ehr/kernel';
import type { ChartAuditPort } from './audit-port.js';
import type { AuthContext } from '../../identity/index.js';
import type { PatientService } from '../../patient/index.js';
import type { ChartAccess } from './access.js';
import { ChartNotFoundError } from './errors.js';
import { isUuid } from './ids.js';
import type {
  AllergyBannerItem,
  AllergyCategory,
  AllergySeverity,
  AllergySummary,
  PatientBannerView,
  RequestMeta,
} from './types.js';

type Row = Record<string, unknown>;

/** At most this many allergies are named in the banner; the rest are `moreCount`. */
export const BANNER_ALLERGY_LIMIT = 10;

/** The 60-second signed URL of the patient's photo document, or null. The documents module provides the real one at composition. */
export type PhotoUrlPort = (
  tx: Tx,
  documentId: string,
  patientId: string,
) => Promise<string | null>;

export interface BannerDeps {
  audit: ChartAuditPort;
  patients: Pick<PatientService, 'get'>;
  access: ChartAccess;
  photo?: PhotoUrlPort;
}

const iso = (v: unknown): string | null =>
  v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v);

export class BannerService {
  constructor(private readonly deps: BannerDeps) {}

  /**
   * `clinical.allergySummary(patient)`: active allergies only (`resolved`, `inactive` and `entered_in_error` are absent), severe
   * first, then by display; at most 10 items; `moreCount` for the rest; `uncodedCount` over all active allergies.
   */
  async allergySummary(tx: Tx, patientId: string): Promise<AllergySummary> {
    if (!isUuid(patientId)) throw new ChartNotFoundError();
    const r = await tx.query(
      `SELECT a.id, a.display, a.category, a.severity, a.coded,
              count(*) OVER () AS total, count(*) FILTER (WHERE NOT a.coded) OVER () AS uncoded,
              (SELECT max(coalesce(x.updated_at, x.created_at)) FROM clinical.allergy x WHERE x.patient_id = $1::uuid) AS last_changed
         FROM clinical.allergy a
        WHERE a.patient_id = $1::uuid AND a.status = 'active'
        ORDER BY CASE a.severity WHEN 'severe' THEN 0 WHEN 'moderate' THEN 1 WHEN 'mild' THEN 2 ELSE 3 END, a.display, a.id
        LIMIT ${BANNER_ALLERGY_LIMIT}`,
      [patientId],
    );
    const rows = r.rows as Row[];
    if (rows.length === 0) {
      // No active allergy: "last change" may still be a resolved or withdrawn one.
      const l = await tx.query(
        `SELECT max(coalesce(updated_at, created_at)) AS last_changed FROM clinical.allergy WHERE patient_id = $1::uuid`,
        [patientId],
      );
      return {
        state: 'none_recorded',
        items: [],
        moreCount: 0,
        uncodedCount: 0,
        lastChangedAt: iso((l.rows[0] as Row | undefined)?.['last_changed']),
      };
    }
    const first = rows[0] as Row;
    const items: AllergyBannerItem[] = rows.map((x) => ({
      allergyId: String(x['id']),
      display: String(x['display']),
      category: x['category'] as AllergyCategory,
      severity: x['severity'] as AllergySeverity,
      coded: x['coded'] === true,
    }));
    return {
      state: 'recorded',
      items,
      moreCount: Math.max(0, Number(first['total']) - items.length),
      uncodedCount: Number(first['uncoded']),
      lastChangedAt: iso(first['last_changed']),
    };
  }

  /** The banner for one patient, for the caller in `ctx`. Undefined when the patient is not visible to the caller. */
  async bannerFor(
    tx: Tx,
    ctx: AuthContext,
    meta: RequestMeta,
    patientId: string,
  ): Promise<PatientBannerView | undefined> {
    if (!isUuid(patientId)) return undefined;
    const p = await this.deps.patients.get(tx, patientId);
    if (p === undefined) return undefined;
    const fill =
      (await this.deps.access.chartRead(tx, ctx, p.id)) ||
      (await this.deps.access.previsitRead(tx, ctx, p.id));
    const allergies = fill ? await this.allergySummary(tx, p.id) : null;
    if (allergies !== null)
      await this.deps.audit.record(tx, {
        requestId: meta.requestId,
        action: 'view',
        resourceType: 'clinical.allergy_summary',
        patientId: p.id,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
      });
    const photoUrl =
      p.photoDocumentId !== null && this.deps.photo !== undefined
        ? await this.deps.photo(tx, p.photoDocumentId, p.id)
        : null;
    return {
      patientId: p.id,
      displayName: `${p.givenName} ${p.familyName}`.trim(),
      dateOfBirth: p.dateOfBirth,
      mrn: p.mrn,
      ...(photoUrl === null ? {} : { photoUrl }),
      allergies,
    };
  }
}
