# scheduling / core (BE-11)

The booking core: PHI-free slot occupancy, reservations (holds and appointments), hold, confirm, release, cancel, reschedule, the
expiry sweep, the per-patient overlap rule, the merge participant and the privacy export part. Migrations `0900`-`0903`.
Availability (templates, leave, slot search), check-in, queue, waitlist, calendar sync and telehealth are other tickets (BE-12..BE-15).

| Piece | Where |
| --- | --- |
| Tables `scheduling.slot_occupancy` (C1, no patient) and `scheduling.slot_reservation` (C2), exclusion constraints on doctor and room, the deferred twin foreign keys (both directions), ST-01 transition trigger, terminal-reservation trigger, merge write guard | `0900`, `0901` |
| `FORCE` RLS, role-targeted policies (T-PAT-APPT, T-STAFF, T-ADMIN-BTG, T-SYS), least-privilege grants | `0902` |
| Definer functions `scheduling.occupy`, `set_status`, `expire_holds` (owner `scheduling_booking_owner`) | `0903` |
| Service: hold, confirm, cancel, reschedule, release, sweep | `service.ts` |
| Patient-portal routes (29.2): `POST /holds`, `POST /appointments/{id}/confirm|cancel|reschedule`, `GET /appointments/{id}`, `GET /patients/{id}/appointments` | `controller.ts` |
| Merge participant `scheduling.repointPatient` and `scheduling.exportPart`, registered with the F-04 registries | `merge.ts` |
| Job type `scheduling.expire_holds` and the events published | `jobs.ts` |

## Tests (real PostgreSQL 17, superuser URL on a throwaway server, synthetic data; missing configuration fails)

```
EHR_TEST_ADMIN_URL=postgres://postgres@host:5432/postgres \
  node --test apps/api/dist/src/modules/scheduling/core/booking.dbtest.js \
              apps/api/dist/src/modules/scheduling/core/concurrency.dbtest.js
node packages/kernel/dist/scope/check-static.js --skip with-scope.ts apps/api/src/modules/scheduling   # 38.2 item 4
```

`booking.dbtest.ts`: constraints, stale-hold expiry for doctor and room, the twin, terminal reservations, hold / confirm / release,
BR-04, the overlap rule, licensing (TL-1), cancel and reschedule with the cut-off and fee behaviour, RLS (TC-BK-11, 18), the HTTP routes
(TC-BK-01, 04, 09). `concurrency.dbtest.ts`: TC-BK-13..17, the overlap race (38.2 item 15, also with the waitlist job), the merge
participant (38.2 item 11) and the confirm-versus-merge races (38.2 item 1), all on 40 real connections.

## How the invariant holds

