// Vendor adapter interfaces, one per connection kind (ARCHITECTURE 22.3 kinds; R1 vendors: email, SMS, push, video,
// calendar, OCR). This ticket defines the contract and the registry; each concrete adapter is delivered by the ticket that
// needs it (notifications, telehealth, calendar-sync, documents). An adapter never opens its own log, retry or circuit:
// `callVendor` wraps every call (call-vendor.ts). An adapter reads credentials only through `CredentialReader`.
export const ADAPTER_KINDS = ['email', 'sms', 'push', 'video', 'google_calendar', 'ocr'] as const;
export type AdapterKind = (typeof ADAPTER_KINDS)[number];

/** The operations each kind exposes through `callVendor`. Adding one is a contract change (HEAAA-13), not an adapter edit. */
export const ADAPTER_OPERATIONS = {
  email: ['send', 'lookup'],
  sms: ['send', 'lookup'],
  push: ['send'],
  video: ['create_meeting', 'end_meeting', 'join_token', 'lookup_meeting'],
  google_calendar: ['push_busy', 'delete_busy', 'incremental_sync', 'watch', 'stop_watch'],
  ocr: ['classify', 'lookup'],
} as const satisfies Record<AdapterKind, readonly string[]>;

export type OperationOf<K extends AdapterKind> = (typeof ADAPTER_OPERATIONS)[K][number];

/** Non-secret connection settings as stored (22.3 `settings`). Credentials come from {@link CredentialReader}. */
export interface ConnectionView {
  id: string;
  kind: string;
  vendor: string;
  settings: Readonly<Record<string, unknown>>;
}

/** Read-through, in-memory-only credential access (9.1: cached at most 5 minutes). Values are never logged or persisted. */
export interface CredentialReader {
  get(secretName: string): Promise<string>;
}

export interface VendorCall {
  operation: string;
  /** IDs and non-clinical arguments the adapter needs. The call log never stores them. */
  args: Readonly<Record<string, unknown>>;
  connection: ConnectionView;
  credentials: CredentialReader;
  /** Our idempotency token for this logical call, identical across the retries of one `callVendor` (34.3). */
  idempotencyToken: string;
  /** Aborted when the timeout elapses. An adapter passes it to its HTTP client. */
  signal: AbortSignal;
}

export interface VendorResult {
  /** What the caller gets back. Never logged by the wrapper. */
  data: unknown;
  httpStatus?: number;
  /** The vendor's reference for the object (message ID, meeting ID); stored in the call log, <= 200 chars. */
  vendorRef?: string;
}

export interface HealthResult {
  ok: boolean;
  httpStatus?: number;
}

export interface VendorAdapter<K extends AdapterKind = AdapterKind> {
  readonly kind: K;
  /** True when the vendor accepts our idempotency token (email, SMS, video, OCR: checked per vendor at G2). */
  readonly supportsIdempotencyToken: boolean;
  /** Per-call timeout in ms. Default 10 s. */
  readonly timeoutMs?: number;
  call(req: VendorCall & { operation: OperationOf<K> }): Promise<VendorResult>;
  /**
   * For a vendor without an idempotency token (34.3): ask it for the object by our correlation ID. `callVendor` uses this
   * before it repeats a call whose previous attempt ended uncertain (timeout), and returns the object if it exists.
   */
  find?(req: VendorCall): Promise<VendorResult | null>;
  /** "Test connection" and the health job (9.1, 34.2): a cheap authenticated call. It never echoes a credential. */
  healthCheck(
    req: Omit<VendorCall, 'operation' | 'args' | 'idempotencyToken'>,
  ): Promise<HealthResult>;
}

export class AdapterRegistry {
  private readonly byKind = new Map<AdapterKind, VendorAdapter>();

  register<K extends AdapterKind>(adapter: VendorAdapter<K>): void {
    if (!(ADAPTER_KINDS as readonly string[]).includes(adapter.kind))
      throw new Error(`no adapter interface for kind ${String(adapter.kind)}`);
    if (this.byKind.has(adapter.kind))
      throw new Error(`adapter for ${adapter.kind} already registered`);
    this.byKind.set(adapter.kind, adapter as unknown as VendorAdapter);
  }

  get(kind: string): VendorAdapter | undefined {
    return this.byKind.get(kind as AdapterKind);
  }
}
