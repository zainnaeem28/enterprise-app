// `callVendor(connectionKind, op, args, correlation)` (ARCHITECTURE 24, 34.2, 34.3): the only way worker code reaches a
// vendor. For every call it
//   1. loads the connection (must exist and be enabled),
//   2. asks the circuit (closed / open fails fast / half-open admits one probe),
//   3. calls the adapter under a timeout, with the same idempotency token on every attempt,
//   4. retries retryable failures with exponential back-off and jitter (the queue retries the whole job after that),
//   5. records EVERY attempt in `integration_core.outbound_call` - including the ones refused before they left.
// The log holds IDs, an operation name, an outcome, a status, a latency and an error CLASS: never an argument, a response,
// a vendor message or a credential. A vendor without an idempotency token gets a `pending` row before the call (34.3).
import { randomUUID } from 'node:crypto';
import type { KernelDb, Logger } from '@ehr/kernel';
import {
  ADAPTER_KINDS,
  ADAPTER_OPERATIONS,
  type AdapterKind,
  type AdapterRegistry,
  type ConnectionView,
  type CredentialReader,
  type VendorAdapter,
  type VendorResult,
} from './adapters.js';
import { CircuitBreakers } from './circuit.js';
import {
  AdapterFailure,
  IntegrationError,
  IntegrationUsageError,
  VendorRejectedError,
  VendorUnavailableError,
} from './errors.js';
import { isUuid, systemScope } from './scope.js';
import { uuidv7 } from './ids.js';

export interface Correlation {
  /** What the call is about, for example `reservation`. Snake/dot case, <= 100 chars. */
  type?: string;
  id?: string;
  /** Stable across job retries so the vendor can de-duplicate; default: a fresh UUID per `callVendor`. */
  idempotencyToken?: string;
}

export interface GatewayDeps {
  db: KernelDb;
  orgId: string;
  adapters: AdapterRegistry;
  credentials: (connectionId: string) => CredentialReader;
  circuits?: CircuitBreakers;
  logger?: Logger;
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  defaultTimeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** The call log could not be written AFTER the call (the call itself is not undone). Raise the operations alert here. */
  onRecordFailure?: (info: { connectionId: string; operation: string }) => void;
}

type Outcome = 'ok' | 'timeout' | 'error' | 'rejected';

interface Attempt {
  outcome: Outcome;
  errorClass?: string;
  httpStatus?: number;
  latencyMs?: number;
  vendorRef?: string;
}

const CORR_TYPE = /^[a-z][a-z0-9_.]{0,99}$/;
const TOKEN = /^[A-Za-z0-9_-]{8,128}$/;

