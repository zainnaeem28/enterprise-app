# INT04-F07 decision-log: gitleaks allowlist for the synthetic PHI canary

Question: gitleaks rule `jwt` flags `infra/modules/observability/tests/phi-canaries.json:11` (commit `0bf3894`). Allowlist it, or reshape the canary?
Owner: DevOps Engineer (Cybersecurity input on wording; Security Reviewer to confirm).

Options:
1. Change the canary so it is not JWT-shaped. Rejected: the fixture exists to prove a JWT-shaped value never reaches telemetry (`apps/api/src/telemetry/telemetry.test.ts` and the observability module tests); a non-JWT value would stop testing that shape. History would still hold the old value, so the finding stays on `0bf3894` unless history is rewritten (not allowed).
2. Narrow allowlist (chosen). `gitleaks/gitleaks.toml`, `condition = "AND"`: rule `jwt` only, exact file path, anchored regex for the exact synthetic value. It covers the commit and the tree, so no history rewrite.

Value assessment: header `{"alg":"none"}`, payload `{"sub":"CANARY"}`, signature `CANARYSIGNATURE01`. Unsigned, not issued by any system, no real credential. No rotation needed.

Scanning is not weakened: no other rule, file or value is excluded.

Evidence (gitleaks 8.30.1, checksum from `scripts/ci/tools.lock`):
- Before, full history of this branch: 6 findings (the jwt one plus 5 `generic-api-key` in `tests/api/booking/*`, which belong to branch HEAAA-140 refs and are out of scope).
- After: the jwt finding is gone; the 5 HEAAA-140 findings remain, unchanged.
- Working tree (`gitleaks dir`): no leaks found.
- Negative control: a different JWT in the same file path, and the canary value in a different path, both still fail (2 findings).
