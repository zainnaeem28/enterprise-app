# Patient portal: pre-visit forms, consents, insurance, waiting room, device check and join (FE-07, HEAAA-128)

Screens PP-25, PP-26, PP-27 and PP-22 (folder `previsit/`), PP-21 and PP-23 (folder `telehealth/`). UI-UX 4 J-06, J-07, J-08.

| Screen                                                  | Where                                  | Route                                      |
| ------------------------------------------------------- | -------------------------------------- | ------------------------------------------ |
| Status of the three items (To do / Done / Needs fixing) | `previsit/pages/HubPage.tsx`           | `/appointments/:id/previsit`               |
| PP-25 Questionnaire (save for later, submit)            | `previsit/pages/QuestionnairePage.tsx` | `/appointments/:id/previsit/questionnaire` |
| PP-26 Consents to read and e-sign                       | `previsit/pages/ConsentsPage.tsx`      | `/appointments/:id/previsit/consents`      |
| PP-27 Insurance card front/back with scan state         | `previsit/pages/InsurancePage.tsx`     | `/appointments/:id/previsit/insurance`     |
| PP-22 Emergency advice (red flag)                       | `previsit/pages/EmergencyPage.tsx`     | `/appointments/:id/previsit/emergency`     |
| PP-23 Device check, location, join; PP-21 waiting room  | `telehealth/JoinPage.tsx`              | `/appointments/:id/video`                  |

## Mounting (needs an edit outside this ticket's allowed paths)

`apps/patient/src/app/App.tsx` is outside the allowed paths, so the routes are not mounted. Add, before the final `else`:

```tsx
} else if (isPrevisitPath(location.path)) {
  page = <PrevisitRoutes runtime={runtime} path={location.path} go={go} />;
} else if (isTelehealthPath(location.path)) {
  page = <TelehealthRoutes runtime={runtime} path={location.path} onGrant={startVideo} />;
}
```

`onGrant` is the video client's entry point (vendor not chosen, C-11). Without it the page says the video app is not connected. Link to
`previsitPath(id)` and `videoPath(id)` from the appointment screens (FE-04, outside these paths).

## How it follows the acceptance

- **Per-item status.** Questionnaire, consents and insurance each show text + icon + colour: To do, Done, Needs fixing (rejected card file, outdated consent).
- **Consent gate.** While `previsit.consents` is false the hub and the consents page say "Your consultation cannot start yet". The gate itself is the server's (`409 clinical.consents_missing`); this UI does not open or close it.
- **Red flag.** A submit that answers `redFlag: true` opens PP-22 with the advice text the template supplied, and a `tel:` call link. The advice is kept in memory only. The wording shown when no advice text is present is a **placeholder pending the clinical safety reviewer (D-12a, C-03)**.
- **Both time zones** are shown when the clinic's zone and the browser's differ; one label otherwise. **Location confirmation** (state, TL-1) is required before Join; a `licensing_refused` answer offers no way around it. The server re-checks the rule at every join.
- **Waiting room.** Join enters it (`409 telehealth.not_admitted`); the page polls the passive status every 5 s and asks again for the credential once admitted. The credential goes only to `onGrant`; it is never rendered, stored, logged or put in a URL.
- **Questionnaire.** A blank required question is never sent as "no"; the summary names questions, never values. "Save and continue later" uses the draft route (client-named response id, no `If-Match` the first time); the open form registers with the shell's release store so a new-version prompt can offer "Save and reload" (UI-UX 7.7). Nothing is written to browser storage.

## Assumptions about the API (bodies are opaque in the contract) and open items

1. **`GET /appointments/{id}/previsit` returns three booleans only** (`apps/api` `previsitFor`), although the contract text says it carries the questionnaire, required consents and their status. This UI reads an optional `requiredConsents: [{id, templateKey, title, text, status}]` and, when it is absent, says the consent text cannot be shown here and offers no signing. **Needs the Architect/Backend:** a patient route that lists the required consents with their text and pending consent id (no patient route does today: `GET /patients/{id}/consents` is staff-only and nothing creates the pending row for a patient; BE-08 `requestConsent` has no route). Until then PP-26 cannot be exercised against the real API.
2. **`GET /appointments/{id}/questionnaire` is served but is not in the OpenAPI contract**; it is called through an untyped view of the shell's client. **Needs the contract owner** to add it. Question shape assumed: `schema.questions[{id,label|text,type: yesno|boolean|choice|number|text,options?,required?}]`; a question is required unless `required:false`.
3. **Emergency advice shape:** `advice` as a string or `{text}`.
4. **Insurance:** coverage body uses `payerName`, `memberId`, `groupNumber`, `frontDocumentId`, `backDocumentId` (from `PatientRecordsService.coverageInput`). The documents API has no version in its list answer (FE06-F01), unchanged here.
5. **Documents module import.** `@ehr/app-shell` does not export the documents module and its entry file is outside these paths, so `previsit/documents.ts` imports it by path, as the staff app does.
6. **Device check:** camera and microphone are tested by asking the browser; bandwidth uses `navigator.connection.downlink` when the browser has it and is reported as **not working** when it does not (never as good). It is an estimate, not a measurement. A failed check does not stop Join (the server does not require a pass).
7. **State list** is every US state and DC; which are operating states is the server's decision (D-2 placeholder, UX-O-04, C-06).
8. **Branch base.** This worktree started from `main`, which has none of the prerequisite code; the FE-05 (includes FE-04, FE-06, BE-18) and BE-15 branches were merged into it locally so there was something to build on. The Integrator should integrate the prerequisites in their own order; this ticket's own change is only the two new folders.

## Checks and what they do not prove

```
cd apps/patient
NODE_ENV=test pnpm exec vitest run src/features/previsit src/features/telehealth   # 31 tests, CONTRACT MOCK; axe-core 4.14.0 in jsdom
pnpm exec tsc -p tsconfig.json --noEmit
pnpm exec eslint src/features/previsit src/features/telehealth
```

**No real API, database, authentication, object store, malware scan or video vendor was exercised.** TC-TH-01..05 need the video sandbox and stay **BLOCKED** (C-10, C-11). jsdom applies no CSS, so colour contrast and target size are **not checked**, and **no candidate screenshots exist**: the Playwright browser could not be downloaded in this environment. `evidence/` holds the unit JUnit and JSON reports.
