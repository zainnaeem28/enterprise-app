# INT04-F36 decision log (secrets.sh full-history, r11 raw logs)

- Date: 2026-11-09. Owner: DevOps Engineer. Reviewers required: DevOps Reviewer, Security Reviewer.
- Finding: `scripts/ci/secrets.sh` full history reports 130 `generic-api-key` hits, all in commit f59c330, all in
  `docs/evidence/integration/M5/r11/gates/integration-db-run1..4.txt` (30 each) and `r11/prepare-db{,2..6}.txt`
  (2 each in five files). Triage: every hit has the same secret value, the migration file name
  `2406_notifications_staff_scope_allows_patient.sql` (public repo file, no credential). Product code is clean.
- Options: (a) replace raw logs with summaries: does not clear history hits (rewrite not allowed), the scan still fails;
  (b) broad allowlist for `docs/evidence/**`: weakens scanning, rejected; (c) narrow allowlist, exact files AND exact
  value AND rule generic-api-key (same pattern as INT04-F18/F33).
- Choice: (c). Entry "INT04-F36" appended to `gitleaks/gitleaks.toml`. Reversible, no expiry (frozen evidence).
- Verification (gitleaks 8.30.1, `scripts/ci/secrets.sh`, full history + tree): before 130 findings; after 0 findings, exit 0.
  Scan scope for non-evidence paths and other values is unchanged.
