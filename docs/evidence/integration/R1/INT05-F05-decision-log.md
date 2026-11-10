# INT05-F05 decision log: gitleaks full-history generic-api-key hits (15)

Candidate: e6871fa. Tool: gitleaks 8.30.1, rule generic-api-key.

## Triage (none is a real secret; no rotation needed)

| # | File:line | Commit | Matched value | Verdict |
|---|-----------|--------|---------------|---------|
| 1 | scripts/bootstrap/test/aws-result.test.mjs:110 | 1836e0ae | `other-AbC123` | Tail of a fake ARN in a test fixture. False positive. |
| 2-5 | tests/api/platform/admin.test.mjs | e8378fdd | `qa05_probe_flag`, `qa05_probe_flag2` | Feature-flag names used as probes. False positive. |
| 6-15 | docs/evidence/integration/M5/sec05-reread/*.txt (5 files, 2 hits each, line 105) | 8cb02eb5 | `2406_notifications_staff_scope_allows_patient.sql` | A migration file name in evidence text. Same false positive as INT04-F18/F33/F36. |

## Decisions

1. History cannot be rewritten, so the history hits are allowlisted in `gitleaks/gitleaks.toml` as INT05-F05-a/b/c. Each entry uses condition AND, rule generic-api-key, the exact file and the exact value. Entries a and b are also pinned to the commit SHA. Entry c is pinned by file and value only, because `gitleaks dir` ignores commit pins. There is no broad rule and no blanket path allowlist.
2. The fixture in the current tree (aws-result.test.mjs) was renamed to `other-name`, so it is no longer key-shaped. Future fixtures should avoid key-shaped strings.

## Results

- `node --test scripts/bootstrap/test/aws-result.test.mjs`: 9 pass.
- `gitleaks git --log-opts e6871fa` exits 0. `gitleaks dir` exits 0.
- An all-refs scan still shows 2 hits for `0123456789abcdef0123456789abcdef0123` in infra from other unmerged branches (9a0625c2, 15c52ddd). These are out of scope and belong to those branches.
