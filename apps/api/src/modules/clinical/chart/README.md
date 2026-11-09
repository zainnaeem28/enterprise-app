# Clinical chart (BE-16)

Problems, allergies, medications (RxNorm-coded, free text flagged `uncoded`), vitals with reference ranges, banner and chart summary.
Migrations 1600-1603. Worker job `clinical.terminology_load` (chunked; licensed UMLS content is C-09, not asserted).
Vital-range table ships empty (BQ-12/D-12a). Merge participant (`repointPatient`) and `exportPart` registered via the F-04 registry.

Tests: `EHR_TEST_ADMIN_URL=postgres://postgres@127.0.0.1:<port>/postgres node --test dist/src/modules/clinical/chart/chart.dbtest.js`
(real PostgreSQL 17, 41 tests). Worker: `node --test apps/worker/dist/jobs/clinical/terminology-load.test.js` (7 tests).
Not proven here: real elevation check (BE-05), licensed terminology (C-09).

## Departures from the design

`clinical.guard_open_patient` (own copy of the merge guard) is superseded by the HEAAA-310 ruling: migrations 2200–2202 attach `patient.guard_open_patient` and drop the copy.
