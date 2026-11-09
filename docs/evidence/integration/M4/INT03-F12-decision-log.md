# INT03-F12 decision-log: gitleaks allowlist (Cybersecurity)

Question: 115 findings (r5 count; 116 full / 110 main..HEAD when re-run on a6d2b44, the extra one being the r5 result note quoting `Stripe-style live-key prefix + SUPERSECRET marker`). True secrets or test fixtures?
Method: gitleaks 8.30.1 re-run un-redacted locally; every finding's file, line and value inspected (list: `raw/r6/triage-before.tsv`, 116 rows). Values never copied into evidence beyond synthetic literals.

| Class | Count (main..HEAD) | Files | Verdict |
|---|---|---|---|
| Deterministic test keys (`csrf/rate/cursor/qr/decoy-key-for-tests-0123…`, `csecret-0123456789`, `RT-0123456789`, `tok-12345678`, `test-secret-0123456789`, uuid `0192abcd-…-0123456789ab`) | 22 | test/testkit/dbtest files | Synthetic: sequential digits, "for-tests" names, injected into test fixtures; no real service |
| Random-looking check-in QR tokens (`q7Zk…`, `A1b2…`) | 2 | preconsult.spec.ts, desk.test.tsx | Synthetic: mocked network replies in UI tests |
| Notification template identifiers `appointment_reminder_48h/4h` | 4 source + 82 in M3 journey log | r1-templates.ts, notifications dbtests, M3 r12 journey-run.txt | Not secrets: public template names matched by `key:` heuristic |
| `Stripe-style live-key prefix + SUPERSECRET marker` | 2 | call-vendor.test.ts, M4 r5 result note | Fake marker proving error redaction; not a Stripe token (invalid form) |
| Older history (in main, not main..HEAD) | 6 | terraform plan tests (`0123456789abcdef…` placeholder origin-verify value), identity/admin testkit decoy key, M3 r11 journey log (template names), docker image sha256 digest in foundation versions note | Synthetic / public hash |

Result: 0 true secrets. No rotation needed. Nothing allowlisted blindly.

Decision: allowlists in `gitleaks/gitleaks.toml` (F12-a..f), each `condition = "AND"` of exact file path(s) plus an anchored regex for the exact synthetic value and a targetRules restriction. No directory wildcards over source; F12-f covers gitignored `dist/` build copies only with the same exact values (they only appear in a locally built tree). Follows the config's own rule (owner, reason, scope).

Evidence (raw/r6): after-change full history, main..HEAD and working tree all "no leaks found" (exit 0). Before: 116 / 110. Negative control: a differently valued `CSRF_KEY` in the same allowlisted path and the same synthetic `RATE_KEY` in a non-listed path both still fail (2 findings). Remaining: 0. Allowlisted: 116 history (110 range) + dist copies.

Review: Security Reviewer to confirm.
