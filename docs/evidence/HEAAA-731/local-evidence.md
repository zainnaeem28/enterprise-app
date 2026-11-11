# HEAAA-731 local evidence (owner ruling B: no hosted CI), head eb3cc176ea4b, base dev f22dc62 = r208, PostgreSQL 17, node v24.22.2

## migration-check (rc 0)
pass  M-5-patient-guard  (merge write guard on patient_id tables)
pass  M-5-definer  (SECURITY DEFINER inventory, fixed search_path, NOLOGIN owner)
pass  M-5-anonymous  (anonymous/public policy sets are exactly the listed ones)
pass  M-5-public  (anonymous/public policy sets are exactly the listed ones)
pass  M-5-directory  (anonymous/public policy sets are exactly the listed ones)
catalog verification: 29 check(s), 0 problem(s)
ok   catalog rules after migrating from r208
== secret-reference lint (RDS master user)
secret-reference lint: 275 configuration file(s), 0 problem(s)
ok   secret-reference lint (RDS master user)
migration-check passed
MC rc=0

## integration-db: candidate suites + N-1 against r208 (rc 1)
2633:::error::suite api FAILED
3755:db-foundation: 120 test(s), 0 failure(s), 0 skipped
3756:kernel: 23 test(s), 0 failure(s), 0 skipped
3757:api: 1084 test(s), 1 failure(s), 0 skipped
3758:::error::suite api has 1 failing test(s)
3759:worker: 122 test(s), 0 failure(s), 0 skipped
3763:== upgrade path: r208 then candidate
3878:== N-1: r208 suites against the candidate schema
7630:db-foundation: 120 test(s), 0 failure(s), 0 skipped
7631:kernel: 23 test(s), 0 failure(s), 0 skipped
7632:api: 1082 test(s), 1 failure(s), 0 skipped
7633:::error::suite api has 1 failing test(s)
7634:worker: 122 test(s), 0 failure(s), 0 skipped
7636:::error::N-1: the previous release (r208) does not pass against the candidate schema
7637:::error::integration-db FAILED

## lint / typecheck / migration lint: 0 errors, rc 0 (46 pre-existing warnings); 109 migrations ok

## Reproduction on plain r208 (dev head, no 2504), api suite only
1204:  ✖ consent text: required, closed body, code-point limits, legacy textless draft cannot publish (71.065965ms)
2169:✖ consent text: required, closed body, code-point limits, legacy textless draft cannot publish (71.065965ms)
2186:api: 1082 test(s), 1 failure(s), 0 skipped

Only failing test in both: apps/api admin.dbtest 'consent text ... legacy textless draft' (astral title -> 400 invalid_format). It fails identically on plain r208, so it is environmental/pre-existing, not caused by 2504. Not pinned or skipped. Not run: seed controls, contract, a11y, e2e, SAST/secret/dep audit, bundle budget (no hosted CI; owner ruling B).
