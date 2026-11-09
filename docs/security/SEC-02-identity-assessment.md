# SEC-02 Security assessment: identity, sessions, admin realm and secrets (code review)

Ticket HEAAA-135 (SEC-02) · release R1 · milestone M5 · author: Cybersecurity (`83cd0a46`) · reviewer stage: Security Reviewer (`074b2525`)
Requirement: RA-R1-32 (SEC-D-19 C1, C4, C6 evidence) · ARCHITECTURE 26, 8.4, 25.9 · SHARED-BOUNDARIES 7, 9.1 · TEST-CASES 5 · SEC-01 (B2-1..B2-11, SC-1..SC-8, O2-1..O2-9)

## 1. Scope, revision and method

**Assessed revision.** Commit `b74e1d87ac4b66e40bfb125309a437c44dc7b52c` (branch `HEAAA-134-...`, FE-14). It is the tip of the M5 stack and contains the two technical prerequisites as ancestors (checked with `git merge-base --is-ancestor`):
- BE-05 identity admin realm: `dabaca06b952664955c98d550dd811f5fe1b233f` (HEAAA-104, after its round 4 fix)
- BE-02 integration-core: `fa5956fd58e9c87859a731789a8db9636b1986e2` (HEAAA-80)

None of these commits is on `main`. There is no integrated release candidate yet (INT-04 is not done), so this is a review of module code, not of a running system.

**Method.** Static, read-only review with `git show`, `grep` and reading the files. Nothing was executed:
- **No tests were run.** I rely on the BE-05 and BE-02 review reports for their pass counts and did not reproduce them.
- **No active probing**, no scanner, no database, no network call, no real security key. No SAST, secret or dependency tool was configured for this ticket.
- **Not reviewed:** `@simplewebauthn/server` internals (exact-pinned 14.0.3, HEAAA-256); infrastructure controls SC-2, SC-3 (IAM, KMS policies, WAF log scrubbing), which belong to DevOps tickets; the C2/C3 directory checks (not built, see F-08 note).
- **No code changed.** The only file written is this document.

**Surfaces read.** `apps/api/src/modules/identity/` (`sessions.ts`, `tokens.ts`, `guard-policy.ts`, `auth.controller.ts`, `oidc.ts`, `oidc-state.ts`, `realms.ts`, `signin.ts`, and all of `admin/`: `ceremony.ts`, `service.ts`, `controller.ts`, `webauthn.ts`, `challenges.ts`, `claims.ts`, `decoy.ts`, `options-limiter.ts`, `elevation.ts`, `session.ts`, `handle.ts`, `b64.ts`, `index.ts`); migrations 2200, 2201, 2202, 2205; `apps/api/src/modules/integration-core/` (`secret-service.ts`, `secret-store.ts`, `canonical.ts`, `connections.ts`, `verifiers.ts`, `inbound.ts`, README); `apps/worker/src/jobs/integration-core/apply-secret.ts`; `apps/worker/src/jobs/identity/`; `apps/api/src/composition.ts`, `identity-env.ts`.

## 2. What holds (verified by reading the code)

