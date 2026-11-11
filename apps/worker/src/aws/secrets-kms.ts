// The worker's secret store reader/writer, payload opener and calendar channel key on Secrets Manager and KMS (AWS-BE-2). The worker
// role may read both secret classes and is the only writer of `inbound` secrets (SC-2); it alone may KMS-Decrypt what the API sealed (SC-3).
// Selected by configuration like every AWS adapter: absent -> the refusing port stays, partial -> startup fails.
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
  InboundSecretWriter,
  PayloadOpener,
  SecretReader,
} from '../jobs/integration-core/secrets.js';
import type { ReplicaCheckDeps } from '../jobs/integration-core/replica-health.js';
import type { ChannelKeyProvider } from '../jobs/calendar-sync/ports.js';

export const SECRETS_VARS = ['EHR_SECRETS_PREFIX'] as const;
export const PAYLOAD_KEY_VARS = ['EHR_KMS_PAYLOAD_KEY_ID'] as const;
export const CHANNEL_KEY_SECRET = 'google-calendar-channel-key';

export class SecretsManagerReader implements SecretReader {
  constructor(private readonly store: SecretsManagerStore) {}
  get(arn: string, versionId: string): Promise<string> {
    return this.store.get(arn, versionId);
  }
}

export class SecretsManagerInboundWriter implements InboundSecretWriter {
  constructor(private readonly store: SecretsManagerStore) {}
  put(
    name: string,
    value: string,
    clientToken: string,
  ): Promise<{ arn: string; versionId: string }> {
    return this.store.put(this.store.inboundName(name), value, clientToken);
  }
}

export class SecretsManagerChannelKey implements ChannelKeyProvider {
  constructor(private readonly store: SecretsManagerStore) {}
  async current(): Promise<{ version: string; key: Buffer }> {
    const [cur] = await this.store.currentAndPrevious(this.store.inboundName(CHANNEL_KEY_SECRET));
    if (cur === undefined) throw new Error('port not configured: calendar_channel_key');
    return { version: cur.version, key: cur.value };
  }
}

export class KmsPayloadOpener implements PayloadOpener {
  constructor(private readonly envelope: KmsEnvelope) {}
  open(sealed: Buffer, context: string): Promise<Buffer> {
    return this.envelope.open(sealed, context);
  }
}

export interface SecretsWorkerInfra {
  secretReader?: SecretReader;
  secretWriter?: InboundSecretWriter;
  channelKeys?: ChannelKeyProvider;
  payloadOpener?: PayloadOpener;
  /** Present only with the recovery-Region replica configured: the recurring check that every runtime secret's replica is in sync. */
  replicaCheck?: ReplicaCheckDeps;
}

export function selectSecretsWorkerInfra(env: Env, log: Logger): SecretsWorkerInfra {
  const out: SecretsWorkerInfra = {};
  const replica = secretReplicaFromEnv(env, 'secret store (Secrets Manager)');
  // A replica without the store it belongs to is a half-configured group, not something to ignore.
  if (replica !== undefined && (env['EHR_SECRETS_PREFIX'] ?? '').trim() === '')
    throw new AwsConfigError(
      'secret store (Secrets Manager)',
      ['EHR_SECRETS_PREFIX'],
      [...SECRETS_REPLICA_VARS],
    );
  let check: ReplicaCheckDeps | undefined;
  const store = selectByEnv({
    adapter: 'secret store (Secrets Manager)',
    env,
    vars: SECRETS_VARS,
    log,
    build: (v) => {
      const sm = createSecretsManagerClient(awsSettings(env, 'secret store (Secrets Manager)'));
      if (replica !== undefined)
        check = { sm, prefix: v['EHR_SECRETS_PREFIX'] as string, replica, log };
      return new SecretsManagerStore(
        sm,
        v['EHR_SECRETS_PREFIX'] as string,
        (env['EHR_SECRETS_KMS_KEY_ID'] ?? '').trim() || undefined,
        replica,
        log,
      );
    },
  });
  if (store !== undefined) {
    out.secretReader = new SecretsManagerReader(store);
    out.secretWriter = new SecretsManagerInboundWriter(store);
    out.channelKeys = new SecretsManagerChannelKey(store);
    if (check !== undefined) out.replicaCheck = check;
  }
  const opener = selectByEnv({
    adapter: 'payload opener (KMS)',
    env,
    vars: PAYLOAD_KEY_VARS,
    log,
    build: (v) => {
      const previous = (env['EHR_KMS_PAYLOAD_PREVIOUS_KEY_IDS'] ?? '')
        .split(',')
        .map((x) => x.trim())
        .filter((x) => x !== '');
      return new KmsPayloadOpener(
        new KmsEnvelope(createKmsClient(awsSettings(env, 'payload opener (KMS)')), {
          keyId: v['EHR_KMS_PAYLOAD_KEY_ID'] as string,
          previousKeyIds: previous,
        }),
      );
    },
  });
  if (opener !== undefined) out.payloadOpener = opener;
  return out;
}
