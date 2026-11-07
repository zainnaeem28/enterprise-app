# INT-02 r7 — API composition root (INT02-R6-B1)

`apps/api/src/composition.ts` `buildComposition` now mounts, and `main.ts` uses it with the identity guard policy (no more `DenyUntilIdentityPolicy`): identity (`/api/v1/auth/sign-in|callback|session|session/extend`), catalogue (`services`, `locations`), **new** patient-readable `GET /api/v1/clinicians` (`apps/api/src/clinicians.controller.ts`), availability (search + staff/admin management), booking core (holds, confirm, appointments), flow (check-in, queue, waitlist, pre-visit). The patient module's own controllers are not mounted (out of scope); its scope contributor/records are wired because the guard and the flow need them.

## Configuration (environment; nothing committed)
Required: `EHR_ORGANISATION_ID`, `EHR_STAFF_HOST`, `EHR_PATIENT_HOST`, `EHR_ALLOWED_ORIGINS` (comma list), secrets (>= 32 chars) `EHR_OIDC_STATE_KEY`, `EHR_CSRF_KEY`, `EHR_RATE_KEY`, `EHR_MATCH_CHECK_KEY`, `EHR_CHECKIN_QR_KEY`; staff realm `EHR_STAFF_OIDC_{CLIENT_ID,CLIENT_SECRET,REDIRECT_URI}`, `EHR_STAFF_WORKSPACE_DOMAIN` (endpoints `EHR_STAFF_OIDC_{ISSUER,AUTHORIZATION_ENDPOINT,TOKEN_ENDPOINT,JWKS_URI}` default to Google); patient realm `EHR_PATIENT_OIDC_{ISSUER,AUTHORIZATION_ENDPOINT,TOKEN_ENDPOINT,JWKS_URI,CLIENT_ID,REDIRECT_URI}` and optional `EHR_PATIENT_OIDC_CLIENT_SECRET`. A bad variable stops the start and is reported by name.

## CI fixture IdP
`node scripts/ci/local-idp.mjs [port]` (after `pnpm build`) runs the local OIDC conformance IdP as a separate process and prints its endpoints; point the `*_OIDC_*` variables at it and generate the keys per run. The API process is the real `main.js`.

## Limits
Full booking (seeded clinician/template through hold -> confirm) is not covered by the new test; the browser journey is not re-run here (Integrator).
