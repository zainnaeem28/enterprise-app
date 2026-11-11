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
