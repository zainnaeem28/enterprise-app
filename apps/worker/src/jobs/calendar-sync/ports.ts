// What the calendar-sync jobs need from their surroundings. The worker cannot import the API package, so the jobs depend on these
// narrow ports; integration-core's `VendorGateway` is the `vendor` implementation (the only way worker code reaches Google, 24).
import type { KernelDb, Logger, Queue } from '@ehr/kernel';
import type { VendorResult } from '../integration-core/index.js';

export interface VendorPort {
  callVendor(
    kind: string,
    operation: string,
    args?: Readonly<Record<string, unknown>>,
    correlation?: { type?: string; id?: string; idempotencyToken?: string },
  ): Promise<VendorResult>;
}

/** The channel-token key (29.5): `<env>/integration/inbound/google-calendar-channel-key`, current version. The worker is its only writer. */
export interface ChannelKeyProvider {
  current(): Promise<{ version: string; key: Buffer }>;
}

export interface CalendarJobDeps {
  db: KernelDb;
  orgId: string;
  /** Worker-path queue (`new Queue(registry, 'worker')`). */
  queue: Queue;
  vendor: VendorPort;
  channelKeys: ChannelKeyProvider;
  /** The public URL of `POST /webhooks/google/calendar` on the integrations host. Configuration, never a setting or a request. */
  webhookUrl: string;
  log: Logger;
  now?: () => Date;
}

export const nowOf = (d: { now?: () => Date }): Date => (d.now ?? (() => new Date()))();