1. **B2 sign-in order is right.** Per-IP limit first, shape check, challenge consumed in the first statement of the transaction (`UPDATE ... WHERE used_at IS NULL AND expires_at > now RETURNING`), claim read under `identity_signin_ro`, library verification, and only then `setAuthIdentity` and writes from the **verified** handle. A failed verification returns (not throws) so the burn commits. The challenge's `principal_id` must equal the credential's principal.
2. **Ceremony parameters match B2-2.** RP ID is the configured `staff.` host; exact origin list (regex-checked at start-up); `userVerification: required`; `residentKey: discouraged`; `cross-platform`; ES256 only; 32-byte CSPRNG challenge, 2 minutes, single use. Library errors become `ok:false`; no library text reaches a body. `none` attestation is refused; `chain` mode needs at least one root or the process will not start; `self_for_tests` cannot be selected by configuration.
3. **Enrolment (B2-3, B2-8).** AAGUID allow-list (empty list refuses all), `BE`/`BS`/UV refused in code and by CHECK `backup_eligible = false`. The token row is locked and re-checked (`FOR UPDATE`), so of two concurrent verifies one wins; the token is spent at the first key. The second key needs the enrolment session (`amr` contains `enrol`), exactly one existing credential, and a per-principal advisory lock. A principal with fewer than two live keys can elevate only in the enrolment session.
4. **Counter rule (B2-4).** Atomic `UPDATE ... WHERE sign_count < $presented`; a regression revokes the credential and commits; a lost race refuses without revoking. A trigger forbids a lower counter.
5. **Elevation (C1).** Grant is a server-side row bound to the session; the challenge is bound to principal and session by RLS (`session_id = app.session_id`); the guard re-checks per request that the grant is live and that the issuing credential is not revoked. Window is a setting (default 15, range 1 to 60). Token rotates at elevation. No cache, so kill switch and role removal take effect on the next request.
6. **Second approver (C4) is enforced twice.** Service checks (approver is neither requester nor subject, request pending and unexpired, row locked) and the database: CHECK approver <> requester, trigger "decided by the person of the session", not the subject, what was asked is immutable, forward-only status, `role_assignment` insert only under an approved request approved by the current person. Privileged roles in the `google` realm are refused (422). Enrolment tokens follow the same rule (256-bit token, hash stored, shown once, single use, unique hash).
7. **Kill switch (C6).** One transaction: sessions, grants and credentials of the target revoked, principal disabled, audit with reason, `session_revoked` notify, event published. T-REVOKE policies are keyed on `app.revoke_principal_id`, set only by the handler.
8. **Sessions (26.2).** 256-bit token, SHA-256 stored, `__Host-` prefix, `Secure; HttpOnly; Path=/`, `SameSite=Strict` for the admin cookie; new token at sign-in (no fixation), first duplicate cookie wins; CSRF token compared in constant time and Origin checked before any touch; no in-process cache; passive routes (closed list matched on method and path) never extend; idle and absolute limits (admin 10 min / 8 h) enforced in the lookup. `Cache-Control: no-store` on API responses. The held session is revoked before a new sign-in.
9. **OIDC (`google`, `patient_pool`).** RS256/ES256 only, signature against JWKS, issuer, audience, `exp`, nonce, PKCE S256, `email_verified`, `hd` and exact email-domain compare via `lastIndexOf('@')`, realm from route and host, not from a claim. State/nonce/verifier sealed in AES-256-GCM `__Host-oidc` (Lax), cleared on every outcome; `returnTo` restricted to a same-host relative path; IdP errors never surface. Pre-registered principal binds `sub` once, within the registration window.
10. **Secrets (BE-02), as far as it goes.** Outbound `put` returns only a version ID; value is not stored, logged or audited (audit holds the version ID); store write is idempotent by client token; the reference row can only be class `outbound` through the API role; credential-looking keys are refused in `settings` (code and CHECK). Inbound-verification values never enter a table (sealed with the request ID as context). The worker recomputes the canonical bytes from the opened value and compares (O2-2), refuses a missing assertion, a missing or equal approver, and **the default verifier refuses everything**, so the safe failure applies. Webhook verifiers compare in constant time, check a 5-minute window, and read no table before verification.

## 3. Findings

Severity: Critical / High block advancing RA-R1-32; Medium needs a correction or a recorded risk acceptance; Low / Info are hardening. IDs are stable across rounds. `Routing` is a request to the Orchestrator: this ticket cannot create or assign work outside its allowed paths and changes no code. Parent for correction tickets is HEAAA-25 unless stated.

