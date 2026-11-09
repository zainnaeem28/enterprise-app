# admin-config (FE-14, HEAAA-134)

Administrator-realm configuration screens: **AD-04 clinics** (locations, rooms, opening hours, holidays), **AD-06 services** (neutral patient-facing name for
condition-revealing services), **AD-07 booking policies** (block-only late changes), **AD-08 templates** (consent and questionnaire versions, draft then publish),
**AD-09 integrations** (health, connection test, write-only secrets), **AD-10 flags & banners**, and **vital ranges**.
Design: UI-UX 4; PRD RA-R1-15, RA-R1-26, RA-R1-31. Built on FE-17 (`../admin-auth`) and the BE-23 routes (`apps/api/src/modules/organisation/admin`).

- Entry: `AdminConfigPortal({ runtime, path, navigate })`, paths `/admin/clinics|services|policies|templates|integrations|flags|vital-ranges`; render inside FE-17's `ElevationProvider` under `AdminRealmBar`.
- Every route here requires an elevation grant (BE-23 `elevation: true`), reads included. Each call runs through `callPrivileged`; cancelling the key dialog sends nothing and keeps the form.
- The server authorizes and audits every change. The UI repeats the rules it can (neutral name, banner PHI guard, hours order, bounds, secret-name pattern) so a person is not sent to the server for an obvious slip.
- PATCH sends `If-Match` from the row's `rowVersion`; a `412` reloads the list. Removal is the in-band `remove: true` of BE-23 (no DELETE in the contract), after a confirmation step.
- **Secrets are write-only.** The value is typed into a password field, sent once in the PUT body, cleared from state as soon as the request is sent (success or refusal), never put in an error, and the answer (`versionId`) never carries it. Tests assert it is absent from the DOM.
- `patient_messaging` cannot be turned on (INT03-F17 1(c)): the button and option are disabled with the reason, and the server's `400` is still translated if it arrives.
- Late changes: only "block" is offered; a stored `fee` is shown as "stored only, never charged" (D-3).

## Not done here / needs the Orchestrator

1. **Wiring.** `StaffApp.tsx` and navigation are outside this ticket's allowed path. INT-04 must route `isAdminConfigPath(path)` to `AdminConfigPortal` in the admin realm.
2. **Opaque contracts.** `GET /admin/integrations` and `GET /admin/vital-ranges` return `OpaqueObject` rows, and there is no BE implementation of the integrations admin routes yet (integration-core INT-N2: routes not built). Row shapes used (`id, kind, vendor, enabled, health, lastTestAt`; `loincCode, unit, sex, ageYears, low, high, status`) are the connection record and ARCHITECTURE 22.11 columns, not a proven wire format. `parseIntegration`/`parseVitalRange` also accept the age band as text `[18,65)`.
3. **Integration settings edit** (`PATCH /admin/integrations/{id}`: vendor, enabled, non-secret settings) has no request schema in the contract, so it is not built; health, test and secrets are. Inbound-secret requests (two-person) belong to the identity/second-approver flow and are not here.
4. **Message templates and alert settings** are notifications routes (`notifications.template.manage`), not BE-23; not built. Settings and operating states (BE-23) have no screen in this ticket's brief.
5. **Location address** (`json`) has no editor; locations are managed by name, kind, zone, state, phone, active.
6. **Mocks.** Unit and browser tests run against contract mocks; the real API/database journey and the physical security key are not exercised here.
