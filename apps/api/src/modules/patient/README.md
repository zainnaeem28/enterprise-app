# patient (BE-08)

Registration and matching (25.3, BR-37), care relationships and the derived `patient.staff_scope` (6.6), profile, contacts,
insurance, consents with signed templates (22.6), communication preferences, care team, and proxy access through
`identity.proxy_grant` (D-7 default; this module has no proxy table). Migrations `0700`-`0704`.

## Tests (real PostgreSQL 17, superuser URL on a throwaway server, synthetic data; missing configuration fails)

```
EHR_TEST_ADMIN_URL=postgres://postgres@host:5432/postgres \
  node --test apps/api/dist/src/modules/patient/registration.dbtest.js \
              apps/api/dist/src/modules/patient/records.dbtest.js \
              apps/worker/dist/jobs/patient/patient.dbtest.js
```

## Open items for the Orchestrator / other owners

- `catalog-lists.requested.patch` (this folder): `db/tools` is not in this ticket's paths. Without it the M-5 checks report
  `patient.staff_scope` (guard-exempt) and nine patient definer functions (inventory).
- This ticket attaches the merge write guard (`patient.guard_open_patient`) to `identity.patient_link`, `identity.proxy_grant` and the
  notifications tables, as BE-04 (identity 0502) and BE-06 (NOT-N4) recorded. Their db tests use patient IDs with no
  `patient.patient` row and now fail with `PM008 patient not found` (identity rls/guard, notifications api and worker). Their
  fixtures need real patients; that is a change in BE-04/BE-06 test paths, not made here.
- `organisation.dbtest` failures about `identity.public_clinician` and the identity `*_directory` / signin policies predate this
  ticket (BE-04 objects against BE-03's expected lists).
