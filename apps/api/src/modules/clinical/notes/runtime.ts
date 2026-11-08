// Wiring of the clinical notes: one call builds the services and the controllers from explicit dependencies and registers what the notes
// owe the identity module (their resolvers, the `authored` assignment source). Nothing here reads the environment; the application entry
// point supplies the pieces.
import type { KernelDb } from '@ehr/kernel';
import type { Type } from '@nestjs/common';
import type { AuditService } from '../../audit/index.js';
import type { Identity } from '../../identity/index.js';
import type { ChartAccess } from '../chart/access.js';
import { BtgAwareAudit } from '../chart/audit-port.js';
import type { BannerService } from '../chart/banner.js';
import type { ConsentGateService } from '../frontdoor/consents.js';
import { registerNotesAssignmentSources } from './assignment.js';
import { createNotesControllers, notesResolvers } from './controller.js';
import { EncounterService } from './encounters.js';
import { NoteService } from './notes.js';
import { NoteReadService } from './read.js';
import type { NotesPorts } from './ports.js';
import { NoteReminderService } from './reminder.js';

export interface NotesDeps {
  db: KernelDb;
  /** The audit service; wrapped in the chart's BTG-aware port. */
  audit: AuditService;
  /** The chart's services (BE-16): access and banner. */
  chart: { access: ChartAccess; banner: BannerService };
  /** The front door's consent gate (BE-18), which `POST /encounters` calls before the consultation starts. */
  consentGate: Pick<ConsentGateService, 'start'>;
  identity: Pick<Identity, 'policy' | 'assignment'>;
  ports: NotesPorts;
  /** The HMAC key of the list cursors; the same secret as `ChartDeps.cursorKey` (decision HEAAA-286). */
  cursorKey: string;
  now?: () => Date;
}

export interface ClinicalNotes {
  encounters: EncounterService;
  notes: NoteService;
  reads: NoteReadService;
  reminder: NoteReminderService;
  controllers: Type<unknown>[];
}

export function createClinicalNotes(deps: NotesDeps): ClinicalNotes {
  const audit = new BtgAwareAudit(deps.audit);
  const nowDep = deps.now === undefined ? {} : { now: deps.now };
  const encounters = new EncounterService({
    audit,
    gate: deps.consentGate,
    ports: deps.ports,
    ...nowDep,
  });
  const notes = new NoteService({
    audit,
    access: deps.chart.access,
    ports: deps.ports,
    ...nowDep,
  });
  const reads = new NoteReadService({
    db: deps.db,
    audit,
    denied: deps.audit,
    access: deps.chart.access,
    banner: deps.chart.banner,
    cursorKey: deps.cursorKey,
    ...nowDep,
  });
  const reminder = new NoteReminderService({ alerts: deps.ports.alerts });
  for (const [name, fn] of Object.entries(notesResolvers()))
    deps.identity.policy.registerResolver(name, fn);
  registerNotesAssignmentSources(deps.identity.assignment);
  const controllers = createNotesControllers({
    db: deps.db,
    banner: deps.chart.banner,
    encounters,
    notes,
    reads,
    audit: deps.audit,
  });
  return { encounters, notes, reads, reminder, controllers };
}
