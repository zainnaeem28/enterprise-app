# Checks executed on dev head 60d962e (HEAAA-955)

Executor: QA Engineer agent. Local Linux server, Node v24.22.2, pnpm 12.16.1, clean worktree of `origin/dev` 60d962e469d4856a8fd16704416962f350b50354 (fast-forwarded; no code changed by this task). 2026-11-12.

| Command | Result |
| --- | --- |
| pnpm install --frozen-lockfile | pass |
| pnpm build | pass |
| pnpm lint | exit 0; 0 errors, 30 warnings |
| pnpm format:check | exit 0 |
| pnpm typecheck | exit 0 |
| pnpm test:boundary | exit 0 |
| node scripts/ci/run-unit.mjs | exit 0; 1678 tests in 10 reports, none skipped or failed (api 366, app-shell 89, cms 92, kernel 170, patient 211, site 76, staff 298, ui 175, worker 200, boundary 1) |

Per-file unit counts: unit-by-file.csv (derived from reports/unit/junit, which is generated and not committed).

Not run, and why: integration-db / N-1 and tests/api/** and browser suites need a throwaway PostgreSQL 17 and build output; the host disk was 100% full (65 MB free) so they were not started. SAST, secret scan, dependency audit, container scan, Schemathesis, Lighthouse: no hosted CI (owner ruling B) and the tools are not installed in this environment. None of these is recorded as a pass.
