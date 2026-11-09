# INT03-F21-O1 implementation result (HEAAA-400; decision HEAAA-396 r2)

Implemented on top of 8528642: `createDocumentsControllers` takes `hosts` and `banner`; composition passes `env.staffHost`, `env.patientHost`
and `chart.banner`. Patient controller bound to the patient host, staff controller to the staff host with the four shared paths; the staff list is
audited (`view`) and returns `{items, nextCursor, patientBanner}` (banner read in the same `withScope` transaction; `undefined` -> 404). The factory
throws on an empty host or equal hosts (case-insensitive); `loadIdentityEnv` reports `EHR_STAFF_HOST and EHR_PATIENT_HOST must differ`. Inventory
records each route's host and fails an unbound or same-host duplicate. README D4/O-1 closed; controller header updated. Guard unchanged.

Checks (real PostgreSQL, `documents.dbtest.js` 23/23; API unit tests 157/157; tsc, eslint, prettier clean):
- staff list 200 with items, nextCursor, `patientBanner.patientId` = path patient, staff fields, one `view` audit row; upload 201; complete 202; download 409 then 200, audited `download`;
- no session 401, no permission 403, out-of-location 404; patient list has no `patientBanner`;
- cross-host 403 both ways (Host and X-Forwarded-Host from loopback), unknown host 404;
- factory: empty / equal / equal-ignoring-case hosts throw; `loadIdentityEnv` equal hosts (incl. `STAFF.example.test`) reports the problem; inventory fixtures for unbound / same-host duplicates fail.

Test double: `testkit.ts` supplies a `banner` that decides visibility by RLS (`patient.patient` under the caller's scope); the production wiring uses the real `BannerService`
(`chart.banner`), whose content is covered by the chart tests.

Not run: required test 6 (browser re-run of the F16 staff chart Documents panel). It needs the full stack harness (`raw/int03-f16/setup.mjs`, built staff app, fixture IdP); left to the Integrator in INT-03 round 4. Limit: `main.ts` still has no object store, so upload/download URL creation refuses there (the list does not need it).
