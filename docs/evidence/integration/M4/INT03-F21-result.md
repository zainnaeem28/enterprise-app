# INT03-F21 - documents and alerts routes composed

Change (apps/api): `composition.ts` mounts `createAlertsController` (GET /alerts, /alerts/open-ids, POST /alerts/{id}/acknowledge),
`createDocumentsControllers` (patient-portal routes + staff-only routes) with `documentsResolvers()`; documents store defaults to a
refusing presigner (C-01 not delivered). When `main.ts` supplies a LISTEN client factory, `StreamHub` + `createAlertStreamController`
replace the platform transport-only `/alerts/stream` (ALR-N3; `createApp({replaceAlertStream})`), hub started/stopped with the app.

Checks run: `tsc` clean; prettier clean; api unit suite 208/208; `composition.test.ts` new F21 tests (routes refused 401 not 404 without
session; hub composed only with a listen factory; negative control 404 without the controllers); module dbtests against the real
database (alerts + documents) 55/55.

Not fixed / reported (no controller exists): staff `GET /patients/{id}/documents` and the other four shared-path staff variants are
not built (documents README O-1: one handler per path; the mounted one is patient-realm, permission `patient`). The staff chart
Documents panel will be 403 (was 404) until the Architect decides O-1 and a staff variant is built. Not verified in a browser on the
real stack in this run.
