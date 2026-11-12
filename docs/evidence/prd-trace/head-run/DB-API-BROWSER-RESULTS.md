# DB-backed, API and browser suites on dev head 60d962e (HEAAA-971)

Executor: QA Engineer agent, 2026-11-12. Code under test: `origin/dev` 60d962e (this branch adds only documentation on top). Node v24.22.2, pnpm 12.16.1, PostgreSQL 17.11 (rootless, trust auth, loopback port 55432, throwaway data directory), `pnpm install --frozen-lockfile` and `pnpm build` done. Synthetic data only. Raw logs were kept outside the repository (test names trip the secret scanner, RUN-GUIDE).

| Suite | Command | Result |
| --- | --- | --- |
| integration-db + N-1 | `scripts/ci/migration-check/integration-db.sh` | exit 0. db-foundation 120 tests, kernel 23, api 1082, worker 122 (1347 total), 0 failed, 0 skipped. N-1 against `r209` passed with 5 accepted **pin failures** (db-foundation 3, api 2: the candidate has 41 definers where r209 pinned 36, and adds `proxy_invite_code` and proxy columns). Pins are expected differences, not passes. |
| identity, authorization, security | `tests/api/identity/run.sh` | 63 tests, 48 pass, 0 fail, 15 skipped |
| platform | `node --test --test-concurrency=1 tests/api/platform/*.test.mjs` on the `tests/api/platform/lib` stack | 92 tests, 66 pass, 0 fail, 26 skipped |
| booking, calendar, notifications, clinical | `node --test --test-concurrency=1 tests/api/booking/*.test.mjs tests/api/clinical/*.test.mjs` on the `tests/e2e/journeys/lib` stack | 53 tests, 53 pass, 0 fail, 0 skipped |
| Staff accessibility smoke | `playwright test -c tests/e2e/smoke/playwright.config.ts --project=a11y`, `check-report.mjs ... 8` | 8 of 8 pass |
| Patient accessibility | `pnpm --filter @ehr/patient run test:a11y` | 3 pass |
| Site accessibility | `pnpm --filter @ehr/site run test:a11y` | 9 pass |
| packages/ui accessibility | `pnpm --filter @ehr/ui run test:a11y` | 26 pass |

Skipped cases are BLOCKED or not deliverable on `ENV-INT/ci` (no object store, video vendor, Google, mailbox, staging); each names its missing piece in the suite output and stays in section 6 of the matrix. A skip is never counted as a pass.

## Notes on the run
- First browser attempt (no fonts on the host): staff 4/8, patient 0/3, site 8/9 failed with headings "resolved but hidden". Cause is the environment (Chromium with no font at all renders no text); RUN-GUIDE section on fonts names this. With one `.ttf` listed in a `FONTCONFIG_FILE` all browser suites passed. Not a product defect.
- First attempts of the platform suites used the wrong stack for booking/clinical (those suites read `reports/qa04/stack.json`, the journeys stack) and the journeys stack needed `QA_PORT_OFFSET` because another process held port 9210. Harness usage, not product failures. The results above are from the correct stacks.
- Not run: SAST, secret scan, dependency audit, container scan, Schemathesis, Lighthouse (no hosted CI per owner ruling B; tools not installed), `tests/e2e/smoke/api-container.sh` and the `contract`/`e2e-smoke` jobs (no Docker), human-required cases.
