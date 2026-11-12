# Tasks & messages (FE-12, HEAAA-131)

Staff screen DR-08 of UI-UX 4 (staff side of PP-37). Entry point: `MessagesPortal` (`index.ts`), one component for the path `/tasks` (the
"Tasks & messages" navigation item already points there), two tabs: **Tasks** and **Secure messages**. Permissions only decide what is drawn
(`messaging.task.manage`, `messaging.thread.staff`); the server authorizes every call and applies participant, assignee and organisation rules.

**Review base.** `5e0675b` (FE-11 branch, which contains FE-08). The BE-19 contract `messaging.yaml` is the one on its branch (`c56f76d`); BE-19, FE-08
and FE-11 are not on `main` yet. The FE-12 change is `git diff 5e0675b -- apps/staff/src/features/messages`; nothing outside that folder is edited.

## Acceptance map

| Acceptance                   | Where it holds                                                                                                                                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create tasks                 | `Tasks.tsx` `NewTask`: title, details, due, assign to me or to a role at a location. `POST /tasks` with one `Idempotency-Key` per attempt (renewed on any edit).                                            |
| Complete tasks               | `Tasks.tsx`: "Mark done" sends `PATCH /tasks/{id}` `{status:'done'}` with `If-Match` of the version held; 412/428 are explained and the list reloads.                                                       |
| Send secure staff messages   | `Threads.tsx` `NewThread` (`POST /threads`) and reply (`POST /threads/{id}/messages`), both idempotent; closed threads are read-only.                                                                       |
| Thread list and thread views | `Threads.tsx` list-detail: list and thread side by side from 56 rem, one at a time below with a Back button; focus moves to the thread heading on open; `aria-current` marks the open row (`messages.css`). |

State catalogue (UI-UX 6): loading, empty, 403 permission note, 404/429/5xx in words with reference code, validation with an error summary that takes focus,
idempotent retry, offline banner with writes disabled. No passive polling (refresh is a button), so the idle clock is not extended.

## Limitations and open points (not hidden)

1. **Wired into the staff app.** `StaffApp.tsx` renders `<MessagesPortal runtime={runtime} />` for `isMessagesPath(path)`; front desk, care coordination and doctor navigation offer "Tasks & messages".
2. **No staff directory.** BE-19 takes participants as principal identifiers and the contract has no endpoint that lists colleagues for a non-admin. The new-message form therefore
   asks for staff identifiers (validated as UUIDs) and says so. Request to Architect/PM: a staff lookup route (name, role, location) for the recipient picker. Authors are shown as "You" / "A colleague" for the same reason.
3. **Task assignee** to a single named colleague is not offered for the same reason; "me" and "a role at a location" are. Cancelling a task (creator only) and editing an open task are not built (not in the acceptance).
4. **Contract is opaque** (`OpaqueObject` request and response bodies); the calls go through the untyped seam other staff features use, with shapes read from the BE-19 controller and types. Recorded for the Architect.
5. **Browser checks not run.** This sandbox cannot start Chromium (system libraries such as libglib are missing, no root). The Playwright spec and harness (`e2e/`) are written and typechecked but have NOT been executed, so there are
   no candidate screenshots, no contrast/target-size axe results and no 320 px reflow result. axe-core ran in jsdom (WCAG 2.x A/AA and best-practice rules except contrast and region).
6. Contract mocks only: no real API, database or auth was exercised.
