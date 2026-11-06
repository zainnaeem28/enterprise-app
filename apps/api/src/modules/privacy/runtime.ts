// Wiring of the privacy module: one call builds the services and the controllers from explicit dependencies and registers what the
// module owes the identity module (its resolvers). Nothing here reads the environment; the application entry point supplies the pieces.
import type { KernelDb, Queue } from '@ehr/kernel';
import type { Type } from '@nestjs/common';
import type { AuditService } from '../audit/index.js';
import type { Identity } from '../identity/index.js';
import type { OrganisationService } from '../organisation/index.js';
import { createPrivacyControllers, privacyResolvers } from './controller.js';
import { IncidentService } from './incidents.js';
import { PackageService } from './packages.js';
import type { PackageStorePort } from './ports.js';
import { RequestService } from './requests.js';

export interface PrivacyDeps {
  db: KernelDb;
  audit: Pick<AuditService, 'record'>;
  organisation: Pick<OrganisationService, 'settingOrNull'>;
  identity: Pick<Identity, 'policy'>;
  /** API-path queue: `privacy.assemble_export`, `privacy.check_legal_holds` and the correction event. */
  queue: Queue;
  /** The package store's presigner. */
  store: PackageStorePort;
  now?: () => Date;
}

export interface Privacy {
  requests: RequestService;
  packages: PackageService;
  incidents: IncidentService;
  controllers: Type<unknown>[];
}

export function createPrivacy(deps: PrivacyDeps): Privacy {
  const nowDep = deps.now === undefined ? {} : { now: deps.now };
  const requests = new RequestService({
    audit: deps.audit,
    organisation: deps.organisation,
    queue: deps.queue,
    ...nowDep,
  });
  const packages = new PackageService({ audit: deps.audit, store: deps.store, ...nowDep });
  const incidents = new IncidentService({ audit: deps.audit, ...nowDep });
  for (const [name, fn] of Object.entries(privacyResolvers()))
    deps.identity.policy.registerResolver(name, fn);
  const controllers = createPrivacyControllers({ db: deps.db, requests, packages, incidents });
  return { requests, packages, incidents, controllers };
}
