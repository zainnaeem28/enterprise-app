# HEAAA-797 evidence (C-FE-SCREENS)

Checks run locally on the branch head (no hosted CI, owner ruling B):
- `pnpm lint`: 0 errors (46 existing warnings)
- patient and staff: `typecheck`, `test`, `build`, `bundle-budget`, `test:a11y:jsdom`: pass
- Not run: Playwright e2e/axe screenshots (no browser harness run for the new screens), integration-db, N-1 upgrade, SAST, dependency audit, secret scan (not run: no hosted CI, owner ruling B).

Mapping:
- Patient proxy invite, per-scope grants, revoke, leave, 30-day age-out notice, verification code screen: `apps/patient/src/features/profile/profile.test.tsx`
- Patient post-deletion statement: `apps/patient/src/features/privacy/privacy.test.tsx`
- Booking telehealth refusal: `apps/patient/src/features/booking/flow.test.tsx`; join refusal: existing `telehealth.test.tsx`
- Staff guardian link, document check, revoke: `apps/staff/src/features/guardians/guardians.test.tsx`
- Admin licensed-states editor: `apps/staff/src/features/admin-config/licensing.test.tsx`

Limitation: the API does not tell a proxy their own grant id (no route exposes `listMine`; the session carries no `grantId`), so the "Leave" button shows only when the session supplies `grantId`. Needs a backend change.

## Review round 1 corrections (FE-797-F1, F3)

- F1: axe-core (wcag2a/aa, 2.1, 2.2 AA, best-practice; jsdom, so colour-contrast and target-size are not covered) now runs in the component tests for the family page (list, scope editor, invitation, age-out notice, remove and leave dialogs), the accept-code screen (refusal and success), the post-deletion statement, and the staff GuardianPanel (list, validation errors, server refusal, revoke dialog). All pass with no violations. Helper: `src/axe-helper.ts` in each app.
- F3: the flaky test is `PP-10..PP-14 book a visit > walks service, doctor and place, time, confirm and booked...` (patient `booking/flow.test.tsx`, existing on dev): it read `document.title` synchronously after the async confirm. Reproduced once in 6 runs under CPU load; now awaited with `waitFor`; 0 failures in 6 loaded reruns afterwards.
- F2 (no `grantId` for a proxy) is unchanged here: it needs a backend/contract change, routed to the Orchestrator.
