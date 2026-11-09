# INT03-F21 (part 2): staff Documents routes (HEAAA-391, decision HEAAA-396 Option A)

Staff variants of `POST /patients/{id}/document-uploads`, `POST /document-uploads/{id}/complete`, `GET /patients/{id}/documents`,
`POST /documents/{id}/download-url` are served by `DocumentsStaffController`, bound to `EHR_STAFF_HOST`; the patient controller is bound to
`EHR_PATIENT_HOST`; all staff-only routes are on the staff host. The factory requires two distinct non-empty hosts. The route inventory
records each controller's host and fails on a duplicate `METHOD path` unless every occurrence is host-bound to a different host. The staff
list is audited (`view`, patient and action only).

Checks (real PostgreSQL via EHR_TEST_ADMIN_URL, real Nest app and guard):
- `documents.dbtest.js`: 22/22 pass, incl. new test: no session 401; no permission 403; out-of-location 404; staff upload/complete/scan/
  download (409 then 200, audited `download`); staff list with staff-only fields and one `view` audit row; cross-host 403 both ways;
  unknown host 404; patient list has no staff fields.
- API unit suite 209/209 (composition: shared paths host-bound, 8 entries; unbound/same-host duplicate fixtures fail the inventory; 401 on both hosts).
- tsc, prettier, eslint on changed files clean.

Changed expectation (not a weakening): in TC-DOC-01 a patient calling the staff-only classify/confirm on the patient host now gets 404 (route
absent per ARCHITECTURE 27.2); the same call on the staff host stays 403 (realm), asserted.

Not run: browser journey of the staff chart Documents panel on the real stack (needs the integration stack; for the Integrator). The object store is
still not configured in `main.ts`, so upload/download URL creation refuses there.
