-- migration-class: expand
-- SEC-03 finding F13 item 3 (docs/security/SEC-03-rls-assessment.md; ticket HEAAA-181). ARCHITECTURE 21.2 (N-3): app_api writes
-- kernel.setting through column grants, so that `pre_auth` stays at its default for every row the API writes. 0003 granted
-- SELECT, INSERT, UPDATE, DELETE on the whole table to app_api and app_worker.
--
-- app_api: INSERT the columns of 21.2 plus `id`. 21.2 lists six columns and omits `id`, but `id` is NOT NULL with no default (0002)
-- and every writer supplies a UUIDv7, so without it no insert can succeed (recorded as a deviation for the Architect).
-- UPDATE (value) only. DELETE and SELECT are unchanged (the T-CONF policies decide the rows).
-- app_worker: the system job `kernel.apply_reference_data` writes `pre_auth` rows and records `created_by_job` (21.7 point 2),
-- so its insert list is the app_api list minus `created_by` plus `pre_auth` and `created_by_job`; UPDATE (value) only.
-- `created_at`, `row_version` and `updated_at` come from defaults and the 21.5 trigger, which needs no column privilege.
REVOKE INSERT, UPDATE ON kernel.setting FROM app_api, app_worker;
GRANT INSERT (id, organisation_id, key, value, value_schema, location_id, created_by) ON kernel.setting TO app_api;
GRANT INSERT (id, organisation_id, key, value, value_schema, location_id, pre_auth, created_by_job) ON kernel.setting TO app_worker;
GRANT UPDATE (value) ON kernel.setting TO app_api, app_worker;
