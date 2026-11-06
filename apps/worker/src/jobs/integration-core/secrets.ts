// Secret access for adapters and the apply job (BD-11, ARCHITECTURE 9.1). The secret store itself (Secrets Manager,
// planning name) is infrastructure; this file defines the narrow interfaces the code needs and the in-memory cache.
// Values live only in process memory, for at most 5 minutes, and are never logged, returned in an error, or stored.
import { createHash } from 'node:crypto';
import type { KernelDb } from '@ehr/kernel';
import type { CredentialReader } from './adapters.js';
import { IntegrationError } from './errors.js';
import { systemScope } from './scope.js';

export const SECRET_CACHE_MS = 5 * 60_000;

/** Reads a secret version from the store. The worker role may read both classes (9.1). */
export interface SecretReader {
  get(arn: string, versionId: string): Promise<string>;
}

/**
 * Writes a new version of an `inbound_verification` secret. Only the worker role has this right (SC-2). `clientToken`
 * makes the write idempotent: a retry with the same token returns the same version and writes no second one.
 */
export interface InboundSecretWriter {
  put(
    name: string,
    value: string,
    clientToken: string,
  ): Promise<{ arn: string; versionId: string }>;
}

/**
 * Opens a payload the API sealed for the worker (SC-3, DF-4: KMS Decrypt for the worker role only; the encryption context
 * binds the ciphertext: `inbound:<source>\n<event id>` for webhook bodies, `secret_change:<request id>` for entered secrets).
 * A wrong context must fail.
 */
export interface PayloadOpener {
  open(sealed: Buffer, context: string): Promise<Buffer>;
}

class SecretValue {
  constructor(
    readonly value: string,
    readonly expiresAt: number,
  ) {}
  // Never serialised or inspected by accident.
  toJSON(): string {
    return '[redacted]';
  }
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '[redacted]';
  }
}

export class SecretCache {
  private readonly cache = new Map<string, SecretValue>();

  constructor(
    private readonly reader: SecretReader,
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = SECRET_CACHE_MS,
  ) {
    if (ttlMs > SECRET_CACHE_MS) throw new Error('secret cache TTL is capped at 5 minutes (9.1)');
  }

  async get(arn: string, versionId: string): Promise<string> {
    const key = createHash('sha256').update(`${arn}\u0000${versionId}`).digest('hex');
    const hit = this.cache.get(key);
    if (hit !== undefined && hit.expiresAt > this.now()) return hit.value;
    const value = await this.reader.get(arn, versionId);
    this.cache.set(key, new SecretValue(value, this.now() + this.ttlMs));
    return value;
  }

  /** Disabling a connection clears its cached values at once (SC-8). */
  clear(): void {
    this.cache.clear();
  }
}

/**
 * Credentials of one connection, resolved through `secret_ref` (name -> ARN + current version) at the time of use, so a
 * rotation takes effect within the cache bound.
 */
export function credentialReaderFor(
  db: KernelDb,
  orgId: string,
  connectionId: string,
  cache: SecretCache,
): CredentialReader {
  return {
    async get(secretName: string): Promise<string> {
      const ref = await db.withScope(systemScope(orgId), async (tx) => {
        const r = await tx.query(
          'SELECT secret_arn, current_version_id FROM integration_core.secret_ref WHERE connection_id = $1::uuid AND name = $2',
          [connectionId, secretName],
        );
        return r.rows[0];
      });
      if (ref === undefined) throw new IntegrationError('integration.secret_missing', 503, true);
      return cache.get(String(ref.secret_arn), String(ref.current_version_id));
    },
  };
}
