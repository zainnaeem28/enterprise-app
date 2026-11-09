# INT-03 round 1 result (HEAAA-133): combined M4 candidate does NOT pass

Integrator run, 2026-11-08. Node v24.22.2, pnpm 12.16.1, PostgreSQL 17 (`ehr-test-db`), synthetic data only. Not submitted to QA, not Integrated, no gate approved.

## Merged revisions (dependency order, one at a time, `--no-ff`)
Base: INT-02 `275fdd4` (QA PASS, HEAAA-124). Then BE-16 `e659507`, BE-18 `c973a3b`, BE-17 `b693c03`, BE-20 `1485f5a`, BE-19 `c56f76d`, BE-21 `067bb7b`, FE-06 `fafd13f`, FE-09 `087e708`, FE-10 `9791c4e`, FE-05 `4c9b8c7`, FE-11 `5e0675b`, FE-12 `750fcc9`, FE-07 `949f569`, SEC-08 `15a5db8` (docs). FE-15 `a1953ec` is already an ancestor of INT-02. Each is the tip named in that ticket's last reviewer PASS (FE-07 tip `949f569` has the UI/UX PASS on its latest cycle; I did not re-verify that its other reviewer stages are complete).
Conflicts: one textual (`apps/patient/src/app/App.tsx` imports: kept booking + previsit/telehealth/profile/privacy/messages). Lockfile merged without conflict and `pnpm install --frozen-lockfile` passes.
Mechanical edit by me (needs independent review): six migration files renumbered because `loadMigrations` refuses duplicate versions (`DUPLICATE_VERSION`): INT-02 `1600..1603` -> `1604..1607` (they touch only pre-M4 objects), consent template text `2000,2001` -> `2003,2004`; only comment cross-references changed.

Candidate commit for the evidence below: `c48db50` (see `raw/r1/candidate-commit.txt`).

## Checks on the clean candidate `c48db50` (raw: `raw/r1/`)
| Check | Result |
|---|---|
| `pnpm install --frozen-lockfile` | pass |
| `pnpm run lint` | pass |
| `pnpm run test:boundary` | pass |
| `pnpm run format:check` | **FAIL**: 5 files (apps/staff/.../auth/evidence/MANIFEST.md, playwright-report.json; documents/evidence/playwright-report.json; preconsult/evidence/MANIFEST.md, playwright-report.json) |
| `pnpm run typecheck` | **FAIL**: 2 errors (below) |
| `pnpm run build` | **FAIL**: same 2 errors in `apps/api` |

## Checks on a scratch copy = `c48db50` + the 2 one-line fixes in `raw/r1/scratch-patched/local-compile-fixes.patch` (NOT committed; diagnostic only, to find what else fails)
| Check | Result |
|---|---|
| typecheck, build | pass |
| unit (`run-unit.mjs`, NODE_ENV=test) | pass: 1002 tests in 8 reports, 0 failed/skipped |
| DB suites (`integration-db.sh`, `INTEGRATION_SKIP_N_MINUS_1=true`) | **FAIL**: db-foundation 40 tests / 3 failed; kernel 23 / 0; api 878 / 53 failed, 1 skipped; worker 78 / 0 |
Raw: `raw/r1/scratch-patched/{db1.log,api.txt,db-foundation.txt,kernel.txt,worker.txt,unit.log,*-junit}`. Single attempt; the failures below are deterministic in cause (missing registrations, catalog), not flakes.

