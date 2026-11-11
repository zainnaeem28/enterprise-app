# Retention values (owner ruling C item 2, 2026-11-11)

Conservative product defaults delegated by the owner (HEAAA-33 ruling C). **Not legal or clinical advice.**
† Counsel must confirm every value before go-live. Each value is a variable, so a later answer is a settings change plus a test rerun.

| Data | Value | Where it is set | Variable (default) |
| --- | --- | --- | --- |
| Medical record | 10 years after the last encounter | **Application level, not a bucket rule.** Application setting `document_retention_years` (documents) and the C-BE-DEL retention settings; no IaC resource enforces it. Buckets hold noncurrent versions only (`storage` `noncurrent_version_days`). | n/a |
| Audit trail and anchors | 7 years | `archive` module Object Lock (COMPLIANCE) for both archives; `accounts/log-archive` | `archive.retention_days` / `archive_retention_days` (2557, COMPLIANCE rejects less) |
| HIPAA documentation | 6 years | Covered by the 7-year Object Lock above (no separate shorter lock) | n/a |
| Database backups, daily | 35 days | `database` module (PITR and AWS Backup daily copy) | `backup_retention_days` (35; 7 to 35) |
| Database backups, monthly | 12 months | `database` module AWS Backup monthly copy | `monthly_retention_days` (365; at least 365) |
| Application logs | 90 days in CloudWatch, then archive 1 year | `compute`, `observability`, `dr/restore-boundary` log groups | `log_retention_days` (90; at least 90), `findings_retention_days` (90) |
| Network flow logs | 1 year | `accounts/log-archive` flow-log bucket lifecycle | `retention_days` (365; at least 365) |
| Privacy export packages | 7 days | `aws-adapters` packages bucket lifecycle | `package_expiry_days` (7) |

Not covered by the ruling and unchanged: audit export copies (`export_expiry_days`, 90), quarantine (7 days), noncurrent document versions (90 days).

Names align with the application settings `audit_retention_years` and `document_retention_years` found in the repository; the C-BE-DEL module README was not yet published when this was written, so a mismatch there is a rename here.

**Gap (reported, not built):** the 1-year archive stage for application logs (after the 90 days) has no resource in `infra/` yet; it needs a log export or subscription destination and is a new resource to approve.

Throwaway environments (staging anchor archive, GOVERNANCE mode, 1 day) are allowed to use less than the 7-year floor; production uses COMPLIANCE and the floor applies.
