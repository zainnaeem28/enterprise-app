# scheduling / availability (BE-12)

Owner: Backend Engineer. Migrations `1100`-`1103`. Design: ARCHITECTURE 22.8, 22.5.1, 29.2-29.4, 35.2; PRD F-DR-01, RA-R1-23, RA-R1-04, BR-02;
tests TC-DR-01..03, TC-BK-03/04/10 (data half). The booking core (holds, confirm, cancel) is BE-11; calendar sync (the writer of busy time) is BE-14.

| Piece                                                                                                                                                               | Where           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| Tables `availability_template`, `template_rule`, `blocked_time`, `busy_block`, `roster_entry` (constraints: composite rule FK, `[)` period shape, roster exclusion) | `1100`          |
| Triggers: `row_version`, a template keeps its doctor and a retired one stays retired, blocked time and roster keep their owner                                      | `1101`          |
| `FORCE` RLS, T-CONF-STAFF(own) and (loc) policies, least-privilege column grants                                                                                    | `1102`          |
| `scheduling.public_clinician_location` (ninth C0 directory view), T-DIRECTORY policy, `directory_ro` column grants                                                  | `1103`          |
| `AvailabilitySearch`: `POST /availability/search`, and the `AvailabilityPort` the booking core asks (`resolve`, `alternatives`)                                     | `search.ts`     |
| `AvailabilityService`: templates, leave and blocked time (with the conflict report), roster, `directoryClinicianLocations`                                          | `service.ts`    |
| Routes: staff (29.3) and admin (29.4) management routes, the shared search route                                                                                    | `controller.ts` |

## How the acceptance holds

- **Slot search = template - bookings - busy - blocked time.** Four reads (35.2): one statement expands templates x rules x location time zone per local date
  (`(date + time) AT TIME ZONE zone`, so daylight saving is PostgreSQL's, TC-BK-10), then occupancy, busy blocks and blocked times. A slot is offered when it lies in a
  window on the service's grid (multiples of `duration_min` from the window start), the doctor and the rule's room are free, and no busy block or blocked time touches it.
- **Stale busy data is never silent.** `calendar_stale_minutes` (G2 setting, read through the organisation module; a missing setting is `503 kernel.unavailable`, not a number
  in code). Busy rows are always used (the last known), and when any doctor in the answer has a last sync older than the threshold the answer carries
  `availabilityStale: true`. Fresh data, or no busy data at all, is not flagged.
- **Own-only (38.2 item 12).** On the staff routes `{id}` must be the session's principal: the handler writes the `denied` audit event and answers `403 auth.forbidden`;
  the service refuses again (`SchedulingScopeError`); the policy refuses a third time (a foreign row is neither insertable nor visible to update/delete). A front-desk
  lead edits the roster of their own locations only (the guard checks the location grant from the path; the policy requires `location_id = ANY(app.location_ids)`),
  and never `compliance_on_call` (policy `duty <> 'compliance_on_call'` for the google realm; the admin route sets it).
- **Leave and blocked time show what they affect before saving.** `POST /clinicians/{id}/blocked-times` counts the doctor's active appointments in the period (held and
  not lapsed, confirmed, checked in). With any and no `acknowledgeConflicts: true` the answer is `409 scheduling.conflicts_with_appointments` with counts only; `dryRun: true`
  reports the counts with `200` and saves nothing. Nothing is cancelled: the appointments keep their status. The count and the insert run under the doctor's `dr:` lock
  (25.2), and `AvailabilitySearch.resolve` takes the same lock before it reads, so a hold and a leave over one slot cannot both succeed (tests: two deterministic
  interleavings, which fail without the lock, and 20 racing rounds).

## Decisions and departures, for the reviewer

- **D1. Search route.** `POST /availability/search` is one path on two portals (29.2 patient, 29.3 `scheduling.availability.search`); the framework has one handler per path
  and the guard derives the realm from the permission (same constraint as BE-11 O-1). It is declared `{permission: public, resolver: session, realm: none}` (any session)
  and the handler admits a patient-realm session or a google-realm session holding the permission; any other session is `403`, no session `401`.
- **D2. Slot grid and buffers.** The grid step is the service's `duration_min`. `buffer_min` is **not applied**: a patient transaction cannot read it (22.5.1 does not grant it,
  organisation README N-BE03-4), and one grid must serve both audiences. Needs an Architect decision (expose it, or fold it into the directory view).
