# INT03-F16: mount the real staff app (HEAAA-380)

Base `7a2fca0` (see `raw/int03-f16/base-commit.txt`). Changes (apps/staff only):
- `src/main.tsx` now loads `src/app/entry.tsx` (auth shell + `StaffApp`); `index.html` title no longer says placeholder.
- `StaffApp` routes: `/tasks` -> `MessagesPortal`, `/availability` -> `AvailabilityPortal`, `/arrivals /triage /forms /follow-ups` -> `PreconsultDesk` (open chart -> `/patients`), doctor paths -> `DoctorPortal`.
- New nav item "Availability" (doctor surface). Documents: patient-scoped, rendered under the open chart on `/patients` via `DoctorPortal.renderDocuments`; `DocumentsPage` takes `Pick<ShellRuntime,'api'>`.
- Tests updated (nav now 6 doctor items / 11 combined; the "no lab" check uses a word boundary so "Availability" is not a false match).

Checks (`raw/int03-f16/staff-checks.txt`): typecheck clean, staff unit tests 160/160, `pnpm build` ok.

Browser proof, real built API + worker + fixture staff IdP + built staff app on `localhost:4675`, throwaway migrated DB (setup.mjs, same fixtures as r8; principal holds doctor + front_desk + care_coordinator). Screenshots `raw/int03-f16/x-*.png`, log `x-run.txt`:
sign-in -> `/schedule` with the full nav; real calls 200: `auth/session`, `clinicians/{id}/schedule`, `clinicians/{id}/notes`, `clinicians/{id}/cosign-queue`, `clinicians/{id}/availability-templates`, `locations/{id}/arrivals`, `locations/{id}/queue`, `tasks`. `/tasks`, `/arrivals`, `/triage`, `/availability`, `/patients`, `/notes-to-sign` render their real screens.

Not fixed / limits: `GET /api/v1/alerts` 404 and `/alerts/stream` 403 (API side), so `/alerts` shows an error page; Waitlist has no screen (still "not available"); documents panel reachable only after opening a patient chart, not exercised in browser (no patient/chart data walked); front desk write journeys, messages send, merge not exercised. Unrelated uncommitted edits in `apps/api/src/composition*.ts` belong to someone else and were not committed.
