# INT03-F03 Part B (HEAAA-334): messaging definers, migrations 2203/2204 (amendment A-4)

Candidate code commit: `9691777` (branch `HEAAA-334-…`, based on `11eb194`, INT-03 r2 base with 2200–2202). Evidence files are added in the commit after it.
Sources: HEAAA-332 `decision-log` rev `bf854c3a-fb72-4912-8c87-8c017b867d9c`; HEAAA-310 `ruling` rev `d9504db5-1908-43fb-8226-82f8b923fddf` section 3 Part B (B1–B4) and section 4 (I-10, I-11); Cybersecurity HEAAA-333 comment `5f4974c6` (C-1..C-4, T-1..T-10).
Environment: PostgreSQL 17.11 (embedded-postgres 17.11.0-beta.19 binary, loopback, trust auth, synthetic data; no Docker/root in this workspace), node v24.22.2, pnpm 12.16.1. Not the CI container. Raw files: `raw/`.

## Changes
| File | Change |
|---|---|
| `db/migrations/2203_messaging_participant_policies_invoker_creator.sql` (expand) | `participant_owner_insert/delete`: `messaging.is_creator(...)` → invoker `EXISTS (SELECT 1 FROM messaging.thread t WHERE t.id = thread_participant.thread_id AND t.created_by = (SELECT kernel.uuid1('app.principal_id')))`, every other conjunct verbatim. `DROP POLICY thread_definer_select`. `REVOKE SELECT` on `thread` and `thread_participant` from `patient_scope_owner`, `GRANT SELECT (thread_id, organisation_id, principal_id, role)` on `thread_participant`. C-1: `participant_definer_select` recreated with `principal_id = caller`. Header comment carries the Cybersecurity Q4 statement (creator that lost scope / non-google realm / proxy patient-audience is refused, intended) |
| `db/migrations/2204_drop_messaging_is_creator.sql` (contract) | `contract-approval` names ruling rev `d9504db5` and decision-log rev `bf854c3a`. `SET LOCAL ROLE patient_scope_owner; DROP FUNCTION messaging.is_creator(uuid); RESET ROLE;` No CASCADE |
| `db/tools/catalog-lists.mjs` | `definerInventory` = 25 (adds `messaging.is_participant`, `messaging.is_owner`); new `messagingDefinerAttributes` (owner, `prosecdef`, `provolatile='s'`, `proconfig`, exact `proacl`) — C-3 |
| `db/tools/catalog-check.mjs` | new check `M-5-messaging-definer`: attributes pinned; no unexpected messaging definer; `patient_scope_owner` NOLOGIN/not superuser/not BYPASSRLS/no CREATEROLE…, only the `app_owner` SET-only membership, no GRANT OPTION (table and column), no table privilege, SELECT only on the four columns, no INSERT/UPDATE/REFERENCES, USAGE (no CREATE) on `messaging`, exactly one policy `TO patient_scope_owner` (on `thread_participant`, with the principal clause) — C-2, A4-3 |
| `db/tools/db-test.mjs` | T2: length 25, `messaging.is_creator` in "must not exist"; new block `A-4 messaging definers` with I-10 and T-1..T-10 |

## Results (candidate `9691777`)
| Check | Result | Raw |
|---|---|---|
| `pnpm install --frozen-lockfile`, `lint`, `format:check`, `typecheck`, `build`, `test:boundary` | all exit 0 | `raw/install.txt` … `raw/boundary.txt` |
| `node db/tools/check-migrations.mjs` | exit 0 | `raw/check-migrations.txt` |
| kernel rules/plan tests (no DB) | exit 0 | `raw/kernel-rules.txt` |
| `node --test db/tools/db-test.mjs` (migrations from empty) | **54/54 pass** (r2: 43, 1 fail = `M-5-definer`) | `raw/db-test-candidate.txt` |
| `catalog-check.mjs` on a database migrated from empty | all checks pass, incl. `M-5-definer` (25) and `M-5-messaging-definer` | `raw/catalog-check.json` |
| `integration-db.sh` (N-1 skipped, as in r2) | db-foundation 54/54; kernel 23/23; worker 79/79; api 884: 880 pass, 3 fail, 1 todo | `raw/integration-db.txt` |
| messaging api DB suite alone (`messaging.dbtest.js`, TC-MSG, I-11) | 12/12 pass | `raw/messaging-dbtest.txt` |
| `infinite recursion detected in policy` in any run | **none** (the only text match is the name of test T-8) | `raw/integration-db.txt` |

api failures are exactly those of r2 that belong to other tickets: `chart.dbtest` forced-RLS table list (F08a), `reporting.dbtest` ops-feed no-patient-data (F08b), `rls-matrix.dbtest` catalogue shape (F08c); the 1 todo is the TODO-marked front-door accept test (F08d). None is in I-1…I-11. Clinical, privacy and messaging suites otherwise pass.

