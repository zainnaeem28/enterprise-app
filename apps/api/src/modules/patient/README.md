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

- Round 2 (Orchestrator decision on HEAAA-168): the catalog allow-list patch is applied to `db/tools/catalog-lists.mjs`
  (`catalog-lists.requested.patch` is kept as the record). The BE-04 identity and BE-06 notifications db test fixtures now create real
  `patient.patient` rows (fixture-only edits, no assertion changed).
- The merge write guard refuses a transaction with no organisation, another organisation, or an audience outside patient/staff/system
  with 42501, and an unknown patient in an allowed context with PM008.
- `organisation.dbtest` failures about `identity.public_clinician` and the identity `*_directory` / signin policies predate this
  ticket (BE-04 objects against BE-03's expected lists).