* **No double booking** is the database's: `EXCLUDE USING gist (clinician_principal_id WITH =, period WITH &&) WHERE (active status AND NOT
  overbook)`, and the same for a room. `scheduling.occupy` first marks the overlapping stale holds of the doctor and of the room as
  expired (locked in id order, so racing callers wait for each other), then inserts; `23P01` is `409 scheduling.slot_taken`.
* **Overbookable sessions**: every row of an overbookable session is flagged `overbook` and is counted under
  `pg_advisory_xact_lock(hashtext('ob:' || doctor || session_key))` against `overbook_cap_per_session` (the API reads it from the booking
  policy and passes it; a cap of 0 refuses). The cap is the number of appointments in the session (TC-BK-15: cap 2, exactly 2).
* **Lock order (25.2)**: `lockPatients` once at the start (`key_share` for hold and cancel, `no_key_update` where `ensure_care_relationship`
  runs: confirm, reschedule), then `pg_advisory_xact_lock('pt:' || patient)`, then the doctor and room locks (`dr:` / `rm:`, sorted keys),
  then `ob:`, then the occupancy insert.
* **Doctor and room locks (BE11-F01)**: two concurrent writers into a GiST exclusion constraint wait for each other's uncommitted rows and
  deadlock (`40P01`); the victim can be the one that would have won (seen with 100 different patients: a confirm's `held -> confirmed`
  update waiting on a loser's insert, and the loser on the update). `scheduling.occupy`, and `scheduling.set_status` for any move that stays
  inside the constraints' predicate, take `pg_advisory_xact_lock` on `dr:<doctor>` and `rm:<room>` in sorted order first, so these writers
  of one doctor's or room's time run one after the other. The constraints stay the authority; the lock only removes the deadlock.
  Regression: `concurrency.dbtest.ts` "BE11-F01 regression" (20 rounds x 100 patients).
* **Same-patient overlap (BQ-9)** and BR-04 are checked under the `pt:` lock, so two concurrent holds for one patient serialise; the second
  sees the first and gets `422 scheduling.overlapping_appointment`. If the very slot asked for is already someone's, the answer is
  `409 scheduling.slot_taken` with alternatives (TC-BK-13).
* **Cancel** writes the reservation's `cancel_reason` and `late_change` first and the occupancy status second (N-2); reschedule and no-show
  write no field of the old reservation. Fee behaviour is block-only by default (D-3); `fee` is stored and never charged.
* **Version / ETag** of an appointment is the sum of the reservation's and the occupancy's `row_version` (a status change bumps only the
  occupancy row, so the reservation's own version alone would miss it).

## Departures from the design, for the reviewer (each is small and additive)

* **D1. Merge write guard.** `patient.guard_open_patient` is owned by `patient_scope_owner` with `EXECUTE` revoked from `PUBLIC`, so the
  migration role cannot attach it to a later module's table. `0901` carries `scheduling.guard_open_patient`, the same refusal (42501 outside
  a patient/staff/system context, `PM008` unknown patient, `PM001` merged) under the same name (the M-5 check looks for the name), reading
  the root's `id, organisation_id, status` as `scheduling_booking_owner` through one narrow policy (`0902`). It takes no lock of its own:
  the booking transaction holds the root lock from `lockPatients`, and the foreign key takes `FOR KEY SHARE`. **Request to the
  Orchestrator**: `GRANT EXECUTE ON FUNCTION patient.guard_open_patient() TO app_owner` in the patient range, after which `0901` can use the
  original; or accept the copy. The four definer functions need the inventory entry in `catalog-lists.requested.patch` (this ticket may not
  edit `db/tools`).
* **D2. Twin in both directions.** 22.8 names the deferred key occupancy -> reservation; `slot_reservation.id` also references the occupancy
  (deferred), and a deferred constraint trigger checks that the two agree on organisation, location, clinician and booker.
* **D3. Occupied period** is the service's `duration_min`. The buffer between visits belongs to the slot grid the availability module offers
  (a patient cannot read `service.buffer_min`: only the directory view is open to them, 22.5.1).
* **D4. Availability port.** The core asks `AvailabilityPort` (BE-12) whether a start time is on the template (`scheduling.outside_hours`),
  whether the session is overbookable, and for alternatives. It has no default: without a resolver no hold is possible. `nearbyFreeStarts` is
  exported as a generic alternatives helper.
* **D5. Alternatives in the error body.** The error body has no member for data, so alternatives travel as `errors` entries
  `{path: '/alternatives/<n>', code: <ISO start>}`, the same device `patient.merged` uses for the survivor ID.
* **D6. Waitlist hold.** `app_worker` has an `INSERT` policy on `slot_reservation` for a patients-scope job for exactly that patient and
  `booked_via = 'waitlist'`; the job names the patient's own principal as the booker. BE-13 supplies the job.
* **D7. `overlaps_after_merge`** is written as an audit row (`action merge`, resource `scheduling.slot_reservation`) because the merge counts
  object is keyed by table and owned by the patient module.

## Open items for the Orchestrator and other owners

* **O-1. Staff routes (29.3).** `POST /holds` and `POST /appointments/{id}/confirm|cancel|reschedule` exist on both portals with different
  permissions (`proxy` vs `scheduling.booking.manage`). The guard derives a route's realm from its permission and the framework has one
  handler per path, so only the patient-portal declarations are mounted here. The service is realm-neutral and is tested for staff
  (`bookedVia = staff`, `cancelled_clinic`, location-bound insert); mounting the staff paths needs a guard decision (Architect / BE-04).
* **O-2. Worker handler** for `scheduling.expire_holds` (`SchedulingCoreService.sweepExpired`) and its crontab entry are the worker's
  (outside this ticket's paths). Register `SCHEDULING_CORE_JOBS`, `registerSchedulingParticipants()` and `schedulingResolvers()` at
  composition (see `index.ts`).
* **O-3. BE-08 policy predicate (finding for the Orchestrator, not fixed here).** The BE-08 staff policies are written
  `... WHERE s.patient_id = patient_id AND ...` inside `EXISTS (SELECT 1 FROM patient.staff_scope s ...)`; an unqualified `patient_id` inside
  that sub-query resolves to `s.patient_id`, so the comparison is always true and the predicate degrades to "the staff member's locations care
  for any patient". The booking policies of this ticket qualify the outer column (`slot_reservation.patient_id`); see the test
  "staff book only at their own locations" and the cross-patient assertions in `booking.dbtest.ts`.
* **O-4. Release/ledger.** Review state, rounds and findings are in the `review-ledger` document of HEAAA-90.
