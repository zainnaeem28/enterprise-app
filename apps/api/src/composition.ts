// Composition root of the merge and export participants (ARCHITECTURE 22.16, 24). Every module that holds patient data registers
// its participant here, once, at start-up; the patient merge executor fails (patient.merge_participant_missing) when a table with a
// patient_id is covered by none. The patient module's own participant is not registered: the executor runs it first.
// Scheduling registers through the flow participant INSTEAD of the booking core's (it covers the core's tables too).
import { defaultRegistries } from '@ehr/kernel';
import type { KernelDb, ParticipantRegistries } from '@ehr/kernel';
import type { Type } from '@nestjs/common';
import { registerDocumentsParticipants } from './modules/documents/index.js';
import { registerIdentityParticipants, requireAuthContext } from './modules/identity/index.js';
import { createCatalogueControllers, OrganisationService } from './modules/organisation/index.js';
import { registerNotificationsParticipants } from './modules/notifications/index.js';
import { registerSchedulingFlowParticipants } from './modules/scheduling/flow/index.js';
import { registerTelehealthParticipants } from './modules/telehealth/index.js';

/** Called once per registry; a second call is a RegistryError. */
export function registerAllParticipants(
  registries: ParticipantRegistries = defaultRegistries,
): void {
  registerIdentityParticipants(registries);
  registerNotificationsParticipants(registries);
  registerSchedulingFlowParticipants(registries);
  registerTelehealthParticipants(registries);
  registerDocumentsParticipants(registries);
}

/**
 * HTTP controllers mounted by the API process. Each module's controllers are added here; a route that is not listed is not served.
 * Mounted: the patient catalogue reads (`GET /api/v1/services|locations`). They stay behind the guard policy given to `createApp`.
 */
export function buildControllers(deps: { db: KernelDb }): Type<unknown>[] {
  return [
    ...createCatalogueControllers({
      db: deps.db,
      organisation: new OrganisationService(),
      scopeOf: (req) => requireAuthContext(req).scope,
    }),
  ];
}