## Invariants
- **I-10**: `M-5-definer` passes with 25 entries; `messaging.is_creator` does not exist; `patient_scope_owner` has no table privilege on `messaging.thread`/`thread_participant`, only the four columns; no policy `TO patient_scope_owner` on `thread` (test `I-10`, T-3, `raw/catalog-transcript.txt`).
- **I-11**: all 12 TC-MSG tests pass unchanged; T-5/T-6/T-7 show creator adds own owner row, non-creator cannot, member cannot add/delete/promote, participant and creator see the thread and nobody else.

## Cybersecurity tests (each is one test in `db-test.mjs`; raw = `raw/db-test-candidate.txt` lines `✔ T-n`, SQL state in `raw/catalog-transcript.txt`)
| T | Proves (assertions in the test) |
|---|---|
| T-1 | audiences `system`, `anonymous`, `public`, `webhook`, unset × roles `app_api`/`app_worker`: both functions return `false` for a genuine owner, never raise; `patient_scope_owner` reads 0 participant rows under each; staff control returns `true` |
| T-2 | member: participant yes / owner no; outsider false; unset principal/org not true; org-1 caller asking about an org-2 thread equals a random UUID (`false`/`false`); `NULL` argument not true, no error |
| T-3 | as `SET ROLE patient_scope_owner`: `SELECT *`/`subject` on `thread` → 42501; `SELECT *`/`last_read_at`/`added_by` on `thread_participant` → 42501; four columns readable and only the caller's own rows return (C-1); `has_column_privilege` only the four; no table-level privilege, no INSERT/UPDATE/REFERENCES; one policy with the principal clause; no GRANT OPTION; role NOLOGIN, not superuser, not BYPASSRLS |
| T-4 | participant/owner who lost `staff_scope` (no BTG) reads and updates 0 rows; after the participant row is deleted `is_participant` is false at once, the thread is invisible, a message insert is refused (trigger `PS001`; with the trigger off the `message_staff_insert` policy gives 42501) |
| T-5 | creator adds own owner row (control, with scope); `role='member'`, row for another principal, other organisation → 42501; non-creator guessing the ID → 42501; lost scope / realm not `google` / proxy patient-audience creator refused **by the policy itself** (trigger off; these were allowed by `is_creator` — fails on the base, `raw/a4-tests-on-base-without-2203-2204.txt`); `created_by` spoof refused by trigger (`PS001`) and, trigger off, by `thread_staff_insert` (42501); last owner stays (`PS001`) |
| T-6 | proxy with a participant row reads and updates nothing (`is_participant` true, thread policy denies); patient cannot add a staff owner to a staff thread (42501); ineligible participant on a patient thread refused (`PS001`) |
| T-7 | member cannot add (42501), delete (0 rows), promote (42501: no UPDATE grant on `role`); owner adds; owner of X cannot add/delete on Y; cross-organisation owner cannot act |
| T-8 | 8 statement classes × `staff`, `patient`, `system` (24 statements): no recursion error; `EXPLAIN (VERBOSE, COSTS OFF)` shows `messaging.is_participant(` as a call, no expanded scan of `thread_participant`; run again as `app_owner` with `row_security = on` |
| T-9 | no `is_creator` in `pg_proc`, no dangling `pg_depend` reference to a function, no policy text mentions it; the `prosecdef` functions of `messaging` are exactly the two; owner/`prosecdef`/`provolatile`/`proconfig`/`proacl`/argument/return type pinned; `SET search_path = public` plus a TEMP table of the same name leaves the answer unchanged |
| T-10 | database with 2203 only: `is_creator` still exists, no policy depends on it, 2204 then applies; database with 2204 but not 2203: fails with `2BP01` (no CASCADE), function stays, tracker row rolled back |

Negative control: the same test file run with 2203/2204 removed (`raw/a4-tests-on-base-without-2203-2204.txt`) fails I-10, T-3, T-5, T-9, T-10, T2 and the catalog check; the behavioural tests T-1/2/4/6/7/8 pass on both, i.e. the access semantics did not change.

## Observation O-1 (pre-existing, unchanged, for the Architect; not a regression, not fixed here)
Ruling I-11 and decision-log section 5 say "an owner adds and removes a member". Through `app_api` an owner can **not** remove another principal's row, at the base (2202) and after 2204 alike (`raw/owner-delete-observation.txt`): `participant_principal_select` shows an owner only their own row, so `DELETE … WHERE principal_id = <member>` matches 0 rows; and the `guard_participant` trigger reads the owners under the caller's rights, so an owner removing their own row always meets "the last owner stays" (`PS001`). The 2203 DELETE policy is proved with that trigger off (T-5). Fixing it needs a policy/trigger change outside 2203/2204 and A-4; I did not do it.

## Not demonstrated / limits
- Not the CI container; PostgreSQL 17.11 from an npm-distributed binary. N-1 / upgrade-from-tag path skipped as in r2 (no `r*` tag exists).
- Real UI/API journeys beyond the TC-MSG api suite are not run. Unit suite on the CI command not re-run.
- No Docker image, no deployment, no human approval. Backend Reviewer, then Security Reviewer, have not reviewed this yet. Review round 0 of 3.
- The A-4 Architect docs change (ARCHITECTURE 21.6/22.12, SHARED-BOUNDARIES 6.2) is a separate Architect ticket, not part of this one.