## Findings (stable IDs; all blocking unless stated)
| ID | Summary | Evidence |
|---|---|---|
| INT03-F01 | **No M4 module is composed.** `apps/api/src/composition.ts` mounts only the INT-02 surface; nothing outside `modules/{clinical,messaging,privacy,reporting}` references `createClinical*`, `createMessaging`, `createPrivacy`, `createReporting` or their `register*Participants`/assignment sources/jobs; `apps/worker` registers none of the clinical, messaging, privacy or reporting jobs/crontab. No M4 route, job, merge participant or export contributor is reachable in the running app, so the required journeys (arrival, triage, red-flag, consultation, sign/co-sign, documents, messaging, privacy) cannot run on the combined revision. BE-19/20/21 each noted this wiring as outside their paths. | `grep` over `apps/api/src`, `apps/worker/src` (empty) |
| INT03-F02 | **Build/typecheck fail.** (a) `composition.ts:187` `createFlowControllers({db, flow})` lacks required `limiter` (added by HEAAA-305 in the FE-07 base); (b) `modules/patient/identity-label.dbtest.ts:63` `requestConsent` now needs 6 args (template language). Related, not a compile error: composition's `consentTemplates.isPublished` closure takes `(tx,key,version)` while records.ts now calls it with a language, so the language is silently ignored. | `raw/r1/build.txt`, `typecheck.txt` |
| INT03-F03 | **Single merge write guard (A-2 / HEAAA-190 ruling) violated by M4.** M-5-patient-guard fails for 19 tables: clinical.{problem, allergy, medication_statement, vital_sign, questionnaire_response, triage_assessment, referral, consent_exception, follow_up, encounter, note, note_cosign, note_addendum}, privacy.{request, export_package, incident_patient}, messaging.{thread, message, task}. M-5-definer fails for 8 module-local copies not in the inventory: messaging.{is_participant, is_owner, is_creator, guard_open_patient}, clinical.{guard_open_patient, frontdoor_guard_open_patient, notes_guard_open_patient}, privacy.guard_open_patient. INT-02 refused module copies (1604/1605 drop five of them). Needs an Architect/Backend decision: attach `patient.guard_open_patient` (per 1604) or have `db/tools/catalog-lists.mjs` accepted by the Architect. Also fails SEC03-F13 negative-control baseline and "M-5-patient-guard fails when the guard trigger is disabled". | `raw/r1/scratch-patched/db-foundation.txt` |
| INT03-F04 | **Merge participants and export contributors missing.** ~35 api DB tests fail with `patient.merge_participant_missing` (merge job fails when tables of unregistered modules hold patient data) or `privacy.contributor_missing`: merge job/conflict rules, TC-MG-02/04/06/07/12/13, 9.2 queued-job resolution, scheduling/telehealth/documents/flow/notices merge tests, messaging TC-MSG-05, privacy TC-PR-02/04 and the rest of the privacy suite, clinical chart/frontdoor/notes item-11 count tests. Every module's test harness registers only its own participants while the shared database now contains all modules' tables. This is exactly the acceptance item "a merge across all registered participants asserts found = re-pointed + resolved + kept, and a privacy export contains a part from every registered contributor": **not met**. Needs one shared registration helper used by the composition root and all dbtest harnesses. | `api.txt` failing-tests section |
| INT03-F05 | **reporting_ro policies fail the catalog.** M-3 and M-4-reporting list `reporting.ops_{integration_health, queue, calendar_staleness, alert_backlog}`; organisation BE-03 "repository catalog check" test also fails. BE-21 asked for a `db/tools/catalog-lists` patch (`catalog-lists.requested.patch`, plus open items O-1/O-B needing Architect acceptance); not applied (outside every allowed path). | `db-foundation.txt`, `api.txt` |
| INT03-F06 | **Duplicate migration versions** between independently reviewed branches (1600-1603, 2000-2001). Resolved mechanically by me (renumber, see above); needs independent review and a rule for who allocates versions. Moderate. | `ls db/migrations` |
| INT03-F07 | `format:check` fails on 5 evidence files from FE-04/FE-06/FE-09 (listed above). Low. | `raw/r1/format-check.txt` |
| INT03-F08 | Failures not yet attributable (re-triage after F01-F05): clinical "every clinical table forces RLS and names its roles" (table list differs); AN-1 row-visibility matrix (`clinical.allergy` has no seeded row for patients A/B); "K states immutable" (care_relationship update not rejected); reporting feed "no patient data" ("patient not found"); privacy coverage test ("schema telehealth already exists"); documents BE-10 count tests; 60 s timeouts in the merge-vs-writers race tests (likely cascade of F04). | `api.txt` |

## Not demonstrated
Any real UI/API/worker journey (blocked by F01); screenshots of the combined candidate; N-1 migration (skipped as in INT-02); Playwright/axe on the merged tree; SAST/dependency/secret scans; red-flag rule content stays BLOCKED on D-12a.

## Next permitted action
Orchestrator: create correction tickets for F01-F05 (F06/F07 small), with Architect ruling on F03/F05, none depending on HEAAA-133; each fix independently reviewed; then Integrator re-merges and reruns. Review round count for this ticket: 1 of 3 (cumulative).
