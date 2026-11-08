# Doctor availability (FE-11, HEAAA-123)

Staff screens DR-11 (weekly hours), DR-12 (leave and blocked time) and DR-13 (Google Calendar connection) of UI-UX 4. Entry point:
`AvailabilityPortal` (`index.ts`), one component for the path `/availability`, three tabs. Permissions only decide what is drawn; the server
authorizes every call and the doctor only ever acts on their own principal.

**Review base.** `15d6cb7` (branch `HEAAA-305-be-conform-rev6`), which contains the prerequisites FE-08, BE-12, BE-14 and FE-07; none of them is on
`main` yet. The FE-11 change is `git diff 15d6cb7 -- apps/staff/src/features/availability`; nothing outside that folder is edited. Helpers are
imported read-only from `../preconsult` (`http.ts`, `useLoad.ts`, `Problem.tsx`) and `../doctor` (`session.ts`, `format.ts`, `useOnline`).

## Acceptance map

| Acceptance                                                      | Where it holds                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Weekly templates show affected appointments before saving       | `Templates.tsx`, `preview.ts`, `affected.ts`. "Check affected appointments" reads the doctor's own visits at the location for today and the next 13 days (`GET /clinicians/{id}/schedule`) and lists the live visits the current hours cover and the changed hours would not. Save is not offered until the check is complete; with any affected visit it needs an acknowledgement. Stopping a template (`DELETE`) shows the same result in its dialog. |
| Leave and blocked time show affected appointments before saving | `BlockedTimes.tsx`: "Check" sends `dryRun: true` (counts only, nothing saved); Save is offered after it, with `acknowledgeConflicts: true` only when the count is above zero and the doctor confirmed. A `409 scheduling.conflicts_with_appointments` at save (bookings arrived since) shows the new count and asks again.                                                                                                                              |
| Calendar connect shows consent text                             | `CalendarLink.tsx`: the three consent lines and the busy-only note are on screen before and beside the Connect button (`strings.ts`: `consent`, `busyOnly`).                                                                                                                                                                                                                                                                                            |
| Connected, disconnected and error states                        | `not_linked` "Not connected", `pending_consent` "Waiting for Google", `active` "Connected" (with last sync), `token_revoked` "Connection needs attention", `error` "Connection problem": each a chip with an icon and words, with its own explanation. Disconnect asks first.                                                                                                                                                                           |
| Busy-only note                                                  | Shown in every state (`strings.ts` `busyOnly`).                                                                                                                                                                                                                                                                                                                                                                                                         |

State catalogue (UI-UX 6) covered: loading, empty, 403 (permission note), 404/429/5xx pages with reference code, 412/428 in words, validation
with an error summary that takes focus and names the field, idempotent retry (one `Idempotency-Key` per attempt, renewed on any edit),
offline banner with writes disabled.

## Limitations and open points (not hidden)

1. **Not wired into the staff app.** `StaffApp.tsx` and `navigation.ts` are outside this ticket's allowed paths. There is no "Availability" item in
   the doctor navigation and no route renders `AvailabilityPortal`. Request to the Orchestrator: add `{ id: 'availability', label: 'My availability', path: '/availability' }`
   to the doctor items and render `<AvailabilityPortal runtime={runtime} />` for `isAvailabilityPath(path)` (as FE-10 did for `DoctorPortal`). The Google callback
   (`GET /calendar-link/callback`) redirects to the API's configured `returnUrl` with `?calendar=linked|denied|error`; that URL must be `/availability`
   for the outcome message to show.
2. **Template preview is computed on the screen**, not reported by the server: the API has no conflict report for templates (BE-12 README). It covers the
   next 14 days only (`PREVIEW_DAYS`), reads one `GET .../schedule` per day (each is an audited read of the doctor's own schedule), counts only
   live visits (held, confirmed, checked in, in consultation) and judges them in the location's time zone from the schedule answer. A visit already outside the old hours is not blamed on the change.
   Appointments beyond day 14 are not checked; the screen says how many days it checked. An Architect/Backend decision to add a server-side
   template conflict report would replace this.
3. **Contract gaps.** Request and response bodies of these routes are `OpaqueObject` in the generated types, and the catalogue's blocked-time `DELETE` has no identifier
   (`x-catalogue-gap`), so calls go through the same untyped seam as the doctor portal (`api.ts`) with the controllers' paths and shapes. Not exercised against the real API.
4. **Services, rooms and overbooking** of a rule are kept as the server sent them and are not editable here (not in DR-11 as specified); a new block of hours applies to every
   service the doctor is eligible for, in any room.
5. **Time zone of leave and blocked time.** The pickers use this device's time zone (the screen says so); the server stores instants. A doctor travelling would enter a period in the other zone.
6. **Leave list** shows what has not ended yet and has no cursor paging (`nextCursor` is ignored; the default page size applies). The "Admin time" kind is offered as the API allows it.
7. **Admin-realm routes** (`/admin/clinicians/{id}/...`, any clinician, elevation required) are not part of this screen.
8. **Unverified against Google (C-10).** The consent address is whatever `POST /calendar-link/start` returns; the screen only follows an `https://accounts.google.com` address. Real consent, token revocation and sync have not run (BE-14 proved them against a local stub).
9. **No real API, database or Google service ran.** All unit and Playwright tests are contract mocks. The real journey is for integration (INT).
10. **Screenshots** use Chromium headless shell 1248 with system libraries and the Inter font unpacked under `/tmp` without root (not part of the repo). Fonts and icons differ slightly from production. Human legibility review of the copy (TC-PC style) is pending.
11. Conditions: C-10 (Google calendar, unverified live) and C-16 touched on the UI side only.

## Checks (raw output in `evidence/raw`, screenshots in `evidence/screenshots`, see `evidence/MANIFEST.md`)

Run from `apps/staff`; Playwright needs Chromium (`pnpm exec playwright install chromium-headless-shell`).

```
pnpm exec tsc -p tsconfig.json --noEmit
NODE_ENV=test pnpm exec vitest run
pnpm exec playwright test -c src/features/availability/e2e/playwright.config.ts
# from the repo root:
pnpm exec eslint apps/staff/src/features/availability
pnpm exec prettier --check apps/staff/src/features/availability
```
