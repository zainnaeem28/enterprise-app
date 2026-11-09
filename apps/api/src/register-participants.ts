// The ONE registration of every merge participant and export contributor (ARCHITECTURE 22.16, 24; INT03-F04). The composition root
// (main.ts through `registerAllParticipants`) and every dbtest harness call this, so the registries of a test hold exactly what
// production holds. The shared database holds every module's tables, so a harness that registered only its own module's participants
// failed the merge executor (patient.merge_participant_missing) and the export assembly (privacy.contributor_missing).
//
// Registered, in order (each registration is a RegistryError when repeated):
//   identity        merge participant + export contributor
//   notifications   merge participant + export contributor (covers the staff-alert tables)
//   scheduling      through the flow participant INSTEAD of the booking core's (it covers the core's tables too)
//   telehealth      merge participant + export contributor
//   documents       merge participant + export contributor
//   clinical        the ONE `clinical` participant and contributor: chart, front door and notes parts
//   messaging       merge participant + export contributor
//   privacy         merge participant (its own export part is produced by the assembly itself)
// Reporting holds no patient_id table and registers nothing. The patient module's own participant is not registered: the executor
// runs it first.
import { ParticipantRegistries, defaultRegistries } from '@ehr/kernel';
import { registerNotesParticipants } from './modules/clinical/notes/index.js';
import { registerDocumentsParticipants } from './modules/documents/index.js';
import { registerIdentityParticipants } from './modules/identity/index.js';
import { registerMessagingParticipants } from './modules/messaging/index.js';
import { registerNotificationsParticipants } from './modules/notifications/index.js';
import { registerPrivacyParticipants } from './modules/privacy/index.js';
import { registerSchedulingFlowParticipants } from './modules/scheduling/flow/index.js';
import { registerTelehealthParticipants } from './modules/telehealth/index.js';

/** The modules the helper registers, as `ParticipantRegistries` names them (merge participants; contributors are the same less privacy). */
export const REGISTERED_MERGE_MODULES = [
  'identity',
  'notifications',
  'scheduling',
  'telehealth',
  'documents',
  'clinical',
  'messaging',
  'privacy',
] as const;
export type RegisteredModule = (typeof REGISTERED_MERGE_MODULES)[number];
export const REGISTERED_EXPORT_MODULES = REGISTERED_MERGE_MODULES.filter((m) => m !== 'privacy');

/** Called once per registry; a second call is a RegistryError. */
export function registerAllParticipants(
  registries: ParticipantRegistries = defaultRegistries,
  opts: { without?: readonly RegisteredModule[] } = {},
): void {
  const on = (m: RegisteredModule): boolean => !(opts.without ?? []).includes(m);
  if (on('identity')) registerIdentityParticipants(registries);
  if (on('notifications')) registerNotificationsParticipants(registries);
  if (on('scheduling')) registerSchedulingFlowParticipants(registries);
  if (on('telehealth')) registerTelehealthParticipants(registries);
  if (on('documents')) registerDocumentsParticipants(registries);
  if (on('clinical')) registerNotesParticipants(registries);
  if (on('messaging')) registerMessagingParticipants(registries);
  if (on('privacy')) registerPrivacyParticipants(registries);
}

/**
 * A fresh registry holding every participant: what a dbtest harness passes to the services under test. `without` is for NEGATIVE
 * CONTROLS only (a missing registration must fail the merge or the export); no harness leaves a module out to make a test pass.
 */
export function newRegisteredRegistries(
  opts: { without?: readonly RegisteredModule[] } = {},
): ParticipantRegistries {
  const r = new ParticipantRegistries();
  registerAllParticipants(r, opts);
  return r;
}
