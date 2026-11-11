// Secrets Manager access shared by the API and the worker (AWS-BE-2; ARCHITECTURE 9.1, SC-2). Secrets are versioned: a write always
// creates a new version, a read names one. A secret VALUE is never logged and never put in an error; errors carry the secret NAME and
// the failure class only. Names are built here from a validated prefix and path parts, so a caller cannot choose another prefix.
import { createHash } from 'node:crypto';
import {
  CreateSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  type SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

const PART = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const PREFIX = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const MAX_VALUE = 64 * 1024;

const nameOf = (e: unknown): string => (e as { name?: string } | null)?.name ?? '';

/** A secret operation failed. Names the secret path and the class of failure, never a value. */
export class SecretStoreError extends Error {
  constructor(
    readonly secretName: string,
    readonly cause_: string,
  ) {
    super(`secret store: ${cause_} (${secretName})`);
    this.name = 'SecretStoreError';
  }
}

export interface SecretVersion {
  arn: string;
  versionId: string;
}

export class SecretsManagerStore {
  constructor(
    private readonly sm: Pick<SecretsManagerClient, 'send'>,
    /** The environment name, the first path segment (`<env>/integration/...`). */
    readonly prefix: string,
    private readonly kmsKeyId?: string,
  ) {
    if (!PREFIX.test(prefix)) throw new Error('secrets prefix must be a plain name');
  }

  /** `<env>/integration/outbound/<connectionId>/<name>` */
  outboundName(connectionId: string, name: string): string {
    return this.path('outbound', connectionId, name);
  }

  /** `<env>/integration/inbound/<name>` */
  inboundName(name: string): string {
    return this.path('inbound', name);
  }

  private path(cls: string, ...parts: string[]): string {
    for (const p of parts) if (!PART.test(p)) throw new Error('secret path part refused');
    return [this.prefix, 'integration', cls, ...parts].join('/');
  }

  /**
   * Writes a new version. Idempotent: `clientToken` (hashed to the 64 hex characters Secrets Manager wants, scoped to the secret name)
   * makes a retry return the same version. The secret is created on first use.
   */
  async put(secretName: string, value: string, clientToken: string): Promise<SecretVersion> {
    if (value.length === 0 || Buffer.byteLength(value, 'utf8') > MAX_VALUE)
      throw new SecretStoreError(secretName, 'value size refused');
    const token = createHash('sha256').update(`${secretName}\u0000${clientToken}`).digest('hex');
    const put = async (): Promise<SecretVersion> => {
      const r = await this.sm.send(
        new PutSecretValueCommand({
          SecretId: secretName,
          SecretString: value,
          ClientRequestToken: token,
        }),
      );
      return this.versioned(secretName, r.ARN, r.VersionId);
    };
    try {
      return await put();
    } catch (e) {
      if (nameOf(e) !== 'ResourceNotFoundException') throw this.fail(secretName, e);
    }
    try {
      const r = await this.sm.send(
        new CreateSecretCommand({
          Name: secretName,
          SecretString: value,
          ClientRequestToken: token,
          ...(this.kmsKeyId === undefined ? {} : { KmsKeyId: this.kmsKeyId }),
        }),
      );
      return this.versioned(secretName, r.ARN, r.VersionId);
    } catch (e) {
      if (nameOf(e) !== 'ResourceExistsException') throw this.fail(secretName, e);
    }
    try {
      return await put(); // lost a creation race
    } catch (e) {
      throw this.fail(secretName, e);
    }
  }

  /** Reads one version by ARN (the worker role's right on both secret classes). */
  async get(arn: string, versionId: string): Promise<string> {
    try {
      const r = await this.sm.send(
        new GetSecretValueCommand({ SecretId: arn, VersionId: versionId }),
      );
      return this.valueOf(arn, r.SecretString, r.SecretBinary);
    } catch (e) {
      throw e instanceof SecretStoreError ? e : this.fail(arn, e);
    }
  }

  /** The current and (when present) previous version of a named secret, current first. A missing previous version is normal. */
  async currentAndPrevious(
    secretName: string,
  ): Promise<readonly { version: string; value: Buffer }[]> {
    const out: { version: string; value: Buffer }[] = [];
    for (const stage of ['AWSCURRENT', 'AWSPREVIOUS'] as const) {
      try {
        const r = await this.sm.send(
          new GetSecretValueCommand({ SecretId: secretName, VersionStage: stage }),
        );
        if (r.VersionId === undefined) throw new SecretStoreError(secretName, 'no version id');
        out.push({
          version: r.VersionId,
          value: Buffer.from(this.valueOf(secretName, r.SecretString, r.SecretBinary), 'utf8'),
        });
      } catch (e) {
        if (stage === 'AWSPREVIOUS' && nameOf(e) === 'ResourceNotFoundException') continue;
        throw e instanceof SecretStoreError ? e : this.fail(secretName, e);
      }
    }
    return out;
  }

  private valueOf(name: string, str: string | undefined, bin: Uint8Array | undefined): string {
    if (str !== undefined) return str;
    if (bin !== undefined) return Buffer.from(bin).toString('utf8');
    throw new SecretStoreError(name, 'secret has no value');
  }

  private versioned(name: string, arn?: string, versionId?: string): SecretVersion {
    if (arn === undefined || versionId === undefined)
      throw new SecretStoreError(name, 'incomplete response');
    return { arn, versionId };
  }

  private fail(name: string, e: unknown): SecretStoreError {
    return new SecretStoreError(name, nameOf(e) === '' ? 'request failed' : nameOf(e));
  }
}
