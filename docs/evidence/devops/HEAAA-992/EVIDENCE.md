# HEAAA-992 evidence: R5-F04 (N-1 pins, gitleaks dist/ allowlist R4-F02-a)

Author: DevOps Engineer. Not self-reviewed: needs DevOps Reviewer. Local runs only (no hosted CI, owner ruling B).

Base `origin/dev` = `eb2b191f9a23c78119cc6d261278af13d4e81afc` (tree `2f817d2bc3fb62f71ec2f78b84bc354f71e31b88`).
Config commit `58b18667795da0f7b4ea06c74b8ce9099330f041` changes only `gitleaks/gitleaks.toml` (+20 lines). Scans below ran on that commit's
tree (`097de615511ac220a855e9a6c24aefd8a4b8dacd`); the commit that adds this evidence changes only `docs/evidence/devops/HEAAA-992/`.
Tool: gitleaks 8.30.1 (pinned in `scripts/ci/tools.lock`, binary from the HEAAA-983 install).

## 1. gitleaks dist/ (R4-F02-a): RESOLVED by scoping the allowlist minimally

Cause (reproduced): `gitleaks dir` after a build reads the compiled copies `apps/worker/dist/aws/web-push.test.js` (RFC 8291 sample auth secret
`tBHItJI5svbpez7KI4CCXg`) and `apps/api/dist/src/platform/aws/s3-presigners.test.js` (counting-pattern S3 key `q/0123456789abcdef0123456789abcdef`).
Their sources are already allowed (F03-b, F03-c). dist/ is gitignored, so the full-history scan and a clean checkout never see them.

Fix: one new allowlist entry, `condition = "AND"`, rule `generic-api-key` only, those two exact compiled files, those two exact values. No `dist/` wildcard,
no rule disabled, no history rewrite.

Runs (the build was simulated by copying the two `.test.ts` files to the `dist/*.test.js` paths; they hold the same literals; a real `pnpm build` was not run
because this environment has no installed dependencies, so that part is NOT run):
- Before (config of eb2b191): `gitleaks-before.txt`: `leaks found: 2`, exit 1.
- After: `gitleaks-after.txt`: `scripts/ci/secrets.sh` full history (706 commits) no leaks; working tree no leaks; exit 0.
- Negative control (run in the original worktree, output quoted, not saved as a file): appending a different key-shaped value to the dist web-push copy is still reported by the dir scan.

## 2. N-1 pins: KEPT; basis recorded; gate-owner acceptance NOT yet recorded

Removal is not possible on this head. The five pins in `scripts/ci/migration-check/n-minus-1-pins.tsv` are failures of the previous release r209's own tests
when run against the candidate schema: 3 assert the literal definer-catalog size 36 (candidate 41, HEAAA-789) and 2 assert exact identity table/column lists
(candidate adds `proxy_invite_code` and 4 `proxy_grant` columns, HEAAA-791). Both are purely additive, expand-only schema growth, which is what N-1 compatibility allows
(DEVOPS-PLAN 5.2: expand-only, N-1 app runs against schema N). Removing them needs either editing the r209 tests (not allowed: they are the previous release) or a new baseline
tag past HEAAA-791 (a release decision, not mine to make). The harness limits what can be pinned: `check-junit.mjs` accepts only the exact recorded assertion
(strictEqual with the literal, or deepStrictEqual whose actual is the expected list plus exactly the named additions, GROWTH_ALLOWED), and fails on a stale pin,
a skip, a missing report or any other failure. Decisions: HEAAA-739 Q1(d), HEAAA-914, reviewed in HEAAA-739/914/908. HEAAA-983 (DevOps Reviewer PASS, HEAAA-985) ran it: `PASS WITH PINS`, not a clean pass.

Acceptance basis offered for the gate owner to record (I cannot record it for them): keep the 5 pins until the next baseline tag; expiry = when the baseline tag advances past HEAAA-791
(the harness then fails the stale pins, forcing removal). Open item: the gate owner (agent) records ACCEPT or REMOVE in the gate decision-log; N-1 stays "PASS WITH PINS" in the acceptance package until then.
