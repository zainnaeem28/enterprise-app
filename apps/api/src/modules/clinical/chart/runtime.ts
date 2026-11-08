// Wiring of the clinical chart: one call builds the services and the controllers from explicit dependencies and registers what the
// chart owes the identity module (its resolver, the assignment sources). Nothing here reads the environment; the application entry
// point supplies the pieces.
import type { KernelDb } from '@ehr/kernel';
import type { Type } from '@nestjs/common';
import type { AuditService } from '../../audit/index.js';
import type { Identity } from '../../identity/index.js';
import type { PatientService } from '../../patient/index.js';
import { ChartAccess } from './access.js';
import { BtgAwareAudit } from './audit-port.js';
import { registerChartAssignmentSources } from './assignment.js';
import { BannerService } from './banner.js';
import type { PhotoUrlPort } from './banner.js';
import { chartResolvers, createChartControllers } from './controller.js';
import { ChartListsService } from './lists.js';
import { ChartSummaryService } from './summary.js';
import { TerminologyService } from './terminology.js';
import { VitalsService } from './vitals.js';
import type { Tx } from '@ehr/kernel';

export interface ChartDeps {
  db: KernelDb;
  audit: AuditService;
  /** The identity instance whose guard and assignment resolver the chart registers with. */
  identity: Pick<Identity, 'policy' | 'assignment'>;
  patients: Pick<PatientService, 'get' | 'mergedSurvivor'>;
  /** HMAC key of the list cursors. */
  cursorKey: string;
  photo?: PhotoUrlPort;
  documents?: (tx: Tx, patientId: string) => Promise<unknown[]>;
  encounters?: (tx: Tx, patientId: string) => Promise<unknown[]>;
  now?: () => Date;
}

export interface ClinicalChart {
  access: ChartAccess;
  banner: BannerService;
  lists: ChartListsService;
  vitals: VitalsService;
  terminology: TerminologyService;
  summary: ChartSummaryService;
  controllers: Type<unknown>[];
}

export function createClinicalChart(deps: ChartDeps): ClinicalChart {
  const access = new ChartAccess({
    db: deps.db,
    audit: deps.audit,
    assignment: deps.identity.assignment,
  });
  const audit = new BtgAwareAudit(deps.audit);
  const terminology = new TerminologyService();
  const nowDep = deps.now === undefined ? {} : { now: deps.now };
  const lists = new ChartListsService({ audit, terminology, cursorKey: deps.cursorKey, ...nowDep });
  const vitals = new VitalsService({ audit, patients: deps.patients, ...nowDep });
  const banner = new BannerService({
    audit,
    patients: deps.patients,
    access,
    ...(deps.photo === undefined ? {} : { photo: deps.photo }),
  });
  const summary = new ChartSummaryService({
    audit,
    access,
    banner,
    lists,
    vitals,
    ...(deps.documents === undefined ? {} : { documents: deps.documents }),
    ...(deps.encounters === undefined ? {} : { encounters: deps.encounters }),
  });
  for (const [name, fn] of Object.entries(chartResolvers()))
    deps.identity.policy.registerResolver(name, fn);
  registerChartAssignmentSources(deps.identity.assignment);
  const controllers = createChartControllers({
    db: deps.db,
    access,
    banner,
    lists,
    summary,
    terminology,
    vitals,
  });
  return { access, banner, lists, vitals, terminology, summary, controllers };
}
