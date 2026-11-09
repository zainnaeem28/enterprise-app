# archive module (log-archive account)

- `<prefix>-audit-archive`: S3 Object Lock, **compliance mode** default retention, versioned, SSE-KMS. The bucket policy denies `DeleteObject*`, retention changes, lifecycle changes and bucket deletion to every principal with no exception, so production roles cannot delete from the archive; writers (named roles inside the organisation) get `PutObject` and list only.
- `<prefix>-audit-archive-replica` in the recovery Region with Object Lock also on, fed by S3 replication with RTC; lock settings replicate with the objects (ARCHITECTURE 9.4).
- AWS Backup vaults (primary and recovery Region) with a vault lock and a policy that accepts copies only from inside the organisation and denies deletion of recovery points (DEVOPS-PLAN 10.1, SEC-D-17).

`retention_days` has **no default**: the retention period is the longest legal minimum (NFR-13, open for counsel). A compliance-mode period cannot be shortened later, so the value must be decided before anything is applied. Likewise the backup vault lock becomes immutable after `vault_lock_changeable_for_days`.

Authored only. Nothing here has been applied.
