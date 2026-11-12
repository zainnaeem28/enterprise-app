# Patient portal: profile, proxies, notification preferences, privacy, messages (FE-05, HEAAA-127)

Screens PP-06..PP-09, PP-24, PP-35..PP-37 (UI-UX 4 J-03, J-21 and the profile and settings row). Code is under three folders; the shared
call guard, error states and hooks live in `profile/lib` and are imported by the other two.

| Screen                                                         | Where                                         | Route                                         |
| -------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------- |
| PP-35 Profile and contact details                              | `profile/pages/ProfilePage.tsx`               | `/profile`                                    |
| PP-36 Notification preferences                                 | `profile/pages/NotificationsPage.tsx`         | `/profile/notifications`                      |
| PP-06 Family and proxy list, PP-08 status, PP-09 switch person | `profile/pages/FamilyPage.tsx` (`PersonChip`) | `/family`                                     |
| PP-07 Link a family member (request)                           | `profile/pages/AddProxyPage.tsx`              | `/family/add`                                 |
| PP-24 My privacy                                               | `privacy/PrivacyPage.tsx`                     | `/privacy`                                    |
| PP-37 Messages (flag `patient_messaging`, D-5)                 | `messages/MessagesRoutes.tsx`                 | `/messages`, `/messages/new`, `/messages/:id` |

## Mounting (needs an edit outside this ticket's allowed paths)

`apps/patient/src/app/App.tsx` is outside the allowed paths, so the three route sets are not mounted yet. The app needs:

```tsx
import { isProfilePath, ProfileRoutes } from '../features/profile/index.js';
import { isPrivacyPath, PrivacyRoutes } from '../features/privacy/index.js';
import { isMessagesPath, MessagesRoutes } from '../features/messages/index.js';
// in App(), before the existing `else` branches:
} else if (isProfilePath(location.path)) {
  page = <ProfileRoutes runtime={runtime} path={location.path} go={go} />;
} else if (isPrivacyPath(location.path)) {
  page = <PrivacyRoutes runtime={runtime} path={location.path} />;
} else if (isMessagesPath(location.path)) {
  page = <MessagesRoutes runtime={runtime} path={location.path} go={go} />;
}
```

plus links to them from the landing page. Show the Messages link only when `GET /patients/{id}/threads` is not a 404 (the flag is off otherwise).
`PersonChip` (PP-09) is exported for the app header; to share the chosen person with the booking screens pass `activeId` and `onActiveChange`
to `ProfileRoutes`. Until then the screens run in their own harness (`e2e/harness`).

## How it follows the design and the acceptance

- **Profile edits are shown and audited.** Only the changed fields go in the `PATCH` (`If-Match` from the `ETag`); the page says which fields changed
  and that changes are recorded. The audit event is written by the server (RA-R1-19); this UI cannot show the audit log. Name and date of birth are
  shown, not editable here. A 412 shows "Someone changed this while you were editing" with what the patient typed kept in a side panel.
- **A proxy sees appointments only (D-7 default).** The family page states it in words, shows each link's status as text + icon + colour, and lists the
  people the account acts for as "Appointments only". An account with no record of its own (proxy only) gets a permission note on profile,
  preferences, privacy and messages, and none of those calls are made. Server authorisation stays authoritative.
- **Preferences cannot switch off safety-critical notices.** "In the patient portal" is shown checked and disabled with the sentence; every `PUT`
  contains `in_app` even if the form is emptied (unit tested). Whether security messages are exempt from e-mail/SMS choices is PM-confirm-3 (TC-NT-08),
  so the page promises the portal channel only.
- **Privacy and deletion requests record the request without promising deletion (D-8).** The deletion dialog and the status text say it records the
  request and "does not delete anything"; the status of a deletion request is "Recorded, waiting for a decision". A test fails if any wording says data
  will be or has been deleted. Download is offered only for a `fulfilled` export whose package is `ready` or `released`, and opens the 60-second URL.
- **States** (UI-UX 6): skeleton loading, empty, 403/404 identical wording, 412 conflict, 429 countdown, 5xx with the reference, validation summary that
  receives focus and never echoes values, double-submit guard, one idempotency key per create that a retry reuses.

## Assumptions about the API (bodies are opaque in the contract; checked in each `types.ts`, a malformed answer is a server-error state)

1. Shapes follow `apps/api` patient `profileBody`/`PreferenceView`/`ContactView`, identity `ProxyGrantView`, privacy `RequestView`, and the BE-19 branch's
   `ThreadView` (BE-19 is not a prerequisite and is not in this branch; messages were built against its source, unmerged).
2. **Preferences are channels, a reminder channel and quiet hours**, not one channel per message type (UI-UX 4 PP-36 text): that is what the API stores.
   **Open item for the Architect/Designer:** per-type preferences need an API change.
3. `POST /patients/{id}/proxy-requests` is sent `{relationship, email}` against the patient's own id, which is how `ProxyService.request` is
   shaped. The route answers `422 identity.proxy_rules_not_configured` only when a rule value is missing from the settings (D-7 is decided by delegation, ruling C); the page then says "not open yet, nothing was sent".
   **Open item:** who the path id names (the person asking or the person to link) when D-7 rules exist.
4. The session's `patients[]` carries no display name for a proxy's linked people (the type allows `displayName`, the route does not send it), so they
   read "Person 1", "Person 2" in the switcher. **Open item for BE-04.**
5. **Messages:** a patient thread needs `recipientPrincipalIds` and no patient route lists recipients (care team is staff only), and a reply on an existing
   thread is not served (BE-19 README O-2). So `/messages/new` is offered only when the app passes `recipientPrincipalIds`; otherwise it says writing is not
   available yet, and an open thread has no reply box. **Open items for the Architect (recipient source, patient reply route).**
6. Emergency contacts can be added and changed (`POST`/`PATCH /patients/{id}/contacts`); removing one is not built.

## Checks and what they do not prove

```
pnpm exec vitest run src/features/profile src/features/privacy src/features/messages        # 34 unit tests, CONTRACT MOCK
pnpm exec playwright test -c src/features/profile/e2e/playwright.config.ts                  # 16 = 8 flows x desktop/phone, axe on each screen
```

Both use a contract mock of the API. **No real API, database, authentication or feature-flag read was exercised** by these checks; the real combined
journey is for the Integrator. `evidence/` holds the Playwright JSON report, the unit JUnit report and the candidate screenshots (synthetic data only).
The app build and bundle budget do not include these screens until the mounting edit above is made.
