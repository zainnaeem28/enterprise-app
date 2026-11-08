// Wiring of the clinical front door: one call builds the services and the controllers from explicit dependencies. Nothing here
// reads the environment; the application entry point supplies the pieces.
import type { KernelDb, Tx } from '@ehr/kernel';
import type { Type } from '@nestjs/common';
import type { Identity } from '../../identity/index.js';
import type { ChartAccess } from '../chart/access.js';
import type { AuditService } from '../../audit/index.js';
import { BtgAwareAudit } from '../chart/audit-port.js';
import type { BannerService } from '../chart/banner.js';
import type { VitalsService } from '../chart/vitals.js';
import { ConsentGateService } from './consents.js';
import { createFrontdoorControllers, frontdoorResolvers } from './controller.js';
import { FollowUpService } from './followups.js';
import type { FrontdoorPorts } from './ports.js';
import { QuestionnaireService } from './questionnaire.js';
import { ReferralService } from './referrals.js';
import { TriageService } from './triage.js';

export interface FrontdoorDeps {
  db: KernelDb;
  /** The chart's services (BE-16): the audit port (BTG-aware), access, banner and vitals. */
  chart: { access: ChartAccess; banner: BannerService; vitals: VitalsService };
  /** The audit service; the front door wraps it in the chart's BTG-aware port, as the chart does. */
  audit: AuditService;
  identity: Pick<Identity, 'policy'>;
  ports: FrontdoorPorts;
  now?: () => Date;
}

export interface ClinicalFrontdoor {
  questionnaires: QuestionnaireService;
  triage: TriageService;
  consentGate: ConsentGateService;
  referrals: ReferralService;
  followUps: FollowUpService;
  controllers: Type<unknown>[];
  /** For the scheduling flow's `PrevisitPort` (AC-09): `requiredConsents` and `questionnaireComplete`. */
  previsitPort: {
    requiredConsents(
      tx: Tx,
      serviceId: string,
    ): Promise<readonly { key: string; version: number }[]>;
    questionnaireComplete(tx: Tx, patientId: string, reservationId: string): Promise<boolean>;
  };
}

export function createClinicalFrontdoor(deps: FrontdoorDeps): ClinicalFrontdoor {
  const { ports } = deps;
  const audit = new BtgAwareAudit(deps.audit);
  const nowDep = deps.now === undefined ? {} : { now: deps.now };
  const questionnaires = new QuestionnaireService({
    audit,
    access: deps.chart.access,
    catalog: ports.catalog,
    checkIns: ports.checkIns,
  });
  const triage = new TriageService({
    audit,
    checkIns: ports.checkIns,
    duty: ports.duty,
    alerts: ports.alerts,
    catalog: ports.catalog,
    events: ports.events,
    ...nowDep,
  });
  const consentGate = new ConsentGateService({
    audit,
    catalog: ports.catalog,
    consents: ports.consents,
  });
  const referrals = new ReferralService({ audit, catalog: ports.catalog, care: ports.care });
  const followUps = new FollowUpService({ audit, checkIns: ports.checkIns, ...nowDep });
  for (const [name, fn] of Object.entries(frontdoorResolvers()))
    deps.identity.policy.registerResolver(name, fn);
  const controllers = createFrontdoorControllers({
    db: deps.db,
    banner: deps.chart.banner,
    vitals: deps.chart.vitals,
    checkIns: ports.checkIns,
    questionnaires,
    triage,
    referrals,
    followUps,
  });
  return {
    questionnaires,
    triage,
    consentGate,
    referrals,
    followUps,
    controllers,
    previsitPort: {
      requiredConsents: (tx, serviceId) => ports.catalog.requiredConsents(tx, serviceId),
      questionnaireComplete: (tx, patientId, reservationId) =>
        questionnaires.complete(tx, patientId, reservationId),
    },
  };
}
