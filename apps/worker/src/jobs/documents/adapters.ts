// The scanner and OCR adapters, implementing the BE-02 interface (apps/worker/src/jobs/integration-core/adapters.ts). Neither opens
// its own log, retry or circuit, and neither names a host: the real vendor or service sits behind an injected client, because none is
// chosen or provisioned (C-01 object store and malware scan, C-10 OCR; TEST-CASES 3). So nothing here proves a real scanner or OCR
// vendor; the scan result tag name, its values and its timing are Unverified until staging (ARCHITECTURE 25.10, 41).
import { AdapterFailure } from '../integration-core/index.js';
import type {
  ConnectionView,
  CredentialReader,
  HealthResult,
  VendorAdapter,
  VendorCall,
  VendorResult,
} from '../integration-core/index.js';
import type { Bucket, ScanCaller, ScanState } from './ports.js';

// ---- malware scan --------------------------------------------------------------------------------------------------------------
/**
 * The scanner's shape. It is the BE-02 `VendorAdapter` contract for a kind the contract does not list yet: `malware_scan` is a
 * connection kind (22.3) but not an entry of ADAPTER_KINDS / ADAPTER_OPERATIONS, so `AdapterRegistry.register` and `callVendor`
 * refuse it. Adding `malware_scan: ['scan_result']` there is a contract change (README, open item O-4); until then the scan job
 * calls the adapter directly through {@link scannerCaller}, with the same timeout and error rules.
 */
export interface ScannerAdapter extends Omit<VendorAdapter, 'kind' | 'call' | 'find'> {
  readonly kind: 'malware_scan';
  call(req: VendorCall & { operation: 'scan_result' }): Promise<VendorResult>;
}

/** What the object store's scan service leaves on the object: one tag value, or none yet. */
export interface ScanTagClient {
  readScanTag(req: {
    bucket: Bucket;
    key: string;
    signal: AbortSignal;
  }): Promise<{ value: string | null }>;
  health(req: { signal: AbortSignal }): Promise<{ ok: boolean }>;
}

/** Tag values by meaning. The defaults are a GUESS to be replaced at staging (Unverified): anything not listed is `error`, never clean. */
export interface TagMapping {
  clean: readonly string[];
  infected: readonly string[];
  pending: readonly string[];
}
export const DEFAULT_TAG_MAPPING: TagMapping = {
  clean: ['NO_THREATS_FOUND', 'clean'],
  infected: ['THREATS_FOUND', 'infected'],
  pending: [],
};

export class TagScannerAdapter implements ScannerAdapter {
  readonly kind = 'malware_scan' as const;
  readonly supportsIdempotencyToken = false;
  readonly timeoutMs = 10_000;
  constructor(
    private readonly client: ScanTagClient,
    private readonly mapping: TagMapping = DEFAULT_TAG_MAPPING,
  ) {}

  async call(req: VendorCall & { operation: 'scan_result' }): Promise<VendorResult> {
    if ((req.operation as string) !== 'scan_result')
      throw new AdapterFailure(false, undefined, 'unsupported_operation');
    const bucket = req.args['bucket'];
    const key = req.args['key'];
    if (
      (bucket !== 'quarantine' && bucket !== 'clean') ||
      typeof key !== 'string' ||
      !/^[qc]\/[0-9a-f]{32}$/.test(key)
    )
      throw new AdapterFailure(false, undefined, 'bad_arguments');
    try {
      const { value } = await this.client.readScanTag({ bucket, key, signal: req.signal });
      let state: ScanState;
      if (value === null) state = 'pending';
      else if (this.mapping.clean.includes(value)) state = 'clean';
      else if (this.mapping.infected.includes(value)) state = 'infected';
      else if (this.mapping.pending.includes(value)) state = 'pending';
      else state = 'error'; // an unknown value is never clean
      return { data: { state } };
    } catch {
      throw new AdapterFailure(true, undefined, 'scanner_unavailable');
    }
  }

