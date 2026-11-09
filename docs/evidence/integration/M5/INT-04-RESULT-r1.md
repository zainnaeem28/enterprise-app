# INT-04 integration round 1 (M5 administration and controls)

Candidate: `8195772` (`raw/int04-r1/gates/candidate-commit.txt`), tested in a clean detached worktree (frozen install). Base: INT-03 tip `4fe7bae`. Raw output: `raw/int04-r1/gates/`.

## What was merged (one at a time, dependency order, all clean, no conflicts)
| Order | Ticket | Reviewed revision | Note |
|---|---|---|---|
| 1 | FE-14 (carries BE-05 `dabaca0`, BE-23 `1a5f4e1`, FE-17 `e526377`, FE-13 `0214e00`) | `b74e1d8` | fast-forward |
| 2 | BE-24 | `945c6ee` | merge |
| 3 | SEC-02 (document only) | `238d87b` | merge |
| 4 | SEC-05 (document only) | `265f38e` | merge |
| 5 | DO-05 | `11361f2` | merge |
| 6 | DO-06 | `1633b7b` | merge |
| 7 | DO-07 | `cb74149` | merge |
| 8 | Integrator renumbering (not reviewed yet) | `8195772` | BE-05 migrations `2200`-`2205` renamed `2400`-`2405` (content: header comments only). Reason: the runner refuses duplicate versions (`DUPLICATE_VERSION`, `plan.ts`) and INT-03 already holds `2200`-`2204`. Needs an independent review (INT04-F11). |

## Gates (exit codes in `gates/exit-codes.txt`)
| Check | Result |
|---|---|
| install --frozen-lockfile, typecheck, build, test:boundary | pass |
| lint | **FAIL** 19 errors (INT04-F04) |
| format:check | **FAIL** 11 files (INT04-F05) |
| unit (`run-unit.mjs`) | pass, 1218 tests in 9 reports, none skipped or failed |
| integration-db (N-1 skipped, no release tag) | **FAIL**: 104 + 23 + 980 (1 failure) + 84. Failure: BE-23 consent-template publish returns 400 (INT04-F06) |
| C1 elevation, C4 second approver, C6 kill switch (BE-05 dbtests inside the api suite) | pass (`integration-db.txt`: "elevation (26.3, C1)", "role changes need a second approver (C4, 25.8)", "kill switch (C6, 25.8)") |
| gitleaks (history of HEAD, working tree) | **FAIL** 1 finding: `infra/modules/observability/tests/phi-canaries.json:11` (INT04-F07). The full-ref scan also lists 5 findings from branch `HEAAA-140` (QA-04), which is not part of this candidate |
| Semgrep | **FAIL** 34 parse errors in the four new workflows (INT04-F08) |
| OSV | pass, none blocking (2 non-blocking, same as INT-03) |
| actionlint 1.7.12, workflow hygiene | pass |
| `scripts/deploy` tests and policy scan | pass, 40/40 |
| `scripts/release` tests | **FAIL** 41/42 (INT04-F09) |
| IaC (tofu validate / tflint / plan tests) | **NOT RUN**: no tofu or tflint in this environment (HEAAA-291) |

## End-to-end journeys: NOT RUN
The admin path cannot be exercised on this candidate. On the combined tree nothing mounts the admin realm API (`createIdentityAdmin`), the BE-23 and BE-24 controllers, the admin worker handlers, or the three admin portal features in `StaffApp` (grep results in `INT-04-FINDINGS.md`). Admin configuration, the audit viewer and BTG review therefore have no real path through browser, API and database. No screenshots were taken because there is no admin screen in the running application to capture. Unit and dbtest results above test the modules, not the composed product.

## State
Executed; **not Integrated, not ready for BUILD_REVIEW**. Findings INT04-F01..F11 in `INT-04-FINDINGS.md`. Nothing is human-approved or deployed.
