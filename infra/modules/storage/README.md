# storage module

Document buckets for one environment: `<prefix>-docs-quarantine` (uploads awaiting scan, expired after 7 days, **not replicated**) and `<prefix>-docs-clean` (scan-passed, versioned, noncurrent versions kept 90 days, written only by the promotion role, replicated to the recovery Region with Replication Time Control, 15 minutes). SSE-KMS, public access blocked, TLS-only, ACLs disabled. DEVOPS-PLAN 3.2, 10.1; ARCHITECTURE 9.4.

Authored only. Nothing here has been applied. Needs a multi-Region primary key (`kms` module `multi_region = true`) and its recovery-Region replica key.