  async healthCheck(
    req: Omit<VendorCall, 'operation' | 'args' | 'idempotencyToken'>,
  ): Promise<HealthResult> {
    try {
      return await this.client.health({ signal: req.signal });
    } catch {
      return { ok: false };
    }
  }
}

/** The scan job's view of a scanner: asks for one object's verdict under the adapter's timeout; a failure THROWS (it is never `clean`). */
export function scannerCaller(
  adapter: ScannerAdapter,
  connection: ConnectionView,
  credentials: CredentialReader,
  token: () => string,
): ScanCaller {
  return async (bucket, key) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), adapter.timeoutMs ?? 10_000);
    try {
      const r = await adapter.call({
        operation: 'scan_result',
        args: { bucket, key },
        connection,
        credentials,
        idempotencyToken: token(),
        signal: ctl.signal,
      });
      const s = (r.data as { state?: unknown } | null)?.state;
      if (s === 'pending' || s === 'clean' || s === 'infected' || s === 'error') return s;
      return 'error';
    } finally {
      clearTimeout(t);
    }
  };
}

// ---- OCR classification ---------------------------------------------------------------------------------------------------------
/** What a concrete OCR vendor (Textract, a document-AI service) implements. It reads the clean object by reference: no bytes pass through here. */
export interface OcrProviderClient {
  classify(req: {
    bucket: Bucket;
    key: string;
    idempotencyToken: string;
    connection: ConnectionView;
    credentials: CredentialReader;
    signal: AbortSignal;
  }): Promise<{ documentType: string | null; vendorRef?: string }>;
  health(req: {
    connection: ConnectionView;
    credentials: CredentialReader;
    signal: AbortSignal;
  }): Promise<{ ok: boolean }>;
}

export class OcrProviderError extends Error {
  constructor(
    readonly retryable: boolean,
    readonly httpStatus?: number,
    readonly errorClass = 'provider_error',
  ) {
    super(errorClass);
    this.name = 'OcrProviderError';
  }
}

/** `VendorAdapter<'ocr'>` of BE-02: operation `classify`. The suggestion is one of the closed classification list or null. */
export class OcrAdapter implements VendorAdapter<'ocr'> {
  readonly kind = 'ocr' as const;
  readonly supportsIdempotencyToken = true;
  readonly timeoutMs = 20_000;
  constructor(private readonly provider: OcrProviderClient) {}

  async call(req: VendorCall & { operation: 'classify' | 'lookup' }): Promise<VendorResult> {
    if (req.operation !== 'classify')
      throw new AdapterFailure(false, undefined, 'unsupported_operation');
    const bucket = req.args['bucket'];
    const key = req.args['key'];
    if (
      (bucket !== 'quarantine' && bucket !== 'clean') ||
      typeof key !== 'string' ||
      !/^[qc]\/[0-9a-f]{32}$/.test(key)
    )
      throw new AdapterFailure(false, undefined, 'bad_arguments');
    try {
      const r = await this.provider.classify({
        bucket,
        key,
        idempotencyToken: req.idempotencyToken,
        connection: req.connection,
        credentials: req.credentials,
        signal: req.signal,
      });
      return {
        data: { documentType: r.documentType },
        ...(r.vendorRef === undefined ? {} : { vendorRef: r.vendorRef.slice(0, 200) }),
      };
    } catch (e) {
      if (e instanceof OcrProviderError)
        throw new AdapterFailure(e.retryable, e.httpStatus, e.errorClass);
      throw new AdapterFailure(true, undefined, 'provider_exception');
    }
  }

  async healthCheck(
    req: Omit<VendorCall, 'operation' | 'args' | 'idempotencyToken'>,
  ): Promise<HealthResult> {
    try {
      return await this.provider.health({
        connection: req.connection,
        credentials: req.credentials,
        signal: req.signal,
      });
    } catch {
      return { ok: false };
    }
  }
}
