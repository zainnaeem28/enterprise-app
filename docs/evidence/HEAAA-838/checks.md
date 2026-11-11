# HEAAA-838 evidence (legal page text, optional NPP page)

Base: HEAAA-799 head 4a158ba. Checks run on the submitted head (no hosted CI, owner ruling B):
- `apps/site`: `vitest run` 9 files, 76 tests passed (includes new tests: no placeholder sentence on any legal page; /legal/npp is 404 and absent from footer, privacy page and sitemap until entered; present once entered; contact block only for entered facts).
- `apps/cms`: `vitest run` 9 files, 92 tests passed (copy test: claim-term screen, no digits/e-mail in seed, review doc in step).
- `apps/cms` DB tests against real PostgreSQL (embedded, throwaway): 3 files, 14 tests passed; `legal_npp_*` columns present in `site_content` and `_site_content_v`.
- `tsc --noEmit` for apps/site and apps/cms: clean. `eslint apps/site apps/cms`: clean. `prettier` applied.
Not run: root `pnpm typecheck` ran out of memory (SIGKILL) in apps/api (untouched by this change); the migration `20261111_190000_site_content_npp` was hand-written (ALTER TABLE ADD COLUMN, varchar, nullable) with its snapshot json and is not run through `payload migrate` here.
Statements checked against code: single cookie `site_consent` (apps/site/src/consent.ts, 180 days, Lax), no localStorage/sessionStorage, no forms in apps/site, analytics only via ANALYTICS_SRC after Accept all (page type only), OpenStreetMap link opens in a new tab, booking link carries serviceId/clinicianId (handoff.ts).