### SEC02-F01 · High · The admin realm is not composed into the application; its routes are not mounted and no elevation checker is installed
- **Where:** `apps/api/src/composition.ts` (`createIdentity({...})` has no `elevation`; `hosts` maps only `google` and `patient_pool`); `grep -rn createIdentityAdmin apps/` finds it only in `identity/admin/index.ts` and two `testkit.ts` files; `identity-env.ts` has no variable for the AAGUID list, attestation root certificates, decoy key or ceremony origins.
- **Issue:** BE-05 ships a library and tests, not a running admin realm. `createIdentityAdmin` is never called by the entry point, so `/api/v1/admin/auth/*` and the principal, role-change, enrolment and kill-switch routes do not exist. The guard falls back to `NO_ELEVATION`, so every elevation-gated route (including BE-23 and BE-24 configuration and audit routes) answers `403 identity.elevation_required`.
- **Failure scenario:** Today this fails closed. The risk is the first integration: someone wires it up with a convenience default (empty root list is refused, but an AAGUID list or decoy key might be filled with test values), and C1, C4 and C6 are then "evidenced" by tests that ran against `testkit.ts` fakes. RA-R1-32 requires the evidence from the **integrated candidate** (TEST-CASES 5, evidence rule), which cannot exist.
- **Remediation:** Integration owner wires `createIdentityAdmin` and passes `admin.elevation` to `createIdentity`; adds environment loading that fails by name when the AAGUID list, roots, decoy key (separate from rate, session and CSRF keys, each at least 32 chars), or origins are missing; maps the admin host explicitly; adds a start-up test that the process refuses to start with `self_for_tests`, an empty AAGUID list or a decoy key equal to another key. Then QA runs TC-SEC-01..05, 18 and TC-SEC-C7-01..07 on that candidate.
- **Owner / parent:** Integrator (INT-04) with Backend Engineer (BE-05 owner). Blocks acceptance of RA-R1-32.

### SEC02-F02 · High · No worker handler for `identity.admin_event`; the B2-9 audit, notices and alerts do not exist, and there is no `identity.bootstrap_admins` job
- **Where:** `admin/jobs.ts` defines `identity.admin_event` with kinds `credential_enrolled`, `credential_revoked`, `counter_regression`, `enrolment_token_requested/approved`, `role_change_requested/decided`, `handle_failures`; `ceremony.ts` and `service.ts` enqueue them. `apps/worker/src/jobs/identity/index.ts` registers only `identity.record_sign_in`, `identity.apply_reference_data`, `identity.purge_sessions`. A search of the repository finds no handler and no `bootstrap_admins` job.
- **Issue:** ARCHITECTURE 26.3 (B2-9) makes these events the **human detection layer** for the accepted residual risk RR-1: audit event `enrol`, a compliance alert and a PHI-free notice to the security contact on every credential insert or revoke and every enrolment-token creation, and an alert on counter regression and on 20 failures per hour on one handle. The ceremony code comments say the worker writes the audit event "for the paths where audience `anonymous` cannot write to `audit.event`", so **enrolment, counter-regression revocation and handle-failure events have no audit row at all** until a handler exists. The bootstrap of the first two admins (26.3, C4) is also missing, and `identity.bootstrap_admins` is the only way to create an `admin_pool` principal without an existing elevated admin.
- **Failure scenario:** Two compromised or colluding elevated admins mint a token and enrol an attacker key on a third admin's principal. The jobs are enqueued, nothing handles them, no alert reaches compliance or the security mailbox, and there is no audit row for the enrolment. The accepted RR-1 assumption (detective control) is false. Separately, a new environment cannot get its first admin.
- **Remediation:** One owner builds and tests: the `identity.admin_event` handler (audit row with actor and approver IDs, compliance alert, PHI-free notice, dedupe by job key), the "fewer than two active credentials" alert, `identity.bootstrap_admins` (refuses if any `admin_pool` principal exists, two principals, two enrolment tokens, dual-controlled in the pipeline), and the `identity.kill_switch_used` handler. Acceptance: a dbtest per kind proving the audit row, alert and notice exist, and that a failing handler dead-letters visibly.
- **Owner / parent:** Orchestrator assigns (Backend Engineer, identity lane; DevOps for the dual-controlled runbook step). Blocks acceptance of RA-R1-32 and RR-1.

### SEC02-F03 · Medium · A refusal for a missing elevation is not audited
- **Where:** `guard-policy.ts` (`authorize`, elevation branch): `throw new ForbiddenError('identity.elevation_required')` without the `this.audit(...)` call that every other 403/404 in the file makes. Tests (`guard.dbtest.ts:449`, `ceremony.dbtest.ts:593`, `organisation/admin/admin.dbtest.ts:380`) assert the status and code only.
- **Issue:** TC-SEC-01 (P0) expects "a `denied` audit event exists per attempt with outcome and reason" for every privileged call without elevation. ARCHITECTURE 27.1 says the 403s are audited.
- **Failure scenario:** A stolen unelevated admin session probes every privileged route. Nothing is recorded, so the attempt is invisible to compliance and TC-SEC-01 fails.
- **Remediation:** Call `this.audit(req, ctx, decl, 'forbidden')` (reason `elevation_required` if the audit port takes one) before the throw; extend the three tests to assert the `denied` row. Consider the same for `auth.csrf_failed` on authenticated sessions.
- **Owner / parent:** Backend Engineer (BE-04 guard, BE-05). Parent HEAAA-25.