- **D3. `includeOverbook` (staff only), as ruled in HEAAA-632 D-F11-T1.** A slot is offered when no row of the doctor overlaps it and no other clinician holds its room. In an
  overbookable rule with a stored cap of 2 or more, staff with `includeOverbook: true` also get a slot that already holds 1 to cap-1 bookings, flagged `overbook: true`; a full slot
  is not offered and does not hide the other slots of the window; patients never get an occupied slot and a patient who sends the flag gets `422`. `resolve` (hold) answers with an
  overbook row for every booking of such a window, the first included (key `ruleId:slotStart`, traceability only), so the cap is the total in the slot. A cap of 0 or 1 means no
  overbooking. The database decides: `scheduling.occupy` and `guard_overbook_origin` (0905) count by overlap.
- **D4. Busy-block freshness** is derived from `busy_block.synced_at` (the doctor's latest row). `calendar_sync.calendar_link.last_synced_at` does not exist yet; BE-14 should supply
  the freshness of a linked calendar that has no rows, otherwise a linked doctor with an empty calendar is never flagged.
- **D5. `busy_block` has no writer here.** The design names `scheduling.replaceBusyBlocks` (worker); it belongs to calendar-sync (BE-14), which also grants its function owner
  the write rights. No application role can write the table in `1102`; tests seed it as superuser.
- **D6. `blocked_time` and `busy_block` are readable by the patient audience** (T-CONF read, 21.4), because slot search runs in the caller's own transaction. The API never returns
  `kind`, `note` or any busy detail to a patient (tested), but the `note` column (<= 200 characters, "no patient data") is reachable by a patient-audience SQL path. If the Security
  Reviewer wants that closed, the alternative is a definer search function (a new inventory entry); not done without that decision.
- **D7. Room.** A template rule's `room_id` makes the room a constraint of the offered slots (busy through occupancy rows); the port has no channel to return the room to the hold, so a
  patient hold carries no room (assigned by the clinic, BE-13 `PUT /appointments/{id}/assignment`).
- **D8. Addition to 22.8.** `template_rule` has an `id` (a template is replaced by deleting and inserting its rules). `DELETE /availability-templates/{id}` **retires** the template
  (status `retired`, history kept, the next search stops using it). `PUT` and `DELETE` need `If-Match`.
- **D9. Limits.** A search returns the earliest 2,000 slots. Holidays and `opening_hours` are not applied (the template is the authority, 22.8). Cross-location overlap of one
  doctor's templates is not refused (the occupancy exclusion constraint is per doctor, so no double booking), same-location overlaps are (`422 kernel.validation_failed`).
- **D10. Audit.** Template, blocked-time and roster changes are `config_change` events with ids and counts; a leave's note and kind of leave never enter the audit change.

## Tests (real PostgreSQL 17, superuser URL on a throwaway server, synthetic data; missing configuration fails)

```
EHR_TEST_ADMIN_URL=postgres://postgres@host:5432/postgres \
  node --test apps/api/dist/src/modules/scheduling/availability/availability.dbtest.js \
              apps/api/dist/src/modules/scheduling/availability/search.dbtest.js
node packages/kernel/dist/scope/check-static.js --skip with-scope.ts apps/api/src/modules/scheduling   # 38.2 item 4
```

`availability.dbtest.ts`: templates over HTTP (If-Match, idempotency replay, validation, retire), own-only 403 + audit + unchanged rows, the policies by direct SQL, the conflict
report (TC-DR-02), roster (lead, location, compliance, eligibility), admin routes, constraints and triggers, `busy_block` write rights, the directory view.
`search.dbtest.ts`: the four subtractions (TC-DR-01), grid and rule restrictions, template change in the next search, validity, who is offered, daylight saving (TC-BK-10), input
limits, who may search, stale busy data and the setting, the port (`outside_hours`, `slot_taken` with alternatives from the same search), overbookable sessions, lead time, the
leave/hold race, and an informational latency measurement.

## Open items for the Orchestrator and other owners

- **O-1. `db/tools/catalog-lists.mjs`** (closed): the view `scheduling.public_clinician_location` and the T-DIRECTORY policy `availability_template_directory` are in the lists
  (`catalog-lists.requested.patch` is kept as the record).
- **O-2. Composition** (closed): `AvailabilitySearch`, `createAvailabilityControllers` and `availabilityResolvers()` are composed in `apps/api/src/composition.ts`.
- **O-3. Architect decisions** recorded above: D2 (buffer), D3 (overbook reading), D6 (patient read of `blocked_time.note`).
