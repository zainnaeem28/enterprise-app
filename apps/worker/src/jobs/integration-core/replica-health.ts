// Recurring check that every runtime integration secret has its recovery-Region replica in sync (HEAAA-860, HEAAA-870 D-7).
// Replication is asynchronous, so a write-time error cannot be relied on; this looks at the state itself. Metadata only: it calls
// ListSecrets and DescribeSecret, never GetSecretValue, and it logs names, the Region and a status class, never StatusMessage or a value.
import {
  DescribeSecretCommand,
  ListSecretsCommand,
  type SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import type { Logger } from '@ehr/kernel';

export const REPLICA_GAUGE = 'SecretReplicaNotInSync';
/** How long a replica may stay `InProgress` after the last change before it counts as not in sync. */
export const REPLICA_GRACE_MS = 60 * 60 * 1000;

export interface ReplicaCheckDeps {
  sm: Pick<SecretsManagerClient, 'send'>;
  /** The environment name, the first path segment (`<env>/integration/...`). */
  prefix: string;
  replica: { region: string; kmsKeyId: string };
  log: Logger;
  now?: () => number;
}

/** `arn:...:key/<id>` and the bare `<id>` compare equal. */
const keyIdOf = (k: string): string => k.slice(k.lastIndexOf('/') + 1);

/** Counts the secrets under `<env>/integration/` whose replica is missing, failed, on the wrong key or stuck. A ListSecrets failure throws, so no gauge is emitted. */
export async function countUnhealthyReplicas(deps: ReplicaCheckDeps): Promise<number> {
  const now = (deps.now ?? Date.now)();
  const names: string[] = [];
  let token: string | undefined;
  do {
    const r = await deps.sm.send(
      new ListSecretsCommand({
        Filters: [{ Key: 'name', Values: [`${deps.prefix}/integration/`] }],
        ...(token === undefined ? {} : { NextToken: token }),
      }),
    );
    for (const s of r.SecretList ?? []) {
      if (s.DeletedDate !== undefined || s.Name === undefined) continue;
      names.push(s.Name);
    }
    token = r.NextToken;
  } while (token !== undefined);

  let bad = 0;
  for (const name of names) {
    let status: string;
    try {
      const d = await deps.sm.send(new DescribeSecretCommand({ SecretId: name }));
      if (d.DeletedDate !== undefined) continue;
      const entry = (d.ReplicationStatus ?? []).find((x) => x.Region === deps.replica.region);
      if (entry === undefined) status = 'Missing';
      else if (entry.Status === 'Failed') status = 'Failed';
      else if (
        entry.KmsKeyId === undefined ||
        keyIdOf(entry.KmsKeyId) !== keyIdOf(deps.replica.kmsKeyId)
      )
        status = 'WrongKey';
      else if (entry.Status === 'InProgress') {
        const changed = d.LastChangedDate?.getTime();
        status = changed !== undefined && now - changed <= REPLICA_GRACE_MS ? 'InSync' : 'Stuck';
      } else status = entry.Status === 'InSync' ? 'InSync' : 'Unknown';
    } catch {
      status = 'DescribeFailed';
    }
    if (status === 'InSync') continue;
    bad += 1;
    deps.log.warn('secret replica not in sync', {
      event: 'secret_replica_unhealthy',
      name,
      region: deps.replica.region,
      status,
    });
  }
  return bad;
}
