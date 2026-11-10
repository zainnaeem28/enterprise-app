// `clinical.chartSummary(patient)` (ARCHITECTURE 24, 29.3; RA-R1-24; TC-CL-08): problems, allergies (with `coded`), medications,
// recent vitals in the vital shape of the record call, encounters and the documents list, plus the banner.
//
// What a caller sees follows the access level (`ChartAccess.level`):
//   chart    : everything below (assignment or BTG, 27.4);
//   previsit : the banner (with the allergy summary) and the recent vitals only - the pre-visit items of 27.2; every other part is
//              `null`, meaning "not available with your access", never an empty list that would read as "none";
//   none     : 404 (the patient is not visible), decided by the guard before this runs.
// `encounters` and `documents` are lists for a chart-level caller (wired in at composition, QA661-F01); null only when no source is given.
import type { Tx } from '@ehr/kernel';
import type { ChartAuditPort } from './audit-port.js';
import type { AuthContext } from '../../identity/index.js';
import type { ChartAccess } from './access.js';
import type { BannerService } from './banner.js';
import { ChartNotFoundError } from './errors.js';
import type { ChartListsService } from './lists.js';
import type {
  AllergyView,
  MedicationView,
  PatientBannerView,
  ProblemView,
  RequestMeta,
  VitalView,
} from './types.js';
import type { VitalsService } from './vitals.js';

export interface SummaryDeps {
  audit: ChartAuditPort;
  access: ChartAccess;
  banner: BannerService;
  lists: ChartListsService;
  vitals: VitalsService;
  /** The documents list of the patient, already in its API shape (documents module). */
  documents?: (tx: Tx, patientId: string) => Promise<unknown[]>;
  /** The encounters of the patient (BE-17). */
  encounters?: (tx: Tx, patientId: string) => Promise<unknown[]>;
}

export interface ChartSummary {
  patientBanner: PatientBannerView;
  level: 'chart' | 'previsit';
  problems: ProblemView[] | null;
  allergies: AllergyView[] | null;
  medications: MedicationView[] | null;
  recentVitals: VitalView[];
  encounters: unknown[] | null;
  documents: unknown[] | null;
}

export class ChartSummaryService {
  constructor(private readonly deps: SummaryDeps) {}

  async chartSummary(
    tx: Tx,
    ctx: AuthContext,
    meta: RequestMeta,
    patientId: string,
  ): Promise<ChartSummary> {
    const level = await this.deps.access.level(tx, ctx, meta, patientId);
    if (level === 'none') throw new ChartNotFoundError();
    const banner = await this.deps.banner.bannerFor(tx, ctx, meta, patientId);
    if (banner === undefined) throw new ChartNotFoundError();
    const recentVitals = await this.deps.vitals.recent(tx, banner.patientId);
    let out: ChartSummary;
    if (level === 'chart') {
      const rows = await this.deps.lists.summaryRows(tx, banner.patientId);
      out = {
        patientBanner: banner,
        level,
        problems: rows.problems,
        allergies: rows.allergies,
        medications: rows.medications,
        recentVitals,
        encounters:
          this.deps.encounters === undefined
            ? null
            : await this.deps.encounters(tx, banner.patientId),
        documents:
          this.deps.documents === undefined
            ? null
            : await this.deps.documents(tx, banner.patientId),
      };
    } else {
      out = {
        patientBanner: banner,
        level,
        problems: null,
        allergies: null,
        medications: null,
        recentVitals,
        encounters: null,
        documents: null,
      };
    }
    await this.deps.audit.record(tx, {
      requestId: meta.requestId,
      action: 'view',
      resourceType: 'clinical.chart_summary',
      patientId: banner.patientId,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    });
    return out;
  }
}
