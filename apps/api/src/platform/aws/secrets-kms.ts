// API-tier secret store, payload sealer and inbound verification keys on Secrets Manager and KMS (AWS-BE-2). Selected by configuration;
// an absent group leaves the composition's refusing port, a partial one stops the start. The crypto lives in @ehr/kernel
// (KmsEnvelope, SecretsManagerStore) so the worker opens exactly what this tier seals.
import {
  AwsConfigError,
  awsSettings,
  createKmsClient,
  createSecretsManagerClient,
  KmsEnvelope,
  SECRETS_REPLICA_VARS,
  secretReplicaFromEnv,
  SecretsManagerStore,
  selectByEnv,
  type Env,
  type Logger,
} from '@ehr/kernel';
import type {
  InboundKeyProvider,
  OutboundSecretStore,
  PayloadSealer,
} from '../../modules/integration-core/index.js';

export const SECRETS_VARS = ['EHR_SECRETS_PREFIX'] as const;
export const PAYLOAD_KEY_VARS = ['EHR_KMS_PAYLOAD_KEY_ID'] as const;

export class SecretsManagerOutboundStore implements OutboundSecretStore {
  constructor(private readonly store: SecretsManagerStore) {}
  put(
    ref: { connectionId: string; name: string },
    value: string,
    clientToken: string,
  ): Promise<{ arn: string; versionId: string }> {
    return this.store.put(this.store.outboundName(ref.connectionId, ref.name), value, clientToken);
  }
}

/** Verification keys by source, current first then previous (rotation window). Read from the fixed name, never through secret_ref. */
export class SecretsManagerInboundKeys implements InboundKeyProvider {
  constructor(private readonly store: SecretsManagerStore) {}
  async keys(source: string): Promise<readonly { version: string; key: Buffer }[]> {
    const r = await this.store.currentAndPrevious(this.store.inboundName(source));
    return r.map((x) => ({ version: x.version, key: x.value }));
  }
}

export class KmsPayloadSealer implements PayloadSealer {
  constructor(private readonly envelope: KmsEnvelope) {}
  seal(plain: Buffer, context: string): Promise<Buffer> {
    return this.envelope.seal(plain, context);
  }
}

export interface ApiSecretPorts {
  secretStore?: OutboundSecretStore;
  inboundKeys?: InboundKeyProvider;
  sealer?: PayloadSealer;
}

export function selectApiSecretPorts(env: Env, log: Logger): ApiSecretPorts {
  const out: ApiSecretPorts = {};
  const replica = secretReplicaFromEnv(env, 'secret store (Secrets Manager)');
  // A replica without the store it belongs to is a half-configured group, not something to ignore.
  if (replica !== undefined && (env['EHR_SECRETS_PREFIX'] ?? '').trim() === '')
    throw new AwsConfigError(
      'secret store (Secrets Manager)',
      ['EHR_SECRETS_PREFIX'],
      [...SECRETS_REPLICA_VARS],
    );
  const store = selectByEnv({
    adapter: 'secret store (Secrets Manager)',
    env,
    vars: SECRETS_VARS,
    log,
    build: (v) =>
      new SecretsManagerStore(
        createSecretsManagerClient(awsSettings(env, 'secret store (Secrets Manager)')),
        v['EHR_SECRETS_PREFIX'] as string,
        (env['EHR_SECRETS_KMS_KEY_ID'] ?? '').trim() || undefined,
        replica,
        log,
      ),
  });
  if (store !== undefined) {
    out.secretStore = new SecretsManagerOutboundStore(store);
    out.inboundKeys = new SecretsManagerInboundKeys(store);
  }
  const sealer = selectByEnv({
    adapter: 'payload sealer (KMS)',
    env,
    vars: PAYLOAD_KEY_VARS,
    log,
    build: (v) =>
      new KmsPayloadSealer(
        new KmsEnvelope(createKmsClient(awsSettings(env, 'payload sealer (KMS)')), {
          keyId: v['EHR_KMS_PAYLOAD_KEY_ID'] as string,
        }),
      ),
  });
  if (sealer !== undefined) out.sealer = sealer;
  return out;
}