### SEC02-F04 · Medium · Admin-entered secrets cannot be written end to end: no routes, no `tx_sign` challenge, no evidence verifier, sealed payload refused by the queue
- **Where:** `integration-core/README.md` notes INT-N2, INT-N4, INT-N5; `SecretService` is not referenced outside its module (`grep`); `identity/admin/challenges.ts` `ChallengePurpose = 'sign_in' | 'enrol' | 'elevation'` (the table allows `tx_sign`, RLS has staff policies for it, no code issues one); `apply-secret.ts` `refusingVerifier`.
- **Issue:** ARCHITECTURE 25.9 makes O-2 **required in R1** for every admin-entered inbound-verification value, and defines `PUT /admin/integrations/{id}/secrets/{name}`. None of the following exists: the outbound PUT route; the inbound request/approve routes; identity issuing the requester's and approver's `tx_sign` challenges bound to `request_hash`; the `ApprovalEvidenceVerifier` (two WebAuthn assertions, credential anchored in an archived audit anchor and older than `tx_sign_credential_min_age`, O2-3/O2-4); the kernel allowance for the one sealed payload (INT-N4: the queue refuses it, so `requestInboundSecret` fails closed). Write-only behaviour holds in the service, but it cannot be shown over HTTP.
- **Failure scenario:** Fails closed today (every request ends `rejected`, compliance alert). The risk is a shortcut to unblock go-live: the permissive fake verifier the tests use, or a direct secret-store write by an admin script, replacing O-2. Acceptance C1/C4 and the secret write-only evidence (TC-AD-14 over HTTP) cannot be produced.
- **Remediation:** Orchestrator creates correction work for: identity `tx_sign` issuance and the real `ApprovalEvidenceVerifier` (BE-05 lane); the three routes with elevation and a fresh-assertion check (BE-22/BE-23 lane); the kernel amendment for the sealed payload with SC-5 (null at any terminal state). Add a negative test that the production composition does not accept the permissive verifier. Until then, record that no admin-entered inbound secret may be set in R1 pilot environments.
- **Owner / parent:** Orchestrator assigns (Backend Engineer; kernel owner for INT-N4). Parent HEAAA-25. Blocks acceptance of the 25.9 O-2 requirement.

### SEC02-F05 · Medium · The signed request does not name the approver (INT-N3 deviation from O2-1)
- **Where:** `integration-core/canonical.ts` header; `secret-service.ts` `requestInboundSecret` / `decide`.
- **Issue:** ARCHITECTURE 25.9 step 1 puts `approverPersonId` into `canonical_request` and the requester's signature, and step 2 lets "the named approver only" approve. The code omits it, so any other elevated admin may approve, and the requester's signature does not commit to who. The worker's later check (credential owner = approver person, not the requester) removes self-approval but not "requester picks a friendly second admin after the fact".
- **Failure scenario:** A compromised requester account asks, and a second compromised admin approves. The design's named-approver step (and its out-of-band fingerprint confirmation with a specific person) is absent. Impact is bounded by O-2's remaining checks but weaker than the accepted design.
- **Remediation:** Either name the approver in the request (store `approver_person_id` at request time, include it in the bytes, enforce in `decide`) or have the Architect record the deviation in ARCHITECTURE with the reason and the compensating control. I do not accept the deviation silently.
- **Owner / parent:** Architect (decision), then Backend Engineer. Parent HEAAA-25.

### SEC02-F06 · Medium · The decoy `allowCredentials` list may be distinguishable from a real one
- **Where:** `admin/decoy.ts` (`DECOY_ID_BYTES = 32`, `DECOY_TRANSPORTS = ['usb']`); `admin.test.ts:47` checks only that decoys are 32 bytes and stable.
- **Issue:** SEC01-F-01 / ARCHITECTURE 26.1 require decoy IDs "truncated to the credential-ID length of the approved authenticator models" and transports "the most common real value". The code fixes 32 bytes and `usb`. Real credential IDs are authenticator-defined (commonly 64 bytes for some security keys), and real `transports` come from the browser at enrolment (for example `usb`, `nfc`, `usb,nfc`). If either differs, the options response tells a caller whether a handle has an active credential.
- **Failure scenario:** An attacker with 30 options calls per 5 minutes per address enumerates admin handles. The responses are structurally identical in tests only because the test authenticator happens to produce 32-byte IDs.
- **Remediation:** Make the decoy length and transports derive from the approved model list (or normalise real transports to the same single value on the server when storing and returning them, and fix the length by AAGUID class). Add a test with each approved model's real ID length. QA records the real key model used for TC-SEC-03.
- **Owner / parent:** Backend Engineer (BE-05); Cybersecurity maintains the AAGUID list. Parent HEAAA-25.

