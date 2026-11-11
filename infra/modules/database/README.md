# database module

RDS for PostgreSQL 17: Multi-AZ (production), private data subnets, SSE-KMS, 35-day point-in-time recovery, cross-Region automated backup replication, and an AWS Backup plan (daily 35 days, monthly 12 months; owner ruling C item 2 †, counsel confirmation pending, `infra/RETENTION.md`) that copies into the vault-locked vaults of the log-archive account (`archive` module outputs). DEVOPS-PLAN 3.2, 5.2, 8, 10.1; ARCHITECTURE 9.3, 9.4.

Authored only. Nothing here has been applied.

## Master user (M-1)

`manage_master_user_password = true`: RDS creates and rotates the password in Secrets Manager. The module exports **no** master credential or secret reference, no `password` argument exists, and application roles are created by the F-03 roles bootstrap with their own credentials. Task definitions must never reference the master secret (DEVOPS-PLAN 5.2 secret-reference lint).

## transaction_timeout (C-01, Unverified)

The parameter group declares `transaction_timeout` (instance default, `var.transaction_timeout_ms`, 0 = no instance-wide limit so migrations and backfills are not cut off). The 60 s bound is **role level** on `app_api`, `app_worker` and `audit_archiver`; the expected values are the `role_level_settings` output and are applied by the F-03 roles bootstrap. That RDS PostgreSQL 17 exposes the parameter and that role-level values are readable from the audit insert trigger is **not verified**: run `verification/transaction_timeout_probe.sql` on a real staging instance. If it fails, the Solution Architect decides the fallback; the check is not weakened.

## Checks

`tofu fmt -check`, `tofu validate`, `tflint`, `tofu test` (mock provider), `trivy config`. See HEAAA-99 evidence.
