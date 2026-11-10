# SEC-01 — Cybersecurity review of the identity, trust-boundary and secret-handling design

| Field | Value |
| --- | --- |
| Task | HEAAA-65 `[SDLC:ticket:SEC-01]` (lane HEAAA-25) |
| Author | Cybersecurity `83cd0a46` |
| Independent reviewer | Security Reviewer `074b2525` (native review stage). The author does not review this document |
| Review round | Round 1 (cumulative count is kept in this ticket's `review-ledger`; it is not reset by reassignment) |
| Status | Submitted for independent review. **Not human-approved. Not G2. Not ID-FREEZE.** |
| Document revision | The git commit that contains this file on branch `HEAAA-65-sdlc-ticket-sec-01-…`; the exact commit is in the submission comment |

## 0. Basis, method and limits

**Design revisions read (design review only).** Read from `docs/*.md` on branch `HEAAA-64-sdlc-ticket-f-00-…` at commit `bd6de63` (F-00, byte-identical G2 candidates). I recomputed the sha256 of each file I cite and it equals `docs/MANIFEST.sha256`:

| Document | sha256 (first 16) | Sections read |
| --- | --- | --- |
| ARCHITECTURE draft 8.1 | `1e7fe57ed94d4412` | 8.4, 21.2–21.6, 22.4, 22.5.1, 25.8, 25.9, 26.1–26.4, 31.3, 31.4, 32.2, 37 |
| SHARED-BOUNDARIES draft 3 | `84ba36816e5cb1d3` | 6.7, 7, 9.1, 10, 12 |
| DELIVERY-PLAN draft 3 | `0e64a03505938e62` | 1, 2, 4 (C-02) |
| TICKETS | `2cfb0aa18bb207b2` | 3, SEC-01, ID-FREEZE |

**Method.** Reading the text against the threat model: (a) an unauthenticated internet client; (b) an authenticated low-privilege user; (c) a compromised `api` task (code execution with the `app_api` database role and the API's cloud role), which is the case O-2 names; (d) a malicious or phished admin. Where a claim in the design says "verified (spike)", I took it as the author's statement; I did not re-run it.

**What this document is not.** No code, no configuration and no scan was examined, run or claimed. No tool was used other than reading. No dynamic probing took place. "Verified" below never means that I verified something; it only repeats what the design says.

**Not covered.** SHARED-BOUNDARIES 6.2 definer functions other than the two added in ARCHITECTURE 21.6 (including `patient.identity_label`, apart from O-5); Cognito behaviour for `patient_pool` (the patient pool's own OTP/SMS controls); the DEVOPS-PLAN network and IAM detail (where I need a fact from it, I list it as a condition on DevOps).

**Verdict vocabulary.** ACCEPT, ACCEPT-WITH-CONDITIONS (conditions named, each with an owner) or REJECT with the replacement control. A condition marked **[freeze]** changes architecture text or the identity tables and must be in the ID-FREEZE revision. A condition marked **[build]** is an acceptance condition of the named build ticket and does not change the design text.

## 1. Summary

| # | Item | Verdict |
| --- | --- | --- |
| 1 | Variant B2 (API-run WebAuthn) vs B1 (managed pool) | **B2: ACCEPT-WITH-CONDITIONS. B1: not recommended; accepted only with fallback F-1, which is B2** |
| 2 | T-SIGNIN and the sign-in write path | **ACCEPT-WITH-CONDITIONS** |
| 3 | T-SIGNIN-CLAIM pre-verification read | **ACCEPT-WITH-CONDITIONS** |
| 4 | `identity_signin_ro` | **ACCEPT-WITH-CONDITIONS** |
| 5 | Complete `anonymous` read list (21.3) | **ACCEPT-WITH-CONDITIONS** (one gap, SEC01-F-05) |
| 6 | Complete `public` read list (21.3) | **ACCEPT-WITH-CONDITIONS** |
| 7 | `directory_ro` grants (TDR-15/16) | **ACCEPT-WITH-CONDITIONS** |
| 8 | O-2 transaction signing | **ACCEPT-WITH-CONDITIONS — required in R1 for inbound-verification secret changes; not required in R1 for other approvals (residual risk named in 6)** |
| 9 | O-5 (referencing-record check at the API layer) | **ACCEPT-WITH-CONDITIONS** (API check is necessary but not sufficient on its own) |
| 10 | Definer functions of 21.6 | **`integration_core.receive_inbound`: ACCEPT-WITH-CONDITIONS. `patient.lock_patients`: ACCEPT-WITH-CONDITIONS** |
| 11 | Sign-in rate limits (31.3) | **ACCEPT-WITH-CONDITIONS** |
| 12 | 60 s stream-closure bound (32.2 point 5) | **ACCEPT-WITH-CONDITIONS** |
| 13 | SHARED-BOUNDARIES 9.1 / ARCHITECTURE 25.9 secret classes and paths | **ACCEPT-WITH-CONDITIONS** |
| 14 | Single `staff.` origin for the admin realm (SHARED-BOUNDARIES 7.2.4) | **ACCEPT-WITH-CONDITIONS** (I do not ask for a separate `admin.` origin) |

**Freeze answer (plain).**

- **Variant B2 can freeze**, provided the **[freeze]** conditions in section 4 are written into the ID-FREEZE revision. No identity table is removed or renamed; two columns/policies are added or tightened (section 5). None of them needs a cloud spike.
- **The D-35 path A/B choice is not mine to make and does not block my review.** Security view: path B with B2 is acceptable and is my preferred option, because it removes the Google/Workspace single trust root for privileged roles (SEC-D-19 residual risk "Medium" under path A). Path A stays acceptable-with-conditions only as stated in ARCHITECTURE 8.4 (owner funds C1–C3; C4–C7 stay). The identity tables can freeze before the owner answers, because ARCHITECTURE 26.4 shows path A removes no table. **But ID-FREEZE must not run until a human has recorded the D-35 answer or let the default stand** (freeze condition 2 in ARCHITECTURE 20.3). That is a human step; I cannot supply it.
- **This is not human approval, not G2 and not the ID-FREEZE gate (HEAAA-147).**

## 2. Findings

Stable IDs `SEC01-F-nn`. Severity is mine. "Blocking" means the verdict that depends on it is not valid until it is fixed in the design text. Nothing here is a product defect (there is no code); each is a design defect or a missing control. Status of all: **Open, round 1**.

| ID | Sev | Blocking | Finding | Replacement or fix | Owner |
| --- | --- | --- | --- | --- | --- |
| SEC01-F-01 | Medium | Yes (B2 verdict) | **Handle enumeration through `allowCredentials`.** 26.1 returns "an empty `allowCredentials` list and a real challenge" for unknown, suspended or disabled handles. A known active handle returns its credential IDs. The response shape therefore tells an unauthenticated client whether a handle exists, which the design says it must not (26.1 "indistinguishable"; `401` bodies are uniform). Equal timing does not help. | For a handle with no active credentials, return a **deterministic fake credential list**: 1–2 fake IDs derived as `HMAC(server_secret_v, handle \|\| i)` with fake `transports` copied from the most common real value, stable across calls and across instances. Rotate `server_secret_v` only with a documented overlap. Rate-limit and test: the response for a real and an unknown handle is structurally identical and the credential IDs are stable on repeat | Architect (text, 26.1); Backend BE-05 (build) |
| SEC01-F-02 | Medium | Yes (B2 verdict) | **Options calls are unlimited and write a row each.** 31.3 counts failures only and says "every options call [is] not a failure". Each `…/sign-in/options` and `…/enrolment/options` inserts a `webauthn_challenge` row and runs two queries for any client. The only bound is the WAF at 600 per 5 min per IP (clinic ranges exempt). A distributed client can fill the table and the database connection pool. | Count every options call in its own counter (`options` key, per IP): refuse with `429` above e.g. 30 per 5 min per IP (200 from `clinic_egress_cidrs`), before touching the database. Cap unused `sign_in`/`enrol` challenge rows per IP key and purge expired rows at least every 10 minutes (not hourly). An alert at 10× applies as in 31.3 | Architect (text, 31.3); Backend (build) |
| SEC01-F-03 | Medium | Yes (rate-limit and O-2 verdicts) | **`clinic_egress_cidrs` is a bypass lever with two sources of truth.** It is a database setting (API failure limit 200) and an exemption in the WAF rule. A wrong or hostile value (`0.0.0.0/0`) disables the WAF rule for everyone and quadruples the API limit. The client IP the API uses is not specified either: if it is read from `X-Forwarded-For` without a trusted-hop count, a client can claim a clinic address. | (a) One source: the list is held in IaC/WAF and mirrored to the setting by one audited change; (b) validation: reject any prefix shorter than /24 (IPv4) or /48 (IPv6), private, loopback, link-local and reserved ranges; (c) changes need an elevation and audit with before/after (C4-style notification to the security contact); (d) the API takes the client address from the trusted proxy hop only (CloudFront/ALB as configured, rightmost trusted entry) and the WAF rule matches the connection address, never a header; (e) test: a request with a forged `X-Forwarded-For` of a clinic range is counted against its real address | Architect (text); DevOps (WAF/IaC); Backend (build) |
| SEC01-F-04 | Medium | Yes (O-2 verdict) | **The O-2 control as written can be satisfied by a signature the approver never saw, and its trust anchor can be created by the attacker it defends against.** (a) WebAuthn signs only the challenge bytes. If the approving browser shows the approver what the compromised `api` supplies, the approver signs a hash of the attacker's request. (b) A compromised `api` can enrol its own credential for a person it controls, wait for the next audit anchor (every minute, 25.9 / Part I 6) and then meet "anchor older than the request". (c) The text does not say that the worker recomputes the hash from the payload it decrypts. (d) Challenge freshness and replay are not specified. | See section 6.2 conditions O2-1..O2-9 | Architect (text 25.9); Backend (BE-05, integration-core); DevOps (KMS, IAM) |
| SEC01-F-05 | Medium | Yes (anonymous-list verdict) | **The 60 s revalidation read has no policy in the "complete" `anonymous` list.** 32.2 point 5 re-reads "each stream's session row in one batched query". 21.3 lists `identity.session` only as a lookup by one `token_hash = app.session_token_hash`; 22.4 allows T-PRINCIPAL (one `app.principal_id`) and T-SYS (`app_worker` only). A batch of N sessions matches neither. Either the CI catalog check (M-5) fails the build, or a policy outside the reviewed list will be added at build time. | Choose one and put it in 21.3 and 22.4: (a) one query per stream under that stream's own authenticated settings (T-PRINCIPAL), bounded by the per-instance stream cap in 32.3; or (b) a new narrow policy "`id = ANY(app.session_ids)`, columns `id, revoked_at, idle_expires_at, absolute_expires_at` only, SELECT only, audience `staff`", added to the `anonymous`/`staff` complete list and to the M-5 check. I accept either; I do not accept a third definer function or a role switch to a wider role | Architect (text); Backend (BE-07) |
| SEC01-F-06 | Low | No | **Anonymous INSERT into `webauthn_challenge` is not restricted by purpose.** 22.4 lets `anonymous` insert challenge rows. Nothing says an anonymous caller cannot insert `purpose = 'elevation'` or `'tx_sign'` with a chosen `bound_hash`. The row also has no `session_id`, so an elevation challenge is not bound to the session that asked for it. | WITH CHECK for `anonymous`: `purpose IN ('sign_in','enrol')` only. `elevation` and `tx_sign` rows need audience `staff`, realm `admin_pool`, `principal_id = app.principal_id` and a new `session_id` column equal to the current session. Verification refuses a challenge whose `session_id` differs | Architect (22.4 column and policy) |
| SEC01-F-07 | Low | No | **T-SIGNIN INSERT on `identity.principal` is not narrowed by realm.** 26.1 says admin sign-in "never inserts a principal", but the policy as written (`realm = app.auth_realm AND subject = app.auth_subject`) would allow an `admin_pool` insert in any handler that sets the settings. The code path is the only barrier. | INSERT `WITH CHECK` adds `realm IN ('patient_pool','google')`. A principal in `admin_pool` is insertable only under `system` (bootstrap job) or `admin_pool` T-CONF writes | Architect (21.4) |
| SEC01-F-08 | Low | No | **A pre-registered `google` principal may receive roles before it is bound.** Binding is by verified email (once, `subject` null → value). Between pre-registration and binding (up to `preregistration_days`) the principal exists with an email that Workspace could reassign. | A role assignment (or role-change request) for a principal whose `subject IS NULL` is refused by trigger. Binding writes an audit event with `sub`, email and `hd` and sends a PHI-free notice to the registering admin | Architect (22.4); Backend (BE-04) |
| SEC01-F-09 | Low | No | **Session touch and lifetime are not constrained in the database.** 26.2 writes `last_seen_at`, `last_interaction_at`, `idle_expires_at` at most once a minute, but the policy under which this UPDATE runs is not stated (the `anonymous` lookup policy is SELECT). Nothing stops `idle_expires_at` passing `absolute_expires_at`, or `revoked_at` being cleared. | State the policy and a column grant (those three columns only). Trigger/CHECK: `idle_expires_at <= absolute_expires_at`; `revoked_at` can go null → value, never back | Architect (22.4) |
| SEC01-F-10 | Low | No | **O-5 (see 6.3): no detective control for a wrong reference.** | See 6.3 | Architect; Backend; QA |
| SEC01-F-11 | Low | No | **Staff-portal `SameSite=Strict` versus the OIDC callback.** 26.2 sets `Strict` on `staff.`. A top-level GET redirect back from Google is a cross-site navigation; the state/nonce/PKCE-verifier cookie would not be sent and the callback would fail (a functional defect that tempts a build engineer to weaken the cookie). | Keep `__Host-sid` `Strict`. Hold state, nonce and verifier in a short-lived server-side record keyed by the `state` value, or in a separate pre-auth cookie that is `Lax`, `__Host-`, `HttpOnly`, ≤ 10 min and deleted at callback. State this in 26.1 | Architect (text); Backend (BE-04) |
| SEC01-F-12 | Low | No | **Integration base URLs and egress.** An outbound secret (9.1 `outbound`) can be redirected to an attacker if the vendor base URL is a database setting that a compromised `api` can change. | Vendor hostnames come from code or IaC, not from a mutable setting; the adapter refuses any host not on the per-vendor allowlist; DevOps' egress rules allow only those hosts. Test: a connection record with another host is refused | Architect (9.1 text); DevOps; Backend |
| SEC01-F-13 | Info | No | `public_clinician*` views expose clinician `principal_id` values to unauthenticated clients (`clinicianId`). | Accept as C0. Condition: IDs are random (v4-class, ≥ 122 random bits), no route treats a principal ID as a credential, and `next_available` returns no patient or appointment IDs | Backend; QA |

## 3. Item verdicts

### 3.1 Variant B2 versus B1 — **B2: ACCEPT-WITH-CONDITIONS**

**Reasoning.** The four boundary properties of SHARED-BOUNDARIES 7.5 hold under B2 by our own code: separate realm, WebAuthn with user verification on every sign-in and elevation, no self-service recovery, kill switch in our database (also in a regional failover, because credentials restore with the database). B1 depends on seven unverified pool behaviours (P-1..P-7) and on a cloud account that does not exist; every failed spike result lands on F-1, which is B2. B2 does deviate from the SEC-D-19 disposition wording "separate managed user pool". **I accept that deviation** because the separate realm, mandatory WebAuthn, no self-recovery and the immediate kill switch are kept; the wording was a means, not the control. The cost is that we own a security-critical ceremony; the conditions below are the price.

**B1: not recommended.** I do not reject it as a principle, but I will not review a B1 design for the freeze unless P-1..P-7 are evidenced, and I would then require F-1 for every item that fails.

**Conditions (all [freeze] text unless marked [build]).**

| ID | Condition |
| --- | --- |
| B2-1 | **Library.** A maintained server-side WebAuthn library, exact-pinned, listed in DEPENDENCIES with licence and a named upgrade owner; no hand-written CBOR/COSE/ASN.1 verification. [build] |
| B2-2 | **Ceremony parameters (fix them in 26.1).** RP ID is the exact `staff.` host, not a parent domain; the expected-origin list is exact (scheme, host, port); `userVerification: required`; `residentKey: discouraged` (handle is typed, discoverable credentials are not needed); `authenticatorAttachment: cross-platform`; challenge 32 bytes from the CSPRNG, single use, 2 min. |
| B2-3 | **P-5 decision (roaming-only): REQUIRED.** At enrolment require attestation, verify the attestation statement and chain, and reject (a) any AAGUID not on the approved list (maintained by Cybersecurity; each entry cites FIDO Metadata Service status; revoked or "compromised" authenticators are refused) and (b) any credential with backup eligibility `BE=1` or `BS=1` (multi-device/synced passkeys put recovery in a cloud account, which breaks property 3). `admin_credential.backup_eligible` and `aaguid` already exist; the check must be written into 26.1. |
| B2-4 | **Counter rule.** The counter is compared and written in one atomic statement (`UPDATE … SET sign_count = $new WHERE id = $id AND sign_count < $new`). Authenticators that always report 0 are allowed only if stored and presented are both 0. A regression revokes the credential and raises the compliance alert (as designed). A concurrent duplicate presentation must not cause a false revoke of the other request: decide by the atomic update result. [build] |
| B2-5 | **Challenge single use.** Consumed with `UPDATE … SET used_at = now() WHERE id = $1 AND used_at IS NULL AND expires_at > now() RETURNING …` before the session is created; a challenge allows one verification attempt, including a failed one (the burn is written in the same short failure transaction that counts the failure). Challenge IDs have ≥ 122 random bits. Purpose, `principal_id` and (for elevation and `tx_sign`) `session_id` must match. |
| B2-6 | **Handle format and normalisation.** `^[a-z0-9][a-z0-9._-]{2,63}$`, checked before `app.auth_claim_handle` is set; no Unicode; one normalisation function used by enrolment, creation and sign-in. |
| B2-7 | **SEC01-F-01 and SEC01-F-02** are fixed in the text. |
| B2-8 | **Two keys.** Keep the "second key before the first session ends" proposal as a rule, not a Proposal: a principal with one active credential cannot be elevated beyond its enrolment session, and an alert goes to the security contact when a principal has fewer than two. |
| B2-9 | **Enrolment and credential-change notice.** Every `admin_credential` insert or revoke, and every enrolment-token creation, sends a PHI-free notice to the security contact mailbox and raises a compliance alert. This is the human detection layer for O-2 (section 6). |
| B2-10 | **Elevation.** Keep ≤ 15 min (Setting) and bound to the session; re-assertion is required per action for the O-2 class (section 6). The elevation challenge must be created under that session (SEC01-F-06). |
| B2-11 | **Penetration test and ASVS L3.** The B2 ceremony is in scope of the pre-release penetration test and has a named Security Reviewer pass at the BE-05 code review. [build] |

### 3.2 T-SIGNIN and the sign-in write path — **ACCEPT-WITH-CONDITIONS**

Good: the write policies match nothing until `app.auth_subject` is set after verification; admin sign-in never inserts a principal; `subject` is bindable only once; the `sub` becomes the identity, so a reassigned Workspace email cannot take over a bound principal.

Conditions: **SEC01-F-07** (narrow the INSERT by realm), **SEC01-F-08** (no roles before binding; audit and notify on binding), **SEC01-F-09** (session columns and lifetime), **SEC01-F-11** (state cookie). In addition:

| ID | Condition |
| --- | --- |
| SI-1 | **Realm comes from the route and configuration, never from a token claim or request parameter.** The issuer that verified the token determines `app.auth_realm`; a `patient_pool` token presented to the `google` callback fails on issuer. [build] |
| SI-2 | **Google checks.** Signature against the issuer keys, `iss`, `aud`, `exp`, `nonce`, `email_verified = true`, the `hd` **claim** equal to the configured domain **and** the email's domain suffix equal to `@<domain>` (compare the part after the last `@`, not `endsWith`). A token without `hd` is refused. Binding is by lower-cased email, exact equality. [build] |
| SI-3 | **Pre-registration window.** Keep `preregistration_days` ≤ 30 and make it a `pre_auth` setting range-checked 1–30. |
| SI-4 | **CI call-site check** of the `app.auth_*` setters stays mandatory (21.3) and must also cover `SET ROLE identity_signin_ro` and the claim setter. |

### 3.3 T-SIGNIN-CLAIM pre-verification read — **ACCEPT-WITH-CONDITIONS**

The claim reads, for one exact handle, the principal's ID and status and its non-revoked credentials' ID, public key, counter and transports. Public keys, credential IDs and transports are not secrets (the browser receives IDs in `allowCredentials`). The equality predicate gives no handle search and no other principal or column. I accept the read.

Conditions: **B2-6** (handle format, so the equality key cannot be confused or injected), **SEC01-F-01** (the response must not leak existence), and:

| ID | Condition |
| --- | --- |
| CL-1 | The claim setting is set only through the kernel helper that applies B2-6 and is used inside the same transaction as the `SET LOCAL ROLE`. A test shows that outside `identity_signin_ro` the setting alone grants nothing. |
| CL-2 | `sign_count` is read for the comparison but never returned to a client. |
| CL-3 | The post-verification path writes under T-SIGNIN with the *verified* handle, never with the claim value. |

### 3.4 `identity_signin_ro` — **ACCEPT-WITH-CONDITIONS**

Column-level SELECT on five `principal` columns and seven `admin_credential` columns, owning nothing, `SET`-only membership by `app_api`, switched with `SET LOCAL ROLE` and reset before any other statement. Because `SET LOCAL` ends with the transaction, a pooled connection cannot keep the role. A compromised `api` can already do more as `app_api`, so the membership adds no exposure beyond the public data above.

Conditions:

| ID | Condition |
| --- | --- |
| RO-1 | A catalog test asserts that `identity_signin_ro` owns no object, is a member of no role, and that its only member is `app_api` with `INHERIT FALSE, SET TRUE, ADMIN FALSE`. |
| RO-2 | A behavioural test runs every identity table under `identity_signin_ro` × every audience and asserts zero rows except the T-SIGNIN-CLAIM cases (see AN-1). |
| RO-3 | While the role is switched the handler must not run any other query. The kernel wrapper allows exactly the claim reads and enforces `RESET ROLE` in `finally`; the transaction aborts if a statement runs in between. |

### 3.5 Complete `anonymous` read list (21.3) — **ACCEPT-WITH-CONDITIONS**

Item by item:

| # | Policy | Verdict |
| --- | --- | --- |
| 1 | `identity.session` by `token_hash` | Accept. 256-bit token, hash lookup. Add **SEC01-F-09** |
| 2 | T-SIGNIN (matches nothing until verified) | Accept with **SEC01-F-07/08** |
| 3 | T-SIGNIN-CLAIM | Accept, 3.3/3.4 |
| 4 | `enrolment_token` by `token_hash` | Accept. Token ≥ 256 bits; the lookup returns the row in any status and the handler checks `approved`, unexpired, unused, principal match. Condition: the SELECT column grant does not include fields the enrolee does not need (`requested_by_person_id`, `approved_by_person_id` are not returned by the API) |
| 5 | `webauthn_challenge` by `id` | Accept with **SEC01-F-06** |
| 6 | `kernel.rate_counter` | Accept: keys are HMACs, no raw values. Condition: the HMAC key is a separate secret from session and CSRF secrets |
| 7 | `kernel.setting` where `pre_auth` | Accept as a **closed key list**: session lifetimes, `preregistration_days`, the sign-in limits and `clinic_egress_cidrs`. A CI check lists the `pre_auth` keys and fails on any addition without a reviewed change to this list. No route returns these settings to a client (`clinic_egress_cidrs` is a network map) |
| gap | Batched session revalidation (32.2) | **SEC01-F-05** |

| ID | Condition |
| --- | --- |
| AN-1 | **The M-5 "can match anonymous" check is behavioural, not syntactic.** A static reading of arbitrary policy expressions will not hold. The check seeds one row per table and runs every table × every role the application can become (`app_api`, `app_worker`, `identity_signin_ro`, and `app_api` with each audience value, including unset, `anonymous`, `public`, and a webhook transaction with no audience) and compares the set of tables returning rows with the 21.3 list. It also fails on any policy without a `TO` clause (default `PUBLIC`). [build: F-03 / BE-01..BE-05] |
| AN-2 | A change to the list in 21.3 is a design change that needs a Cybersecurity review (fixed in the ticket for the owning module). |

### 3.6 Complete `public` read list (21.3) — **ACCEPT-WITH-CONDITIONS**

Reading: `public` is set only for `integrations./public/v1/*`, with `app.org_id` from deployment configuration and nothing else. It reads the nine C0 views through `directory_ro` and executes `scheduling.next_available`. T-CONF read, `kernel.setting` and `kernel.rate_counter` do not match it. I accept this as complete, subject to AN-1 (the same behavioural matrix, including `public` against every base table and every column outside the 22.5.1 grants) and:

| ID | Condition |
| --- | --- |
| PB-1 | `scheduling.next_available` returns slot times and opaque location/service/clinician keys only: no appointment, hold, patient or patient-count value. It is not a covert availability-scraping defence; the WAF limit (600 per 5 min per IP, 31.3) is the only brake, so DevOps adds a per-IP daily budget and an alarm on scraping patterns. |
| PB-2 | The `public` transaction cannot write. Its connection role has no write path to a table; the test sends `INSERT`/`UPDATE`/`DELETE` through the public route's transaction and expects refusal. |
| PB-3 | **SEC01-F-13** (opaque random IDs). |
| PB-4 | The route responses are cached by the CDN only for the views' publishable rows; a `Cache-Control` and `Vary` review is part of the FE-15/BE-22 acceptance so an unlisted clinician or ended banner disappears within the cache TTL. |

### 3.7 `directory_ro` grants, TDR-15/16 — **ACCEPT-WITH-CONDITIONS**

Reasoning. The three points that worry me in the design are (a) `CREATE` on schema `identity`, (b) owner-rights views and (c) column grants that must equal what the views read. For (a): the role is `NOLOGIN` and its only member is `app_owner`, `SET`-only and without inheritance; `app_owner` is the migration role and owns the tables, so the membership gives it nothing it lacks; no application role can switch to `directory_ro`. The `CREATE` right is therefore reachable only through a migration, which is reviewed and checked by the M-5 object-list rule. For (b): the views are owner-rights, but base-table access still goes through RLS (FORCE) with the T-DIRECTORY policy `TO directory_ro`, which restricts rows to `public`/`patient` audience and publishable rows, and PostgreSQL's row-security barrier prevents a user qual from being evaluated before the policy. For (c): the grant table in 22.5.1 is explicit about what is not granted (`npi`, `dea_number`, `subject`, `email`, prices, `internal_name`, `condition_revealing`).

| ID | Condition |
| --- | --- |
| DR-1 | **Catalog test**: `pg_auth_members` for `directory_ro` is exactly (`app_owner`, `set_option = true`, `inherit_option = false`, `admin_option = false`); `directory_ro` owns only the nine C0 views; it holds no privilege on any table or column outside the 22.5.1 list; it holds no `INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER` anywhere; and no object in `kernel`. The test compares to the 22.5.1 table (the "optional" comparison in 22.5.1 becomes **mandatory**). |
| DR-2 | Create the nine views `WITH (security_barrier = true)` (defence in depth; cost is a plan change the author can measure). |
| DR-3 | Each view is created in a migration that sets `search_path` explicitly and schema-qualifies every name. A view with a function call or a cast that is not on an allow-list fails review. |
| DR-4 | The `CREATE` right is withdrawn on schemas `identity` and `scheduling` after the migration step if PostgreSQL allows the owner transfer without it (spike 3 stated it does not on the target version). If the right must stay, the M-5 object-owner check runs on **every** deploy, not only in CI on the main branch. |
| DR-5 | Behavioural test: under `public` and `patient`, every base table returns zero rows for `app_api`, and a column outside the grant is refused through the view. Under `staff`, `anonymous`, `partner`, `system` and a webhook transaction every view returns zero rows. |

### 3.8 O-2 transaction signing — see section 6.

### 3.9 O-5 — see section 6.3.

### 3.10 The two definer functions of 21.6

**`integration_core.receive_inbound(source, event_id, type, payload_ciphertext)` — ACCEPT-WITH-CONDITIONS.** It inserts only; it reads nothing; `organisation_id` comes from the deployment-configured `app.org_id` and a missing value raises; duplicates return `(duplicate, null)` and give no oracle to anyone but a verified sender; the function no longer touches the queue (TDR-04).

| ID | Condition |
| --- | --- |
| DF-1 | `REVOKE ALL ON FUNCTION … FROM PUBLIC`; `GRANT EXECUTE` to `app_api` only. `SET search_path = pg_catalog, integration_core, pg_temp` (or fully qualified names) in the function definition. |
| DF-2 | `source` is an enum/`CHECK` over the configured sources; `type` and `event_id` have length and character-set checks; `payload_ciphertext` has a size cap equal to the route body limit. |
| DF-3 | The verification itself (29.5) is in the API and the database cannot check it. Record in the design text that a compromised `api` can insert forged messages, and that the dispatch handlers must therefore treat every payload as untrusted input: schema validation, no privileged side effect without a second check (for example a delivery receipt only for a known outbound reference). The worker does **not** need to re-verify signatures: the `api` can read the inbound secret, so a second verification adds nothing against a compromised `api` (it would help only against a write-only attacker). |
| DF-4 | `payload_ciphertext` is encrypted with a KMS key whose `Decrypt` is granted to the `worker` role only (encryption context = source and event ID). Webhook bodies never enter logs or WAF logging unredacted. |

**`patient.lock_patients(ids uuid[], mode text)` — ACCEPT-WITH-CONDITIONS.** It returns nothing, so there is no data path; the risk is lock abuse and an existence oracle.

| ID | Condition |
| --- | --- |
| DF-5 | `mode` is compared to the two allowed literals (`CASE`); the value is never concatenated into SQL. Anything else raises. |
| DF-6 | Array length is capped (the largest legitimate caller is a merge: 2; set a cap of 10), duplicates removed, ids locked in ascending order, `NULL` elements refused. |
| DF-7 | **Invisible and non-existent IDs raise the same error**, so a caller cannot probe whether a patient exists. The visibility check uses the caller's settings with the same predicate as T-PAT-*/T-STAFF, not a re-implementation (one SQL predicate generated by the policy template). |
| DF-8 | `REVOKE … FROM PUBLIC`; `EXECUTE` to `app_api` and `app_worker` only; `SET search_path` as in DF-1. Audience `anonymous`, `public` and webhook transactions get an error. |
| DF-9 | `lock_timeout = 5 s` (already a role setting) applies inside the function; a test shows two callers cannot hold more than the cap. |

### 3.11 Sign-in rate limits — **ACCEPT-WITH-CONDITIONS**

I accept the design choice: failures only, per IP; global alert; per-handle alert that never refuses. A WebAuthn assertion, an OIDC code and a 256-bit enrolment token cannot be guessed, so a per-handle refusal would only be a lock-out lever against the admin who may need the kill switch. I do **not** require a per-handle delay.

Conditions: **SEC01-F-02** (count options calls), **SEC01-F-03** (clinic list and client IP), and:

| ID | Condition |
| --- | --- |
| RL-1 | 50 failures / 5 min per IP and 200 from `clinic_egress_cidrs` are accepted as the initial values. They are `pre_auth` settings with a range check (min 10, max 500). |
| RL-2 | The 10× alert (31.3) and the global 300 / 5 min alert are routed to the security contact as well as operations. |
| RL-3 | The failure is counted in its own transaction after rollback (as designed). A test kills the request between rollback and count and shows the next request is still counted. |
| RL-4 | Patient and Google flows: the IdP limits are relied on; the API's per-IP counter still applies to the callback. |

### 3.12 The 60 s stream-closure bound — **ACCEPT-WITH-CONDITIONS**

A revoked session's `GET /alerts/stream` may keep delivering alert notifications for up to 60 s if `pg_notify('session_revoked', …)` is lost. Every other request is refused at once. The stream payload is IDs, type, severity and a link, so the exposure in the window is alert metadata about patients that the user already had access to a minute earlier. I accept 60 s as the maximum for R1. It meets SEC-D-19 "immediate kill switch" for every request that returns data.

| ID | Condition |
| --- | --- |
| ST-1 | **SEC01-F-05** (the batched read). |
| ST-2 | Stream events carry only the closed list of fields in 32.1. `type` is a category, never free text; no patient name, date of birth, record number, condition or alert text. A schema test on the event serialiser enforces this. |
| ST-3 | A test with the `LISTEN` connection dropped (fault injection) shows closure within 60 s; a test with the notification delivered shows closure at once (QA, TC for BE-07 and SEC-05). |
| ST-4 | The kill switch also ends the principal's other long-lived connections (telehealth join tokens issued through the session are revoked in the same transaction, if any exist). Backend lists them in BE-05. |

### 3.13 Secret classes and write paths (9.1, 25.9) — **ACCEPT-WITH-CONDITIONS**

The split (outbound written by `api`; inbound-verification written by `worker` only, `api` read-only) is sound against a write-only attacker. Against a full `api` compromise it protects the integrity of the *stored* inbound secret only after the O-2 control (section 6), because the `api` can read the secret and so forge a vendor signature anyway; this is a limit of the design that I record rather than fix.

| ID | Condition |
| --- | --- |
| SC-1 | **O-2** (section 6) applies to every `inbound_verification` write that an admin enters. Values the worker generates (partner client secrets, HMAC keys) need no O-2 and are shown once. |
| SC-2 | IAM (DevOps): `api` role has `secretsmanager:PutSecretValue/CreateSecret` only under `<env>/integration/outbound/`, and an explicit **deny** on write under `…/inbound/`; the `worker` role is the reverse for inbound; neither can change the secret policies or KMS key policies. A CI/IaC test asserts the explicit deny. |
| SC-3 | KMS key for the O-2 payload: `Encrypt`/`GenerateDataKey` to `api` only, `Decrypt` to `worker` only, key policy conditioned on the encryption context (request ID); no `kms:*`. For values larger than the direct KMS limit use envelope encryption with the same context. |
| SC-4 | The plaintext value exists only in the API request handler memory and is removed from every log, error report and trace (the redacting logger of F-04 covers the `value` field of this route; the WAF/CloudFront log configuration excludes request bodies). |
| SC-5 | The queue row holding `payload_ciphertext` is deleted (or its payload nulled) when the job reaches any terminal state and, regardless, after the request's expiry (30 min); the dead-letter view does not show the payload. |
| SC-6 | `request_hash` includes the request ID and a per-request nonce so a low-entropy value cannot be brute-forced from a leaked hash. The minimum accepted length of an entered secret is stated in the integration spec. |
| SC-7 | **SEC01-F-12** (vendor hostnames from code/IaC). |
| SC-8 | The 5-minute read cache (9.1) is an upper bound. The kill switch for an integration (disable connection) clears the cache within the same bound; the cache holds secrets only in process memory. |

### 3.14 One `staff.` origin for the admin realm — **ACCEPT-WITH-CONDITIONS**

SHARED-BOUNDARIES 7.2.4 invites Cybersecurity to ask for a separate `admin.` origin. **I do not ask for it in R1.** The realm check on every admin route, one session per browser, a `Strict` cookie, and a per-action security-key assertion for privileged actions give the same separation of authority at lower cost. Conditions: a strict CSP on `staff.` (no `unsafe-inline` or `unsafe-eval` for scripts, `frame-ancestors 'none'`); no rendering of user-supplied HTML; the CSRF and `Origin` checks of 26.2 on every admin write; elevation is not usable from a request without the `X-CSRF-Token`; the O-2 class needs a fresh assertion per action, which a script on the page cannot provide. This is revisited if the penetration test finds script injection on `staff.`.

## 4. Conditions that change the architecture text (input to ID-FREEZE)

These are the **[freeze]** items. They are proposals for the Solution Architect's erratum (ID-FREEZE); I have not edited ARCHITECTURE.

| # | Section | Change | From |
| --- | --- | --- | --- |
| T-1 | 26.1 (B2 table, options rows) | Replace "empty `allowCredentials` list" with a deterministic fake credential list; state B2-2 ceremony parameters, B2-3 (roaming only; AAGUID allowlist with MDS status; refuse `BE/BS`), B2-4, B2-5, B2-6 | SEC01-F-01, B2-1..6 |
| T-2 | 31.3 and 31.4 | Add the `options` counter and limit; add the unused-challenge cap and purge interval; validate and single-source `clinic_egress_cidrs`; state how the client IP is derived; range checks for the three settings; route alerts to the security contact | SEC01-F-02, -03, RL-1, RL-2 |
| T-3 | 21.3 and 22.4 | Resolve the batched session read (option a or b) in the `anonymous` list and the `session` row; state the session-touch policy and column grant; add the `idle ≤ absolute` and `revoked_at` monotonic rules | SEC01-F-05, -09 |
| T-4 | 22.4 `webauthn_challenge` | Add `session_id uuid NULL`; `anonymous` INSERT `WITH CHECK purpose IN ('sign_in','enrol')`; `elevation` and `tx_sign` require staff/`admin_pool`, own principal and the current session | SEC01-F-06 |
| T-5 | 21.4 T-SIGNIN, 22.4 `principal` | INSERT `WITH CHECK` adds `realm IN ('patient_pool','google')`; trigger refuses role assignments for a principal with `subject IS NULL`; binding writes an audit event and notifies | SEC01-F-07, -08 |
| T-6 | 25.9 and 22.3 | The O-2 control as a Fixed rule for the inbound-verification path with conditions O2-1..O2-9 below; add the assertion-evidence columns (section 5) | SEC01-F-04 |
| T-7 | 26.1 / 26.2 | State where OIDC state, nonce and verifier live (not the `Strict` cookie) | SEC01-F-11 |
| T-8 | 22.5.1 / 21.2 | `directory_ro` catalog test becomes mandatory; views `security_barrier`; `CREATE` withdrawal where possible | DR-1..DR-4 |
| T-9 | 21.6 | Add DF-1..DF-9 to the two definer rows | 3.10 |
| T-10 | 9.1 / 25.9 | Vendor host allowlist from code/IaC; payload deletion at terminal state; hash nonce | SC-5..SC-7, SEC01-F-12 |
| T-11 | 32.2 | Add ST-1..ST-3 as test obligations | 3.12 |
| T-12 | 25.9 header | Change "Cybersecurity decides whether to require it" to the decision in section 6 | O-2 |
| T-13 | 20.3 / 37 | Mark SEC-1, SEC-2, SEC-3 and the SEC-1 additions as "reviewed in SEC-01, conditions as listed; accepted by Cybersecurity, not human-approved" | — |

## 5. Identity table delta (for the freeze)

The freeze does not remove or rename a table or column. The additions are:

| Table | Change |
| --- | --- |
| `identity.webauthn_challenge` | add `session_id uuid NULL` (T-4); FK to `identity.session(id)`; policy as T-4 |
| `identity.principal` | trigger for SEC01-F-08; INSERT `WITH CHECK` realm (T-5). No column |
| `identity.session` | CHECK `idle_expires_at <= absolute_expires_at`; `revoked_at` monotonic trigger; column grant for the touch UPDATE (T-3) |
| `integration_core.secret_change_request` | add evidence for the O-2 control: either columns `requester_assertion jsonb`, `approver_assertion jsonb` (clientDataJSON, authenticatorData, signature, credential ID, all base64url) or a child table `secret_change_assertion (request_id, role, person_id, credential_id, client_data, authenticator_data, signature, asserted_at)`; and `canonical_request bytea` (the exact bytes hashed). The assertions carry no secret value |
| `identity.admin_credential` | none. `created_at`, `aaguid`, `backup_eligible` already exist; the eligibility delay (O2-4) uses `created_at` |

## 6. O-2 (transaction signing) and O-5

### 6.1 Verdict on O-2 — **ACCEPT-WITH-CONDITIONS, required in R1 for inbound-verification secret changes**

**What it defends.** A compromised `api` can write approval rows and enqueue jobs, so an approval flag alone is not evidence. Two WebAuthn assertions over the request hash, made by two enrolled, different persons and verified by the `worker`, are evidence the `api` cannot produce without a person's key or forged anchored history.

**Why it is required here.** An inbound-verification secret decides whether we accept forged vendor events (for example pharmacy or telehealth callbacks) that cause clinical-side effects. The worker, not the API, is the only writer, by design, so the worker must be able to check that a human pair really approved.

**Why it is not required for other approvals in R1 (recorded residual risk, owner decision).** For role-change approval, enrolment-token approval and person-link approval, the same argument holds in principle, but a compromised `api` can already read or write any PHI that its settings permit (it sets the scope settings itself), so the extra gain of role escalation is limited and the build cost is high (the worker would have to apply role changes, 25.8 currently applies them in the API transaction). **I do not require O-2 for those in R1.** I list it as residual risk **RR-1** for the owner to accept at G3/ACCEPTANCE, and as a recommended hardening for R2. The B2-9 notices are the compensating detective control.

### 6.2 Conditions (O2-1..O2-9)

| ID | Condition |
| --- | --- |
| O2-1 | **Canonical request bytes.** `canonical_request` = a fixed, versioned, length-prefixed encoding of: request ID, connection ID, secret name, `value_sha256` salted with the request ID and a per-request nonce, requester person ID, approver person ID, `requested_at`, `expires_at`. The WebAuthn challenge for both assertions is `SHA-256(canonical_request)`. Both are stored with the request (section 5). |
| O2-2 | **Worker recomputes.** The worker decrypts the payload, recomputes the value hash and the whole `canonical_request`, and compares it to the signed challenge. It never trusts `request_hash` from the table. A mismatch leaves the secret unchanged and raises a compliance alert. |
| O2-3 | **Assertion verification in the worker.** For each of the two assertions: `type = webauthn.get`; origin and RP ID hash equal the `staff.` host; UV flag set; signature valid against the stored public key; the credential is active (not revoked), belongs to the stated person, and its AAGUID is on the approved list; the two persons differ by `person_id`; neither is the subject of the request. The challenge row (`purpose = 'tx_sign'`) is unused and unexpired and is consumed atomically. |
| O2-4 | **Credential eligibility.** A credential counts for `tx_sign` only if (a) its enrolment events were in an audit anchor that was archived to the Object Lock bucket **and** (b) it is older than a fixed delay (proposal: 24 h) at request time. This closes the "enrol, wait one minute, request" path of SEC01-F-04. The delay is a `pre_auth`-independent Setting with a floor of 1 h. |
| O2-5 | **Human detection.** B2-9 applies to every credential insert and revoke, and the quarterly privileged-access review lists active admin credentials by person and AAGUID. This is the control that catches a rogue credential enrolled before the delay expired. |
| O2-6 | **Approver sees what they sign.** The approving UI computes `canonical_request` in the browser from displayed fields (connection name, secret name, the salted value fingerprint's first and last 6 hex characters, requester name, expiry) and refuses to prompt for the key if the server's challenge differs. **Out-of-band confirmation:** the approver confirms the fingerprint with the requester over a second channel (runbook step, DevOps). Without this step a compromised `api` can show the approver a request it chose. I record that WebAuthn does not display content; a hardware transaction display is not assumed. |
| O2-7 | **Both assertions are made per request.** Not covered by the 15-minute elevation grant: each request needs a fresh assertion from requester and approver, challenge = the request hash. |
| O2-8 | **Replay and expiry.** Request expiry (30 min) is inside the signed bytes. The worker refuses expired, already-applied and cancelled requests and re-checks `applied` idempotently. |
| O2-9 | **Failure mode.** No assertions or invalid assertions → nothing is written, the payload is deleted (SC-5), the requester is told, and an alert is raised. There is no break-glass bypass for the worker check. |

### 6.3 O-5 — **ACCEPT-WITH-CONDITIONS**

**Question.** Is the API-layer check (read the referencing audit event, privacy request, consent or incident under the caller's RLS, then pass the reference) a sufficient control for `patient.identity_label`?

**Answer.** Necessary, not sufficient alone. The database part (the `patient_label` slice key, a `view` audit row naming the reference, 60 per hour) limits the damage, but nothing in the database ties the stated reference to the stated patient: a compromised or buggy API call that passes any reference ID with any patient ID obtains a name, date of birth and record number. The patient module cannot read the audit module's tables (dependency direction, BD-02), so I do not ask for a cross-module read inside the definer function. I accept the API check plus a detective control:

| ID | Condition |
| --- | --- |
| O5-1 | **Binding test.** The API route takes `patientId` from the loaded reference, not from the body when the reference carries one. If both are present they must be equal, else `404`. QA test: a valid reference to patient A with `patientId` of B is refused; the same for each of the four reference types; a reference not visible to the caller is `404` with the same body as an unknown one. |
| O5-2 | **Same transaction.** The reference read, the function call and the audit row are in one transaction. |
| O5-3 | **Detective job (daily, worker).** For every `identity_label` audit row of the last 24 h, read the named reference and check that it exists and names that patient; any mismatch raises a compliance alert and is listed in the audit viewer. (Evidence: SEC-05 assessment.) |
| O5-4 | **Thresholds.** The per-principal cap stays 60/h; add 200/day and an alert at 30/h so a harvest pattern is seen before the cap. |
| O5-5 | The function writes the audit row itself (as the inventory says), so the row cannot be skipped by a caller. |

SEC01-F-10 is this detective-control gap; it closes when O5-1..O5-5 are in the text and the QA cases.

## 7. Open items and owners

| ID | Item | Owner | Needed before |
| --- | --- | --- | --- |
| OPEN-1 | D-35: record the owner's path A/B answer or confirm the default stands (human decision). Cybersecurity position: B2 preferred; path A acceptable-with-conditions only if funded (C1–C3 and C4–C7 return) | Owner, via Orchestrator | ID-FREEZE |
| OPEN-2 | ID-FREEZE erratum: apply T-1..T-13 and section 5 | Solution Architect | ID-FREEZE gate HEAAA-147 |
| OPEN-3 | Approved AAGUID list and FIDO MDS status procedure; the model list for the first admin keys | Cybersecurity (list), DevOps (procurement) | BE-05 enrolment test |
| OPEN-4 | WAF/IaC single source for `clinic_egress_cidrs`; trusted-hop count; per-IP daily budget for `/public/v1` | DevOps | DO tickets for WAF/edge |
| OPEN-5 | KMS key policy and IAM explicit denies (SC-2, SC-3) | DevOps | DO-04 acceptance |
| OPEN-6 | Runbook step for the out-of-band fingerprint confirmation (O2-6) and the credential-change notice mailbox | DevOps; security contact named by the owner | BE-05 acceptance |
| OPEN-7 | Test obligations in the QA plan: AN-1, DR-1/5, RO-1/2, O5-1, ST-3, RL-3, DF-5..9, B2-4/5 | QA (via Orchestrator) | BE-04/05/07 test-case review |
| OPEN-8 | RR-1: accept (or not) that role-change, enrolment-token and person-link approvals do not get O-2 in R1 | Owner (ACCEPTANCE gate) | R1 acceptance |
| OPEN-9 | 6.2 definer inventory in SHARED-BOUNDARIES other than the two functions here, and the SHARED-BOUNDARIES revision that folds in `identity_signin_ro`, `directory_ro` and the two functions | Solution Architect | SHARED-BOUNDARIES next revision |

## 8. Consequence for tickets

- **ID-FREEZE** (HEAAA-66) unblocks on this review's independent PASS plus the human D-35 record and the build prerequisites in its own ticket. It must carry T-1..T-13.
- **BE-05** (HEAAA-104) carries B2-1..B2-11, O2-1..O2-9, SC-1..SC-8 as acceptance, and a Security Reviewer pass.
- **BE-04, BE-07** carry SI-1..SI-4, SEC01-F-05/09/11 and ST-1..ST-3; **BE-01..BE-05/F-03** carry AN-1, DR-1..DR-5, RO-1..RO-3.
- **SEC-02** (identity, sessions, admin realm, secrets) and **SEC-05** (streams) use these conditions as their baseline; they do not re-open a decision made here unless the build departs from this document.
- Any change to the architecture forced by this document reopens the affected G2 document (per the ticket's Held note).

## 9. Checks and limitations (what was and was not done)

| Check | Result |
| --- | --- |
| Hash check of cited design files against `docs/MANIFEST.sha256` | Executed: `sha256sum` of ARCHITECTURE, SHARED-BOUNDARIES, DELIVERY-PLAN, TICKETS, PRD from `bd6de63`; first 20 hex digits equal the manifest |
| Document review | Executed (reading). Single author pass; **not independently reviewed yet** |
| Independent Security Reviewer read of this exact revision | **Pending** (the native review stage) |
| Code, configuration, scan, dynamic probing | **None claimed.** Nothing was run against any system |
| Spike evidence cited by the design (38.1) | Taken as stated, not re-run |
| Human decisions | None given or implied. Review PASS is not approval of D-35, G2 or ID-FREEZE |

Limits: a design review cannot find implementation bugs; each condition above exists because the text leaves a gap, and the real test is in SEC-02..SEC-05 on built code. I did not read the full DEVOPS-PLAN, TEST-CASES or UI-UX; items that depend on them are listed as owner items rather than judged.