### SEC02-F07 · Medium · Kill switch can lock out the admin realm; recovery and person-level scope are undefined
- **Where:** `admin/service.ts` `killSwitch`; worker has no `identity.bootstrap_admins` (F02); ARCHITECTURE 26.3 (bootstrap "refuses if any admin_pool principal exists").
- **Issue:** One elevated admin with `identity.principal.kill` can disable any admin principal, revoking all its credentials, with no second approver (by design: C6 is immediate). There is no re-enable route in BE-05 and the only recovery is two other elevated admins minting an enrolment token, and the bootstrap job refuses to run once any principal exists. If both bootstrap admins are killed (by a compromised account, or by mistake) there is no application path back. The switch is per **principal**: a person with both a `google` and an `admin_pool` principal keeps the other one live, while C6 speaks of "every session ... of a user".
- **Failure scenario:** A compromised elevated admin kills the other admin(s) to delay response. Or an operator kills the sole remaining admin during an incident. Recovery needs database break-glass.
- **Remediation:** Architect and DevOps decide and document: a minimum number of admins that the switch may not reduce below (or an alert plus a runbook), a documented dual-controlled database recovery, and whether the switch also covers all principals of the person. Test: kill switch on a person with two principals.
- **Owner / parent:** Architect (decision), DevOps (runbook), Backend Engineer. Parent HEAAA-25.

### SEC02-F08 · Low · The database does not bound an elevation grant; role assignment is not tied to the approved change
- **Where:** `2201...triggers.sql` `guard_elevation_grant`; `2202...rls_and_grants.sql` `elevation_grant_principal_insert`, `role_assignment_admin_insert`.
- **Issue:** C4 has a database half (triggers, CHECKs), C1 does not: any `app_api` transaction in an `admin_pool` staff session may insert a grant for its own session with any `expires_at`, no `credential_id` and `method = 'pool_auth_time'`, because nothing in RLS or the trigger checks the duration, the existence of a fresh assertion, or the credential. Likewise `role_assignment_admin_insert` requires only an approved request for that subject by the current person; it does not check that the role and location are in the request's `change`.
- **Failure scenario:** A bug or injection in any API handler running under an admin session can self-elevate for a year, or add any role to the subject of an approved request. The primary control (handler code) is correct today.
- **Remediation:** Trigger: reject `expires_at - issued_at` above the maximum setting, require `credential_id` for method `webauthn_api` and that credential live and owned by the session's principal. Policy or trigger: role assignment must match an element of `request.change.add`. Hardening, not a blocker.
- **Owner / parent:** Backend Engineer (BE-05). Parent HEAAA-25.

### SEC02-F09 · Low · No purge job for `webauthn_challenge`; unknown handles insert rows
- **Where:** `2202` comment "identity.purge_challenges every 10 minutes (33.1)"; `worker/src/jobs/identity/jobs.ts` crontab has only `identity.purge_sessions`; `ceremony.ts` `signInOptions` inserts a row for every call, including unknown handles.
- **Issue:** The worker has a DELETE policy for the table but nothing deletes. Up to 30 rows per 5 minutes per address (200 from a clinic) grow without bound, and the sessions purge waits for unexpired challenges.
- **Remediation:** Add the job and a test that expired and used challenges older than a day are removed. Add a global ceiling alert (the 3000 alert exists for options; confirm it is wired, see `onGlobalAlert` is not passed in `createIdentityAdmin` for `OptionsLimiter`).
- **Owner / parent:** Backend Engineer (identity lane). Parent HEAAA-25.