export class VendorGateway {
  readonly circuits: CircuitBreakers;
  private readonly maxAttempts: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(private readonly d: GatewayDeps) {
    this.circuits = d.circuits ?? new CircuitBreakers({ now: d.now ?? Date.now });
    this.maxAttempts = d.maxAttempts ?? 3;
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1 || this.maxAttempts > 8)
      throw new Error('maxAttempts must be 1..8');
    this.now = d.now ?? Date.now;
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = d.random ?? Math.random;
  }

  async callVendor(
    kind: string,
    operation: string,
    args: Readonly<Record<string, unknown>> = {},
    correlation: Correlation = {},
  ): Promise<VendorResult> {
    if (!(ADAPTER_KINDS as readonly string[]).includes(kind))
      throw new IntegrationUsageError('kind');
    if (!(ADAPTER_OPERATIONS[kind as AdapterKind] as readonly string[]).includes(operation))
      throw new IntegrationUsageError('operation');
    if (correlation.type !== undefined && !CORR_TYPE.test(correlation.type))
      throw new IntegrationUsageError('correlation.type');
    if (correlation.id !== undefined && !isUuid(correlation.id))
      throw new IntegrationUsageError('correlation.id');
    if (correlation.idempotencyToken !== undefined && !TOKEN.test(correlation.idempotencyToken))
      throw new IntegrationUsageError('correlation.idempotencyToken');
    const token = correlation.idempotencyToken ?? randomUUID();
    const adapter = this.d.adapters.get(kind);
    const conn = await this.connection(kind);

    // Refused before it leaves: no such connection, disabled, or no adapter installed. Logged when a connection exists.
    if (conn === undefined) throw new VendorUnavailableError('disabled');
    if (!conn.enabled) {
      await this.record(conn.view.id, operation, correlation, 1, {
        outcome: 'rejected',
        errorClass: 'disabled',
      });
      throw new VendorUnavailableError('disabled');
    }
    if (adapter === undefined) {
      await this.record(conn.view.id, operation, correlation, 1, {
        outcome: 'rejected',
        errorClass: 'no_adapter',
      });
      throw new VendorUnavailableError('disabled');
    }

    let lastUncertain = false;
    let lastReason: 'timeout' | 'error' = 'error';
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      if (!this.circuits.admit(conn.view.id)) {
        await this.record(conn.view.id, operation, correlation, attempt, {
          outcome: 'rejected',
          errorClass: 'circuit_open',
        });
        throw new VendorUnavailableError('circuit_open');
      }
      // 34.3: before repeating a call whose previous attempt ended uncertain on a vendor without a token, ask the vendor
      // for the object by our correlation ID first.
      if (lastUncertain && !adapter.supportsIdempotencyToken && adapter.find !== undefined) {
        const found = await this.safeFind(adapter, conn.view, operation, args, token);
        if (found !== null) {
          this.circuits.record(conn.view.id, true);
          await this.record(conn.view.id, operation, correlation, attempt, {
            outcome: 'ok',
            ...(found.httpStatus === undefined ? {} : { httpStatus: found.httpStatus }),
            ...(found.vendorRef === undefined ? {} : { vendorRef: found.vendorRef }),
          });
          return found;
        }
      }
      const pendingId = adapter.supportsIdempotencyToken
        ? undefined
        : await this.recordPending(conn.view.id, operation, correlation, attempt);
      const started = this.now();
      let result: VendorResult | undefined;
      let a: Attempt;
      try {
        result = await this.withTimeout(adapter, conn.view, operation, args, token);
        a = {
          outcome: 'ok',
          latencyMs: this.now() - started,
          ...(result.httpStatus === undefined ? {} : { httpStatus: result.httpStatus }),
          ...(result.vendorRef === undefined ? {} : { vendorRef: result.vendorRef.slice(0, 200) }),
        };
      } catch (err) {
        a = this.classify(err, this.now() - started);
      }
      await this.finish(pendingId, conn.view.id, operation, correlation, attempt, a);

      if (a.outcome === 'ok' && result !== undefined) {
        this.circuits.record(conn.view.id, true);
        return result;
      }
      const retryable = a.errorClass !== 'vendor_rejected';
      // A vendor 4xx says nothing about the vendor's health: release the probe slot, leave the counters alone.
      if (!retryable) {
        this.circuits.release(conn.view.id);
        throw new VendorRejectedError(a.httpStatus);
      }
      this.circuits.record(conn.view.id, false);
      lastUncertain = a.outcome === 'timeout';
      lastReason = a.outcome === 'timeout' ? 'timeout' : 'error';
      if (attempt < this.maxAttempts) await this.sleep(this.backoff(attempt));
    }
    throw new VendorUnavailableError(lastReason === 'timeout' ? 'timeout' : 'exhausted');
  }

  /** Exponential back-off with full jitter on the upper half: 200 ms, 400 ms, ... capped at 5 s. */
  private backoff(attempt: number): number {
    const base = this.d.backoffBaseMs ?? 200;
    const cap = this.d.backoffCapMs ?? 5_000;
    const ceiling = Math.min(cap, base * 2 ** (attempt - 1));
    return Math.floor(ceiling / 2 + this.random() * (ceiling / 2));
  }

  private classify(err: unknown, latencyMs: number): Attempt {
    if (err instanceof TimeoutMarker)
      return { outcome: 'timeout', errorClass: 'timeout', latencyMs };
    if (err instanceof AdapterFailure) {
      const base = {
        latencyMs,
        ...(err.httpStatus === undefined ? {} : { httpStatus: err.httpStatus }),
      };
      return err.retryable
        ? { outcome: 'error', errorClass: err.errorClass, ...base }
        : { outcome: 'error', errorClass: 'vendor_rejected', ...base };
    }
    if (err instanceof IntegrationError)
      return { outcome: 'error', errorClass: 'integration_error', latencyMs };
    return { outcome: 'error', errorClass: 'adapter_exception', latencyMs };
  }

  private async withTimeout(
    adapter: VendorAdapter,
    view: ConnectionView,
    operation: string,
    args: Readonly<Record<string, unknown>>,
    token: string,
  ): Promise<VendorResult> {
    const ac = new AbortController();
    const ms = adapter.timeoutMs ?? this.d.defaultTimeoutMs ?? 10_000;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new TimeoutMarker()); // first, so the abort below cannot make the adapter's own rejection win the race
        ac.abort();
      }, ms);
    });
    try {
      return await Promise.race([
        adapter.call({
          operation: operation as never,
          args,
          connection: view,
          credentials: this.d.credentials(view.id),
          idempotencyToken: token,
          signal: ac.signal,
        }),
        timeout,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async safeFind(
    adapter: VendorAdapter,
    view: ConnectionView,
    operation: string,
    args: Readonly<Record<string, unknown>>,
    token: string,
  ): Promise<VendorResult | null> {
    try {
      return (
        (await adapter.find?.({
          operation,
          args,
          connection: view,
          credentials: this.d.credentials(view.id),
          idempotencyToken: token,
          signal: AbortSignal.timeout(adapter.timeoutMs ?? this.d.defaultTimeoutMs ?? 10_000),
        })) ?? null
      );
    } catch {
      return null; // the lookup is best effort; the repeat below is the fallback
    }
  }

  private async connection(
    kind: string,
  ): Promise<{ view: ConnectionView; enabled: boolean } | undefined> {
    const r = await this.d.db.withScope(systemScope(this.d.orgId), (tx) =>
      tx.query(
        'SELECT id, kind, vendor, settings, enabled FROM integration_core.connection WHERE kind = $1',
        [kind],
      ),
    );
    const row = r.rows[0];
    if (row === undefined) return undefined;
    return {
      enabled: row.enabled === true,
      view: {
        id: String(row.id),
        kind: String(row.kind),
        vendor: String(row.vendor),
        settings: Object.freeze({ ...(row.settings as Record<string, unknown>) }),
      },
    };
  }

  private static INSERT = `INSERT INTO integration_core.outbound_call
      (id, organisation_id, connection_id, operation, correlation_type, correlation_id, attempt, outcome, error_class, http_status, latency_ms, vendor_ref)
    VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid, $7, $8, $9, $10, $11, $12)`;

  private params(
    id: string,
    connectionId: string,
    operation: string,
    c: Correlation,
    attempt: number,
    a: Attempt | { outcome: 'pending' },
  ): unknown[] {
    const x = a as Attempt;
    return [
      id,
      this.d.orgId,
      connectionId,
      operation,
      c.type ?? null,
      c.id ?? null,
      attempt,
      a.outcome,
      x.errorClass ?? null,
      x.httpStatus ?? null,
      x.latencyMs === undefined ? null : Math.max(0, Math.round(x.latencyMs)),
      x.vendorRef ?? null,
    ];
  }

  /** `pending` row before a call to a vendor without an idempotency token. If it cannot be written the call does not go out. */
  private async recordPending(
    connectionId: string,
    operation: string,
    c: Correlation,
    attempt: number,
  ): Promise<string> {
    const id = uuidv7(this.now());
    await this.d.db.withScope(systemScope(this.d.orgId), (tx) =>
      tx.query(
        VendorGateway.INSERT,
        this.params(id, connectionId, operation, c, attempt, { outcome: 'pending' }),
      ),
    );
    return id;
  }

  private async finish(
    pendingId: string | undefined,
    connectionId: string,
    operation: string,
    c: Correlation,
    attempt: number,
    a: Attempt,
  ): Promise<void> {
    try {
      if (pendingId === undefined) {
        await this.record(connectionId, operation, c, attempt, a);
        return;
      }
      await this.d.db.withScope(systemScope(this.d.orgId), (tx) =>
        tx.query(
          `UPDATE integration_core.outbound_call SET outcome = $2, error_class = $3, http_status = $4, latency_ms = $5, vendor_ref = $6
           WHERE id = $1::uuid AND outcome = 'pending'`,
          [
            pendingId,
            a.outcome,
            a.errorClass ?? null,
            a.httpStatus ?? null,
            a.latencyMs === undefined ? null : Math.max(0, Math.round(a.latencyMs)),
            a.vendorRef ?? null,
          ],
        ),
      );
    } catch (err) {
      this.recordFailed(connectionId, operation, err);
    }
  }

  /** Insert one finished attempt. Never throws: the vendor call already happened, so a log failure is reported, not raised. */
  private async record(
    connectionId: string,
    operation: string,
    c: Correlation,
    attempt: number,
    a: Attempt,
  ): Promise<void> {
    try {
      await this.d.db.withScope(systemScope(this.d.orgId), (tx) =>
        tx.query(
          VendorGateway.INSERT,
          this.params(uuidv7(this.now()), connectionId, operation, c, attempt, a),
        ),
      );
    } catch (err) {
      this.recordFailed(connectionId, operation, err);
    }
  }

  private recordFailed(connectionId: string, operation: string, err: unknown): void {
    this.d.logger?.error('outbound call log write failed', {
      sqlstate: (err as { code?: unknown } | null)?.code,
      operation,
    });
    this.d.onRecordFailure?.({ connectionId, operation });
  }
}

class TimeoutMarker extends Error {}
