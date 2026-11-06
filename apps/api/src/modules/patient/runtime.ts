// Wiring of the patient module: one call builds the services and the controllers from explicit dependencies and registers what
// the patient module owes the identity module (the scope contributor, the guard's staff probe via `patientInScope`, the
// resource resolvers). Nothing here reads the environment; the application entry point supplies the pieces.
import type { KernelDb, Queue } from '@ehr/kernel';
import type { Type } from '@nestjs/common';
import type { RateLimiter } from '../../platform/rate-limit.js';
import type { AuditService } from '../audit/index.js';
import type { Identity } from '../identity/index.js';
import { createPatientControllers, patientResolvers } from './controller.js';
import { PatientRecordsService } from './records.js';
import type { ConsentTemplatePort, StaffDirectoryPort } from './records.js';
import { patientScopeContributor } from './scope.js';
import { PatientService } from './service.js';
import type { Tx } from '@ehr/kernel';

export interface PatientDeps {
  db: KernelDb;
  audit: AuditService;
  /** The identity instance whose guard and scope builder the patient module registers with. */
  identity: Pick<Identity, 'policy' | 'scopes' | 'proxies'>;
  limiter: RateLimiter;
  /** `<env>/app/match-check-key` (22.6). */
  matchKey: string;
  consentTemplates: ConsentTemplatePort;
  staff: StaffDirectoryPort;
  queue?: Queue;
  attachEnabled?: (tx: Tx) => Promise<boolean>;
  labelLimitPerHour?: number;
  proxyRulesConfigured?: boolean;
  now?: () => Date;
}

export interface Patient {
  patients: PatientService;
  records: PatientRecordsService;
  controllers: Type<unknown>[];
}

export function createPatient(deps: PatientDeps): Patient {
  const patients = new PatientService({
    audit: deps.audit,
    matchKey: deps.matchKey,
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.attachEnabled === undefined ? {} : { attachEnabled: deps.attachEnabled }),
    ...(deps.queue === undefined ? {} : { queue: deps.queue }),
  });
  const records = new PatientRecordsService({
    audit: deps.audit,
    consentTemplates: deps.consentTemplates,
    staff: deps.staff,
    ...(deps.queue === undefined ? {} : { queue: deps.queue }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
  for (const [name, fn] of Object.entries(patientResolvers()))
    deps.identity.policy.registerResolver(name, fn);
  deps.identity.scopes.registerScopeContributor(patientScopeContributor);
  const controllers = createPatientControllers({
    db: deps.db,
    patients,
    records,
    proxies: deps.identity.proxies,
    limiter: deps.limiter,
    ...(deps.labelLimitPerHour === undefined ? {} : { labelLimitPerHour: deps.labelLimitPerHour }),
    ...(deps.proxyRulesConfigured === undefined
      ? {}
      : { proxyRulesConfigured: deps.proxyRulesConfigured }),
  });
  return { patients, records, controllers };
}