### SEC02-F10 · Low · The role-change audit records the `before` set at request time, and a stale request still applies
- **Where:** `service.ts` `decideRoleChange` (audit `before` from the row; `after` from the current set).
- **Issue:** C4 requires the before and after role set in the audit. If roles changed between request and approval, `before` is not the real state, and `remove` entries that no longer exist are skipped silently.
- **Remediation:** Compare the current set with `before` at approval and refuse (or re-request) on difference, or record the actual pre-apply set.
- **Owner / parent:** Backend Engineer (BE-05). Parent HEAAA-25.

### SEC02-F11 · Info · Items to confirm at integration
- **Client address behind CloudFront and the load balancer.** `platform/app.ts` sets `trust proxy` to loopback and private ranges. Every limiter (`options`, sign-in failures, per-IP) keys on `req.ip`. If the load balancer's address is the last untrusted hop, all users share one counter; if a client can pass its own `X-Forwarded-For`, the limits are bypassable. DevOps and QA confirm on the deployed candidate.
- **OIDC state key rotation.** `composition.ts` passes only `oidcStateKeys.current`; there is no previous-version window (26.1 asks for current and previous).
- **Re-authentication `auth_time`.** `oidc.ts` accepts a token without `auth_time` even when `max_age` was requested; this is the documented Unverified item (HEAAA-13 spike). Record which branch QA tested (TC-SEC-06).
- **Vendor host allowlists (SEC01-F-12).** `connections.ts` refuses credential-looking keys but not URL or host keys in `settings`. The adapters that enforce the per-vendor allowlist and the test "a connection naming another host is refused" do not exist yet; carry to each adapter ticket.
- **C2 and C3** (OU membership, super-admin refusal, hourly reconciliation) are path A controls; under path B (D-35) they do not apply to `admin_pool`, and the directory crossing is not built. No finding, noted so nobody counts them as evidenced.

## 4. Requirement status for RA-R1-32 (this revision)

| Control | Design | Code | Evidence on an integrated candidate |
| --- | --- | --- | --- |
| C1 elevation | yes | Library correct; DB half missing (F08); refusal not audited (F03) | Not possible (F01) |
| C4 second approver | yes | Correct in code and DB; audit `before` stale (F10); enrolment events unaudited (F02) | Not possible (F01, F02) |
| C6 kill switch | yes | Correct in one transaction; scope and recovery undefined (F07) | Not possible (F01) |
| C7 cases | TEST-CASES 5 | Fixture-based tests exist for the library | Not possible (F01) |
| O-2 inbound secrets | yes | Service, worker check present; fail closed | Not possible (F04, F05) |
| Outbound write-only | yes | Service correct; no route | Not possible (F04) |

## 5. Result and next permitted action

**Result: CHANGES REQUIRED for acceptance of RA-R1-32.** Blocking: F01, F02 (High). Needs correction or a recorded risk acceptance by the owner: F03 to F07 (Medium). F08 to F11 are hardening. There are no Critical findings; no code path was found that grants access today, because the admin realm is not mounted and fails closed.

**Review state.** Review round 1 of this document (see `review-ledger`). This document is a review of an unintegrated revision; a re-read is required on the first integrated candidate that contains F01 and F02 fixes (INT-04), with the executed C1, C4, C6, C7 evidence attached.

**Routing requested of the Orchestrator** (correction tickets that do not depend on SEC-02 and block SEC-02's consumers, INT-04, until fixed and independently reviewed):

| ID | Severity | Owner | Parent |
| --- | --- | --- | --- |
| SEC02-F01 | High | Integrator + Backend Engineer | HEAAA-25 |
| SEC02-F02 | High | Backend Engineer (+ DevOps runbook) | HEAAA-25 |
| SEC02-F03 | Medium | Backend Engineer | HEAAA-25 |
| SEC02-F04 | Medium | Backend Engineer, kernel owner | HEAAA-25 |
| SEC02-F05 | Medium | Architect, then Backend Engineer | HEAAA-25 |
| SEC02-F06 | Medium | Backend Engineer, Cybersecurity (AAGUID list) | HEAAA-25 |
| SEC02-F07 | Medium | Architect, DevOps, Backend Engineer | HEAAA-25 |
| SEC02-F08 to F10 | Low | Backend Engineer | HEAAA-25 |
| SEC02-F11 | Info | DevOps, QA, Integrator | HEAAA-25 |
