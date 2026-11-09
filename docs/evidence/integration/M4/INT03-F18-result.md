# INT03-F18: integrations host composed (HEAAA-382)

Base 7a2fca0. Change: `apps/api/src/composition.ts` composes `createIntegrationsHostControllers` (PublicDirectoryService over the real OrganisationService and AvailabilityService). The webhook receiver is a stub answering 404 for every source: no verifier or key store exists until C-01, so no webhook is accepted (the routes were absent before; not a regression).

Tests: `apps/api/src/composition.test.ts` adds (a) GET /public/v1/services|locations|clinicians return 200 with `Cache-Control: public, max-age=60`, no session; (b) negative control: 404 without the controllers. `pnpm run build` then `node --test dist/src/composition.test.js`: 9 pass, 0 fail. `routes.test.js` + `catalogue.test.js`: 16 pass. Prettier check clean. Full CI gate suite not re-run.

## Real stack (r8 setup.mjs + launch.sh: throwaway migrated DB, built API, EHR_INTEGRATIONS_HOST=integrations.localhost, synthetic data)
- `GET /public/v1/services` 200: General appointment, Video visit, Waitlist visit (real DB rows)
- `GET /public/v1/locations` 200: Synthetic Clinic; `GET /public/v1/clinicians` 200: Dr. Synthetic
- `POST /webhooks/video/x` 404 (no vendor configured)
- Brand site (`apps/site` dist, PUBLIC_API_ORIGIN=http://127.0.0.1:3510) via curl: /services, /doctors, /locations render the API's data (JSON-LD lists General appointment, Video visit, Dr. Synthetic, Synthetic Clinic); the "not available" fallback text count on /services is 0; /sitemap.xml lists pages.

Limitation: Chromium is not installed in this environment, so no browser screenshots; the check is server-rendered HTML via curl.
