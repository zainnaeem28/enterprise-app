// Vendor adapters for the three outbound channels, implementing the BE-02 interface (`VendorAdapter`). An adapter never
// opens its own log, retry or circuit: `callVendor` wraps it. The REAL providers are C-10 (e-mail/SMS) and C-11 (push); they
// are not chosen, and no sandbox exists (TEST-CASES 3), so the provider is an injected `ProviderClient` and this ticket
// ships no network client. Nothing here names a host: hostnames come from code or infrastructure, never from `settings`
// (INT-N7, SEC01-F-12). Arguments carry the address and the rendered text; they are used to send and never logged.
import { AdapterFailure } from '../integration-core/index.js';
import type {
  AdapterKind,
  ConnectionView,
  CredentialReader,
  HealthResult,
  OperationOf,
  VendorAdapter,
  VendorCall,
  VendorResult,
} from '../integration-core/index.js';

export class ProviderError extends Error {
  constructor(
    readonly retryable: boolean,
    readonly httpStatus?: number,
    readonly errorClass = 'provider_error',
  ) {
    super(errorClass);
    this.name = 'ProviderError';
  }
}

export interface ProviderRequest {
  to: string;
  /** E-mail subject or push title. */
  subject?: string;
  text: string;
  attachments?: readonly { filename: string; contentType: string; content: string }[];
  /** Our token for this logical send, identical on every retry; the provider de-duplicates on it. */
  idempotencyToken: string;
  connection: ConnectionView;
  credentials: CredentialReader;
  signal: AbortSignal;
}

/** What a concrete provider (SES, an SMS gateway, a push service) implements. Throw {@link ProviderError} on failure. */
export interface ProviderClient {
  send(req: ProviderRequest): Promise<{ messageId: string; httpStatus?: number }>;
  health(req: {
    connection: ConnectionView;
    credentials: CredentialReader;
    signal: AbortSignal;
  }): Promise<{ ok: boolean; httpStatus?: number }>;
}

const EMAIL = /^[^\s@<>()[\],;:\\"]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}$/;
const E164 = /^\+[1-9]\d{6,14}$/;

function str(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.length >= 1 && v.length <= max ? v : undefined;
}
const noLineBreak = (v: string): boolean => !/[\r\n\u2028\u2029]/.test(v);

abstract class ChannelAdapter<K extends AdapterKind> implements VendorAdapter<K> {
  abstract readonly kind: K;
  readonly timeoutMs = 10_000;
  /** True when the vendor de-duplicates on our token (the default contract). SES, End User Messaging SMS and Web Push do not: they pass `false`. */
  readonly supportsIdempotencyToken: boolean;
  constructor(
    protected readonly provider: ProviderClient,
    opts: { supportsIdempotencyToken?: boolean } = {},
  ) {
    this.supportsIdempotencyToken = opts.supportsIdempotencyToken ?? true;
  }

  protected abstract request(
    args: Readonly<Record<string, unknown>>,
  ): Omit<ProviderRequest, 'idempotencyToken' | 'connection' | 'credentials' | 'signal'>;

  async call(req: VendorCall & { operation: OperationOf<K> }): Promise<VendorResult> {
    if ((req.operation as string) !== 'send')
      throw new AdapterFailure(false, undefined, 'unsupported_operation');
    let built: ReturnType<ChannelAdapter<K>['request']>;
    try {
      built = this.request(req.args);
    } catch {
      throw new AdapterFailure(false, undefined, 'bad_arguments'); // never echoes the argument
    }
    try {
      const r = await this.provider.send({
        ...built,
        idempotencyToken: req.idempotencyToken,
        connection: req.connection,
        credentials: req.credentials,
        signal: req.signal,
      });
      return {
        data: null,
        vendorRef: r.messageId.slice(0, 200),
        ...(r.httpStatus === undefined ? {} : { httpStatus: r.httpStatus }),
      };
    } catch (e) {
      if (e instanceof ProviderError)
        throw new AdapterFailure(e.retryable, e.httpStatus, e.errorClass);
      throw new AdapterFailure(true, undefined, 'provider_exception');
    }
  }

  async healthCheck(
    req: Omit<VendorCall, 'operation' | 'args' | 'idempotencyToken'>,
  ): Promise<HealthResult> {
    try {
      const h = await this.provider.health({
        connection: req.connection,
        credentials: req.credentials,
        signal: req.signal,
      });
      return { ok: h.ok, ...(h.httpStatus === undefined ? {} : { httpStatus: h.httpStatus }) };
    } catch {
      return { ok: false };
    }
  }
}

export class EmailAdapter extends ChannelAdapter<'email'> {
  readonly kind = 'email' as const;
  protected request(
    args: Readonly<Record<string, unknown>>,
  ): Omit<ProviderRequest, 'idempotencyToken' | 'connection' | 'credentials' | 'signal'> {
    const to = str(args['to'], 254);
    const subject = str(args['subject'], 200);
    const text = str(args['text'], 20000);
    if (
      to === undefined ||
      !EMAIL.test(to) ||
      subject === undefined ||
      !noLineBreak(subject) ||
      text === undefined
    )
      throw new Error('bad');
    const atts = args['attachments'];
    const attachments: { filename: string; contentType: string; content: string }[] = [];
    if (atts !== undefined) {
      if (!Array.isArray(atts) || atts.length > 2) throw new Error('bad');
      for (const a of atts as Record<string, unknown>[]) {
        const filename = str(a['filename'], 80);
        const contentType = str(a['contentType'], 80);
        const content = str(a['content'], 20000);
        if (
          filename === undefined ||
          !/^[A-Za-z0-9._-]+$/.test(filename) ||
          contentType === undefined ||
          content === undefined
        )
          throw new Error('bad');
        attachments.push({ filename, contentType, content });
      }
    }
    return { to, subject, text, ...(attachments.length > 0 ? { attachments } : {}) };
  }
}

export class SmsAdapter extends ChannelAdapter<'sms'> {
  readonly kind = 'sms' as const;
  protected request(
    args: Readonly<Record<string, unknown>>,
  ): Omit<ProviderRequest, 'idempotencyToken' | 'connection' | 'credentials' | 'signal'> {
    const to = str(args['to'], 16);
    const text = str(args['text'], 480);
    if (to === undefined || !E164.test(to) || text === undefined) throw new Error('bad');
    return { to, text };
  }
}

export class PushAdapter extends ChannelAdapter<'push'> {
  readonly kind = 'push' as const;
  protected request(
    args: Readonly<Record<string, unknown>>,
  ): Omit<ProviderRequest, 'idempotencyToken' | 'connection' | 'credentials' | 'signal'> {
    const to = str(args['to'], 2000);
    const text = str(args['text'], 178);
    const subject = args['subject'] === undefined ? undefined : str(args['subject'], 80);
    if (
      to === undefined ||
      text === undefined ||
      (args['subject'] !== undefined && subject === undefined)
    )
      throw new Error('bad');
    return { to, text, ...(subject === undefined ? {} : { subject }) };
  }
}
