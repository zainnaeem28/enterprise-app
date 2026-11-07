# Patient portal: book, change, cancel, waitlist (FE-04, HEAAA-107)

Screens PP-10..PP-19 (UI-UX 4 J-04 and J-05, 7.2). Everything is under `apps/patient/src/features/booking/`.

| Screen                                            | File                                                                         | Route                                |
| ------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------ |
| Appointments list                                 | `pages/AppointmentsPage.tsx`                                                 | `/appointments`                      |
| PP-10 Service                                     | `pages/ServiceStep.tsx`                                                      | `/book`                              |
| PP-11 Doctor and place                            | `pages/DoctorStep.tsx`                                                       | `/book/doctor`                       |
| PP-12 Date and time (hold, countdown, slot taken) | `pages/TimeStep.tsx`, `components/HoldTimer.tsx`, `components/SlotTaken.tsx` | `/book/time`                         |
| PP-13 Confirm                                     | `pages/ConfirmStep.tsx`                                                      | `/book/confirm`                      |
| PP-14 Booked, add to calendar                     | `pages/BookedPage.tsx`, `ics.ts`                                             | `/book/done/:id`                     |
| PP-15 Appointment detail                          | `pages/DetailPage.tsx`                                                       | `/appointments/:id`                  |
| PP-16 Change time                                 | `pages/ChangePage.tsx`, `TimeStep`, `ConfirmStep`                            | `/appointments/:id/change[/confirm]` |
| PP-17 Cancel with policy text                     | `pages/CancelPage.tsx`                                                       | `/appointments/:id/cancel`           |
| PP-18 Waitlist join                               | `pages/WaitlistPage.tsx`                                                     | `/waitlist/join`                     |
| PP-19 Waitlist offer                              | `pages/OfferPage.tsx`                                                        | `/waitlist/offers/:id[?expires=ISO]` |

## Mounting

`apps/patient/src/app/App.tsx` mounts `BookingRoutes` for every `isBookingPath` path, and the signed-in landing page
(`features/auth/LandingPage.tsx`) links to `/book` and `/appointments` when a patient is linked (INT02-R5-B1, HEAAA-209).
The feature is also exercised through its own harness (`e2e/harness`).

## How it follows the design

- **Hold (7.2).** Choosing a time creates the hold at once (step-1 `Idempotency-Key`). The countdown (`role="timer"`, "Held for 09:42")
  runs to the server's `expiresAt`, corrected by the server clock taken from the hold answer's `Date` header; it is announced politely at
  5, 2 and 1 minutes only. Confirm has its own key (step 2); a double click sends one request, a retry reuses the key.
- **Slot taken / hold expired.** "That time was just taken" with the alternatives from the 409's `errors[/alternatives/n]`, a waitlist offer
  and a disabled primary with its reason in text; service and doctor are kept; the grid reloads.
- **Cancel.** Block-only default (D-3). The page quotes the policy sentence; `acceptFee` is never sent; `scheduling.cutoff_passed` and
  `scheduling.fee_acceptance_required` both read as "too close to the start time to change online, please call the clinic". No fee or
  amount is shown anywhere.
- **Times** are in the place's zone with the zone label; a video visit shows both zones when they differ. Routes carry opaque ids; tab titles
  are "Patient portal - <screen>" (UX-R4). Nothing is written to storage.
- **Add to calendar** builds the `.ics` in the browser (RFC 5545, CRLF, UTC, `SUMMARY:Appointment`, no service or doctor name, BR-23), so it works
  whether or not `GET /appointments/{id}/calendar.ics` is mounted.

## Assumptions about the API (contract bodies are opaque; checked in `types.ts`, a malformed answer is a server-error state)

1. `GET /services` items `{id, patientDisplayName, durationMin, mode}`; `GET /locations` items `{id, name, timeZone}`; `GET /clinicians` as in the contract.
   (Taken from the organisation directory views, migration 0302. The routes are not mounted in `apps/api` yet; `catalog-lists.requested.patch` is pending.)
2. The patient cannot read the booking policy (cut-off hours, late-change mode). The sentence therefore names no number unless the app passes
   `policy={{ cutoffHours }}` to `BookingRoutes`. **Open item for the Architect:** a patient-readable policy field.
3. There is no read for a waitlist offer, so PP-19 knows only the offer id and, if the notification link carries it, `expires`. **Open item
   for the Architect:** an offer read `{startsAt, expiresAt, ...}`. The countdown there uses the device clock (no server time available).
4. `POST /waitlist-entries` body is sent as `{patientId, serviceId, locationId?, clinicianId?, from, to}` (PostWaitlistEntriesRequest; window [from, to) = now to now+90 days).
5. `GET /patients/{id}/appointments?status=confirmed&from=now` returns `{items}` of `AppointmentView` (as `apps/api` scheduling core).
6. There is no release route for a hold, so choosing a second time leaves the first hold to expire; if the same patient's active hold overlaps
   the new time the API may answer `scheduling.overlapping_appointment` (shown in plain language). To confirm against the real API.

## Not proven here

- No real API or database: PostgreSQL 17 and the API are not available in this workspace, and the waitlist, calendar and catalogue routes do
  not exist in `apps/api` yet. All checks use a labelled contract mock. "Works against the real API" is **not** claimed.
- The "booking race" is shown from the patient's side (a mocked 409). The real two-session race needs the integrated stack (INT-02).
