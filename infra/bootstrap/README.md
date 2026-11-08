# State backend bootstrap (authored only, nothing applied)

Creates, in the `tooling` account: the Terraform state bucket (versioned, SSE-KMS with a
dedicated key, TLS-only, organisation-only, no public access, noncurrent versions kept 365 days),
a recovery-Region replica bucket and key, and the replication role. Locking uses the S3 native
lock file (`use_lockfile`, OpenTofu >= 1.10); there is no DynamoDB table.

Chicken-and-egg: first apply uses local state, run by a human assuming the `platform-admin-apply`
role in the `tooling` account (the bucket policy denies administration to every other principal,
so no other role can complete it; the policy resource is ordered last). Then
`tofu init -migrate-state` with a backend block pointing at the new bucket. Bootstrap order is in
`../accounts/README.md` ("Bootstrap order"). The replica bucket has the same TLS-only and
organisation-only policy and the same noncurrent-version lifecycle. The replica KMS key keeps the
module key policy (account root plus the listed principals and the replication role); it is not
otherwise restricted. There is no S3 Object Lock; versioning plus the administration deny is the protection. Bucket
administration is denied to everyone except `platform-admin-apply`. The approvals root has its
own bucket and key (DEVOPS-PLAN 7.5) and is not created here.
