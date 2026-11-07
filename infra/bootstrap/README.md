# State backend bootstrap (authored only, nothing applied)

Creates, in the `tooling` account: the Terraform state bucket (versioned, SSE-KMS with a
dedicated key, TLS-only, organisation-only, no public access, noncurrent versions kept 365 days),
a recovery-Region replica bucket and key, and the replication role. Locking uses the S3 native
lock file (`use_lockfile`, OpenTofu >= 1.10); there is no DynamoDB table.

Chicken-and-egg: first apply uses local state by a human with the tooling-account admin role, then
`tofu init -migrate-state` with a backend block pointing at the new bucket. Bucket
administration is denied to everyone except `platform-admin-apply`. The approvals root has its
own bucket and key (DEVOPS-PLAN 7.5) and is not created here.
