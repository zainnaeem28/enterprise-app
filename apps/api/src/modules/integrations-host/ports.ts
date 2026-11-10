// What this module needs from its neighbours, as structural ports. It imports no other module (the module graph has no node
// for it); the composition root passes the real OrganisationService, the scheduling availability service and the
// integration-core InboundReceiver, which satisfy these shapes.
import type { Tx } from '@ehr/kernel';

export interface PublicLocation {
  id: string;
  name: string;
  kind: string;
  timeZone: string;
  address: unknown;
  stateCode: string;
  geo: unknown;
  phone: string | null;
}

export interface PublicService {
  id: string;
  patientDisplayName: string;
  durationMin: number;
  mode: string;
}

export interface PublicBanner {
  id: string;
  message: string;
  startsAt: string;
  endsAt: string;
}

/** `organisation.directory*` (24): each reads only the C0 views of 22.5.1. */
export interface DirectoryOrganisationPort {
  directoryLocations(tx: Tx): Promise<PublicLocation[]>;
  directoryServices(tx: Tx, filter?: { locationId?: string }): Promise<PublicService[]>;
  directoryServiceClinicians(tx: Tx, serviceId: string): Promise<string[]>;
  directoryBanners(tx: Tx): Promise<PublicBanner[]>;
}

/** `scheduling.directoryClinicianLocations`: (clinician, location) pairs with an active, unended template, from the C0 view. */
export interface DirectorySchedulingPort {
  directoryClinicianLocations(
    tx: Tx,
    locationId?: string | null,
  ): Promise<{ clinicianId: string; locationId: string }[]>;
}

/** The status the route must send, as integration-core's `InboundReceiver.receive` returns it. */
export type WebhookStatus = { status: 200; outcome: 'inserted' | 'duplicate' } | { status: number };

export interface WebhookReceiverPort {
  receive(req: {
    source: string;
    headers: Readonly<Record<string, string | undefined>>;
    rawBody: Buffer;
  }): Promise<WebhookStatus>;
}
