# @ehr/site — brand site (FE-15)

Public pages for `www.`: home, services, find a doctor (with next available slot), doctor profile, locations, contact, legal.
A small Node server renders HTML from `GET /public/v1/*` on the `integrations.` host (server to server; PHI-free, 60 s cache).
The browser bundle is only the cookie-consent island.

| Variable            | Meaning                                                                  |
| ------------------- | ------------------------------------------------------------------------ |
| `PUBLIC_API_ORIGIN` | `integrations.` host (default `http://127.0.0.1:3001`)                   |
| `PATIENT_ORIGIN`    | `my.` host that "Book" hands off to                                      |
| `SITE_ORIGIN`       | public origin of this site (canonical URLs, sitemap)                     |
| `ANALYTICS_SRC`     | optional analytics script, loaded in the browser only after "Accept all" |
| `PORT`              | default 8080                                                             |

`pnpm build` · `pnpm start` · `pnpm test` (vitest) · `pnpm test:a11y` (Playwright + axe, needs Chrome; runs against
`e2e/fake-api.mjs`, a labelled contract mock) · `pnpm lighthouse` (needs Chrome).

Hand-off: `{PATIENT_ORIGIN}/book?serviceId=<uuid>&clinicianId=<uuid>`; non-UUID values are dropped.
Content that is not directory data lives in `src/content.ts` behind `ContentSource` (C-19 decides its source; FE-16).
`pnpm-lock.request.patch` is the `apps/site` importer change that `pnpm install` produces (no new resolved package);
`pnpm-lock.yaml` is outside this ticket's paths, so it is a request to the Orchestrator/DevOps.
