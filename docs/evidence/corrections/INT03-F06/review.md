# INT03-F06 review verdict: Integrator migration renumbering (candidate c48db50 / evidence 1cd3cbc)

Reviewer: Backend Reviewer (472e0e86). Author of the change under review: Integrator (HEAAA-133). Independent: yes (I authored none of these files).
Verdict: **PASS** for the renumbering as a diff, with two findings recorded below (F06-01 needs a recorded decision, F06-02 is a trivial Backend fix). Review PASS is not human approval, integration or deployment.
Environment: PostgreSQL 17.11 (`ehr-test-db`, throwaway, synthetic), node v24.22.2, pnpm 12.16.1, pg 8.23.1; two scratch databases created and dropped by me. Trees: `c48db50` and `275fdd4` in separate worktrees, `pnpm install --frozen-lockfile` + `pnpm --filter @ehr/kernel build` in each.

## 1. Diff vs originals: only prefix and comments (CONFIRMED)
Originals: INT-02 `275fdd4` for 1600-1603 (merge guard); HEAAA-305 `597225f` for consent 2000/2001. Raw: `raw/diff-renumbered-files.txt`, `raw/noncomment-compare.txt`.
- `git diff -M`: 1604 R096, 1605 R093, 1606 R061, 1607 R100 (identical), 2003/2004 renamed with one comment line each. Low similarity scores are only because the files are short; the diffs are 1-2 comment lines each.
- Stripping `--` comments and blank lines, all six pairs are byte-identical SQL (`SQL-IDENTICAL` x6).
- Migration-class and contract-approval header comments (read by the rules checker) are unchanged.
- The other files that now occupy 1600-1603 (clinical, BE-16 `e659507`) and 2000-2002 (messaging, BE-19 `c56f76d`) are byte-identical to their reviewed originals (`cmp`).

## 2. Ordering and dependency (CONFIRMED)
- `loadMigrations` + `assertRules` (`db/tools/check-migrations.mjs`): `ok: 85 migration(s)`, no DUPLICATE_VERSION, no RULE_VIOLATION (`raw/check-migrations-c48.txt`; INT-02 had 63).
- 1604-1607 touch only pre-M4 objects (patient, scheduling, documents, telehealth, notifications, identity). `grep` shows no reference to clinical, messaging or consent_template in them.
- No M4 migration (1600-1603, 1700-2101 incl. 2003/2004) references anything 1604-1607 creates or drops (dropped copy functions, `principal_system_patients_read`, the `*_guard_open` triggers on pre-M4 tables); matches in 1901/2001 etc. are comments only.
- 1604 -> 1605 -> 1606 keep their relative order (trigger move, drop copies, revoke USAGE); 2003 -> 2004 keep theirs (add NOT VALID, then validate).
- Fresh install of all 85 files succeeded in order on an empty database (`raw/fresh-and-upgrade-run.txt`).

## 3. Fresh install vs upgrade catalog (EQUAL, but only with manual history surgery; see F06-01)
- Method (`scripts/`): DB-F = c48db50 bootstrap + migrate. DB-U = INT-02 `275fdd4` bootstrap + migrate (63 files, success), then upgrade to c48db50.
- Via the runner the upgrade FAILS: `plan` and `migrate` both stop with `CHANGED_APPLIED: Applied migration 1600_merge_guard_single has changed since it was applied (hash mismatch)` (nothing applied).
- Simulation of the only workable path: rename tracker rows 1600-1603 to 1604-1607 with the new names and hashes, then the runner would still refuse the four clinical files with `OUT_OF_ORDER` (below highest applied 1607). I applied the 22 pending files in file order by hand (honouring `transaction: none` for 1803): all applied (`raw/upgrade-simulation.txt`).
- Catalog dump (tables, owners, RLS flags, ACLs, columns, defaults, constraints incl. validated, indexes, triggers, policies, functions incl. owner/secdef/config/ACL/body md5, schemas, enums, default ACLs, tracker rows): 5503 lines each, **`diff` empty** (`raw/catalog-fresh.txt`, `raw/catalog-upgraded.txt`, `raw/catalog.diff`).
- `db/tools/catalog-check.mjs` gives the same result on both: pass except M-3/M-4-reporting (reporting.*), M-5-patient-guard (clinical.*), M-5-definer (messaging.*). These are unrelated to renumbering, identical in both databases, and belong to the other INT-03 findings; not assessed here.

## Findings (stable IDs)
| ID | Severity | Finding | Route |
| --- | --- | --- | --- |
| INT03-F06-01 | moderate (open, decision needed) | A database already migrated at INT-02 `275fdd4` cannot be upgraded with the runner. Renumbering rewrites applied versions: CHANGED_APPLIED on 1600, and after a manual tracker rewrite OUT_OF_ORDER on the clinical 1600-1603. Fresh install is fine; the catalogs match only after manual surgery. | Orchestrator/Architect: record that no persistent (staging/production/shared dev) database holds the INT-02 schema and all such databases are rebuilt from empty, or require a reviewed one-off tracker-rewrite runbook. No migration edit. |
| INT03-F06-02 | low | Two stale cross-references survive: `db/tools/catalog-lists.mjs:103` ("dropped by migrations 1600/1601") and `:150` ("migration 1600/1601"); they now mean 1604/1605. Comment-only, no behaviour. (Chart references to 1600-1603 elsewhere are correct, those files kept their numbers.) | Backend fix ticket (comment edit); I made none. |

## Not run / limitations
- `pnpm lint/format:check/typecheck/build/test:boundary` not run: the reviewed change is six SQL files and I edited no source; migration lint (`check-migrations`) and real-database runs are the relevant checks.
- Re-check version collisions at final integration: later correction tickets may add migrations (current set is unique, 85 files, highest 2101).
- DB-level behaviour of the renumbered files beyond catalog equality (their RLS/grant semantics) was not re-tested; SQL is byte-identical and catalogs are equal.

## Next permitted action
Solution Architect Reviewer reviews this verdict. Orchestrator records the F06-01 decision and files the F06-02 fix ticket. Current round: this ticket does not change the INT-03 count.
