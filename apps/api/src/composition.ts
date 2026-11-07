// Composition root of the merge and export participants (ARCHITECTURE 22.16, 24). Every module that holds patient data registers
// its participant here, once, at start-up; the patient merge executor fails (patient.merge_participant_missing) when a table with a
// patient_id is covered by none. The patient module's own participant is not registered: the executor runs it first.
// Scheduling registers through the flow participant INSTEAD of the booking core's (it covers the core's tables too).
import { defaultRegistries } from '@ehr/kernel';
import type { ParticipantRegistries } from '@ehr/kernel';
import { registerDocumentsParticipants } from './modules/documents/index.js';
import { registerIdentityParticipants } from './modules/identity/index.js';
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
