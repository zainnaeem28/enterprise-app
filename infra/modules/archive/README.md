# archive module (log-archive account)

- `<prefix>-audit-archive`: S3 Object Lock, **compliance mode** default retention, versioned, SSE-KMS. The bucket policy denies `DeleteObject*`, retention changes, lifecycle changes and bucket deletion to every principal with no exception, so production roles cannot delete from the archive; writers (named roles inside the organisation) get `PutObject` on their own prefix only (`writer_principal_arns` → `partitions/*`, `anchor_writer_principal_arns` → `anchors/*`), with prefix-conditioned listing; `anchor_reader_principal_arns` read and list versions under `anchors/*`. The KMS grant for these roles belongs in the log-archive key policy (not part of this module).
- `<prefix>-audit-archive-replica` in the recovery Region with Object Lock also on, fed by S3 replication with RTC; lock settings replicate with the objects (ARCHITECTURE 9.4).
- AWS Backup vaults (primary and recovery Region) with a vault lock and a policy that accepts copies only from inside the organisation and denies deletion of recovery points (DEVOPS-PLAN 10.1, SEC-D-17).

`retention_days` has **no default**: the retention period is the longest legal minimum (NFR-13, open for counsel). A compliance-mode period cannot be shortened later, so the value must be decided before anything is applied. Likewise the backup vault lock becomes immutable after `vault_lock_changeable_for_days`.

Authored only. Nothing here has been applied.

## Immutability, repair and destroy (DO02-R1-01, -02, -05)

- The bucket policies deny `PutBucketObjectLockConfiguration`, `PutLifecycleConfiguration` and `DeleteBucketPolicy` to every principal, including the deploying role. They therefore depend on every other bucket setting (versioning, Object Lock, SSE, ownership, public-access block) and are created last. Those settings and the policy are **intentionally immutable after the first apply**; a change needs a new bucket and a data migration, not an in-place apply.
- Backup vault policies deny only `DeleteRecoveryPoint` and `UpdateRecoveryPointLifecycle`. They do **not** deny policy changes or vault deletion: the vault lock is the immutability control, so a wrong policy stays repairable and a throwaway environment can be destroyed once its recovery points have expired. Decision recorded here for review. A vault with unexpired recovery points cannot be destroyed; Object Lock buckets with retained objects cannot be destroyed either.
- Writers must send `x-amz-server-side-encryption: aws:kms`; the policy uses `StringNotEqualsIfExists`, so a request that omits the header is denied.
- `vault_min_retention_days` / `vault_max_retention_days` must match the database module's `copy_vault_min_retention_days` / `copy_vault_max_retention_days`; the database plan checks its retention against them before apply.
