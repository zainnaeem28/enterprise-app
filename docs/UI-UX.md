# UI-UX — Enterprise EHR Platform

| Field | Value |
| --- | --- |
| Task | HEAAA-14 `[SDLC:ux-design]`; draft 5: HEAAA-49 `[SDLC:design-align-fix]` |
| Author | UI/UX Designer agent (`1ddacad6-d28d-4bff-a938-a6957593b3ff`) |
| Version | **Draft 6** (HEAAA-49, second bounded correction cycle opened by human confirmation `5e0ef519`, limited to UXR-08..12 from the HEAAA-54 review; text changes plus desktop mockup 3 re-rendered; rounds not reset). **Draft 5** (HEAAA-49, one human-accepted bounded correction cycle, confirmation `a524dfdd`, limited to design-alignment findings AL-01, AL-02, AL-04 UX part and AL-06). Base: draft 4, branch commit `9dcb7aa`, `UI-UX.md` sha256 `1176b121…`, synced unchanged to the task documents as revision 1 (AL-06). Draft 4 revised draft 3 (`c9d6ef4`) against UXR-02 residual, UXR-06, UXR-07 (confirmation `c40be67a`). Change list: section 18, round 4 |
| Status | **DRAFT. Draft 6 review pending, limited to the diff from draft 5 (UXR-08..12). Not human-approved. Not G2.** Reviewer for this task: Solution Architect Reviewer (`338c0bb5`), with a Product Manager check of the desktop image still pending from draft 4 (desktop mockup 3 changed in draft 6, the mobile image is unchanged). |
| Inputs | Intake pack rev 2 (commit `6ea01b5`); PRD rev 3 and BA feature map (HEAAA-11 `prd`); ARCHITECTURE (HEAAA-11); SHARED-BOUNDARIES rev 3 (HEAAA-12, section 11 row "HEAAA-14 UX"); **draft 5 binds to ARCHITECTURE draft 8.1 = HEAAA-48 `architecture` rev `b276930a`, `docs/ARCHITECTURE.md` @ `481f32a` (review PASS HEAAA-53 rev `4ccbdafd`)**, sections 22.11, 28.2, 28.6, 29.3 and 32 |
| Companions | `BRAND-BRIEF.md`, `UI-Mockups-Desktop.png`, `UI-Mockups-Mobile.png`, `MOCKUP-MANIFEST.md` (all in `docs/design/`) |
| Not covered | HEAAA-13 API contracts are not final. Anything needing an endpoint or field not yet written is in section 13 and goes to the Architect. |

**Labels.** *Confirmed* = from the intake pack. *Derived* = follows from confirmed text or from fixed boundaries (BD-xx). *Proposal* = my design choice, needs review. IDs F-, J-, X-, BR-, ST-, RA- come from the PRD and BA map.

## 1. What this document is

A design specification for six surfaces: brand site, patient portal, pre-consultation portal, doctor portal, partner pharmacy portal, system admin portal. It covers navigation, screens, states, responsive behaviour, accessibility, safety patterns and the needs it places on the API. The mockups are **proposals**, never running-product screenshots. They show representative screens only, not every screen listed here.

Release tags follow the intake: R1 (by end May 2027) is designed in full detail. R2 and R3 screens are specified at the pattern level so R1 components do not need rework. R4 is excluded.

## 2. Design rules (from the agreed principles, each made testable)

| ID | Rule | Source |
| --- | --- | --- |
| UX-R1 | **Patient banner** on every screen that shows or edits a patient's clinical data: photo or initials, full name, date of birth and age, MRN, allergies. Sticky on scroll. On phones it collapses to avatar (photo or initials) + name + DOB + allergy flag and expands on tap; photo/initials, name and DOB always stay visible (PMR-03). **Allergy block rules (AL-01, ARCH 28.2 `patientBanner.allergies`):** the block is drawn from the banner that comes with the screen's own call, never from a second call. Listed severe first, at most 10, then "+{moreCount} more" that opens the allergy list. `state` `none_recorded` reads "No allergies recorded", never "No known allergies" (BQ-11). A chip "{n} uncoded: needs review" shows when `uncodedCount` > 0. `allergies` is `null` when the signed-in user passes neither the chart read nor the pre-visit read (role or assignment): the banner then shows a neutral chip "Allergies not available with your current access" (UXR-10: the cause can be the role or the assignment, ARCH 27.4, so the text does not name the role) so that a hidden block is never read as "none". It is the same on phones (flag shows the same three states). Patient-portal screens have no banner. | BR-34 `[06 §2]` |
| UX-R2 | **One portal, one accent, one written name** in the app bar. Colour is never the only cue. | `[06 §2]` |
| UX-R3 | **Risky actions state their consequence** in the button label and a confirm dialog: "Sign and lock note", "Reject with reason", "Cancel appointment (a fee applies)". No "OK/Yes/No". | `[06 §2]` |
| UX-R4 | **No PHI in URLs, page titles, tab titles, notifications or analytics.** Routes carry random IDs only. Browser tab title is the portal name and screen type ("Chart"), never a patient name. | CN-05, BR-23, BR-36 |
| UX-R5 | **Plain language.** One next step per patient screen. | `[06 §2]` |
| UX-R6 | **Staff speed.** Keyboard operable end to end; shortcuts for check-in, sign, verify; no mouse-only controls; table rows open on Enter. | `[06 §2]` |
| UX-R7 | **Visible failure.** No silent drop or silent retry that the user cannot see. Failures show what happened, what is safe, what to do. | BR-33 |
| UX-R8 | **Times** are shown in the location's time zone with the zone label (ET). Video visits show both zones when they differ. Dates in the user's locale format. | BR-05, NFR-22 |
| UX-R9 | **Status is text + icon + colour.** | WCAG 1.4.1 |
| UX-R10 | **Synthetic data only** in every mockup, demo and test screenshot. | BR-35 |

## 3. Surfaces, sign-in and navigation

### 3.1 Hosts and sign-in (Derived from SHARED-BOUNDARIES 5.1 and 7.1)

| Surface | Host | Who | Sign-in screen behaviour |
| --- | --- | --- | --- |
| Brand site | `www.` | Visitor | No sign-in. "Book" hands off to `my.` with service/doctor pre-selected by opaque ID |
| Patient portal | `my.` | Patient, proxy | Sign up and sign in with passkey or email OTP preferred; SMS OTP as fallback. Never ask for a password in a way that blocks paste or password managers |
| Pre-consultation, Doctor | `staff.` | Clinic staff (including billing) | "Continue with Google" only. Workspace enforces 2-step verification. A non-enrolled account sees a plain message to contact IT |
| System admin | `staff.` (`/admin`) | Admin, compliance | A separate "Administrator sign-in" link below the Google button. Security key (WebAuthn) mandatory |
| Partner pharmacy | `pharmacy.` | Pharmacist, technician | Email + MFA (mandatory) |

**Realm switch (Derived, 7.2.4).** A browser holds one staff session. A person who needs both staff and admin access signs out and in again. The app bar shows the realm; the switch action is labelled "Sign out to switch to administrator" and states that unsaved work is kept as a draft where the screen supports drafts.

**Admin banner.** Every admin screen shows a fixed rust banner: "Administrator sign-in. Clinical data is not available here." (see mockup 6).

**Elevation (Derived, 7.2.5).** A privileged action (role change, export, BTG review decision, configuration change) opens a dialog "Confirm with your security key". It names the action, the target and who must approve. On success the dialog closes and the action proceeds; the grant is short-lived (about 15 minutes, value in HEAAA-13) and the UI shows a small "Elevated until 10:42" chip while valid.

**Accessible authentication (WCAG 3.3.8).** No cognitive tests. OTP fields accept paste and autofill (`autocomplete="one-time-code"`). Passkey and security-key paths are offered first. Resend OTP has a visible countdown and is reachable by keyboard.

### 3.2 Navigation maps

| Surface | Primary navigation (desktop) | Phone |
| --- | --- | --- |
| Brand site | Services · Find a doctor · Locations · Prescriptions & pharmacies · Patient resources · About · **Book appointment** (button) · footer: careers, news, contact, privacy, terms, cookies, accessibility statement `[06 §3]` | Menu button opens a full-screen list; "Book now" stays in the header |
| Patient portal | Home · Appointments · Messages (if D-5 retains it) · Documents · Profile & family · **R2:** Health record · Prescriptions · Payments · **R3:** Medicines · Results | Bottom tab bar, four items: Home · Visits · Records · More. "More" holds the rest |
| Pre-consultation | Arrivals · Triage queue · Forms & consents · Follow-ups · Waitlist · **R3:** Lab desk · Location switcher (top right) | Staff on phone is supported for read, alerts and check-in only; full triage is tablet/desktop (section 9) |
| Doctor | Schedule · Patients · Tasks & messages · Notes to sign · Alerts · **R2:** Prescriptions · **R3:** Results inbox · Location switcher | Bottom tabs: Alerts · Schedule · Patients · More. Chart is read-first; note writing is tablet/desktop |
| Partner pharmacy (R2) | Queue (New · In progress · Ready/out · Completed · Rejected) · Refill requests · Reports (R3) · Pharmacy profile · Staff | Bottom tabs: Queue · Active · Reports · Pharmacy |
| System admin | Audit log · Break-the-glass review · Privacy requests · Consents · Incidents · Users & roles · Clinics & locations · Services & policies · Templates · Integrations · Feature flags · Reports (R2) | Read-only audit and alerts on phone; configuration is desktop/tablet |

**Global elements (all portals).** Skip link; app bar with portal name; user menu (profile, notification preferences where applicable, sign out); help link in the same place on every screen (WCAG 3.2.6); session timer behaviour (section 7.1); maintenance banner slot (F-AD-11 feature flags and banners).

## 4. Journey-to-screen coverage

Every PRD journey maps to screens. IDs: `BS` brand site, `PP` patient, `PC` pre-consultation, `DR` doctor, `PH` pharmacy, `AD` admin, `SH` shared. **M** = shown in a mockup.

| Journey | Rel | Screens |
| --- | --- | --- |
| J-01 Visitor finds a doctor, starts booking | R1 | BS-01 Home, BS-02 Services, BS-03 Find a doctor **(M, desktop 1; phone 1)**, BS-04 Doctor profile, BS-05 Locations, BS-06 Hand-off interstitial (only shown when not signed in: "Sign in or create an account to finish booking"), BS-07 Legal pages |
| J-02 Register, verify, MFA | R1 | PP-01 Sign up, PP-02 Verify email/phone (OTP), PP-03 Optional ID check, PP-04 Set up passkey / second factor, PP-05 Sign in |
| J-03 Guardian/proxy link | R1 | PP-06 Family & proxy list, PP-07 Add dependant/proxy (request), PP-08 Verification status, PP-09 Switch person (header chip "Booking for: …"). Default proxy visibility is appointments only (D-7 default) |
| J-04 Book, confirm, reminders | R1 | PP-10 Service, PP-11 Doctor & place, **PP-12 Date & time (M, desktop 2; phone 2 shows the slot-taken error)**, PP-13 Confirm (and payment from R2 if D-3 retains fees), PP-14 Booked + add to calendar |
| J-05 Reschedule, cancel, waitlist | R1 | PP-15 Appointment detail, PP-16 Change time, PP-17 Cancel with policy text, PP-18 Waitlist join, PP-19 Waitlist offer (accept within the countdown) |
| J-06 Arrival to queue | R1 | **PC-01 Arrivals board (M, desktop 3)**, PC-02 Check-in (find patient by `POST` search; QR scan), PC-03 Forms/consents/insurance review (staff side), **PP-25 Pre-visit questionnaire, PP-26 Consents to read and e-sign (a required consent not signed keeps the consultation gate closed, BR-09), PP-27 Insurance card upload (front/back, scan state, SH-01 pattern) with status of all three items (to do / done / needs fixing)**, **PC-04 Triage panel with vitals (M, desktop 3)**, PC-05 Assign doctor/room, PP-20 Self check-in (QR landing), PP-21 Virtual waiting room |
| J-07 Red flag | R1 | **PC-06 Red-flag alert bar (M, desktop 3)**, DR-10 Alert tray and acknowledge **(M, phone 6)**, PP-22 Emergency advice screen shown to the patient |
| J-08 Telehealth | R1 | **PP-23 Device check and join (M, phone 3)**, PP-21 Waiting room, DR-04 Video + notes side by side |
| J-09 Consultation and documentation | R1 | DR-01 Schedule, DR-02 Patient list, **DR-03 Chart summary and note editor (M, desktop 4)**, DR-05 Sign dialog (re-authentication when the server requires it, §7.1), DR-06 Addendum, DR-07 Co-sign queue, DR-08 Tasks & messages |
| J-18 Break-the-glass | R1 | DR-09 BTG reason dialog; **AD-02 BTG review (M, desktop 6)** |
| J-19 Document upload | R1 | SH-01 Upload with progress, scan state, classification, confirm; SH-02 Document list/viewer |
| J-21 Privacy request | R1 | PP-24 My privacy (download my data, deletion request), AD-05 Request queue and decision |
| J-22 Staff sign-in | R1 | SH-03 Staff sign-in, SH-04 Administrator sign-in, SH-05 Session warning dialog, SH-06 Signed out |
| Admin configuration (F-AD-01..09, 11) | R1 | AD-01 **Audit log (M, desktop 6)**, AD-03 Users & roles, AD-04 Clinics/locations/rooms/hours, AD-06 Services catalogue (with neutral display name), AD-07 Booking policies, AD-08 Message templates, AD-09 Integrations, AD-10 Feature flags/banners |
| Profile and settings (F-PP-02, F-PP-16, F-PP-09) | R1/S | PP-35 Profile and contact details, PP-36 Notification preferences (channel per message type; safety-critical notices cannot be switched off), PP-37 Messages thread list and thread **(optional until D-5 is decided)**. Pattern: form field set + list-detail (sections 6, 12). Not in a mockup |
| Doctor availability (F-DR-01, F-DR-02) | R1 | DR-11 Weekly schedule templates, DR-12 Leave and blocked time (shows affected appointments before saving), DR-13 Connect Google Calendar (consent text, connected/disconnected/error states, busy-only sync note). Pattern: schedule week + dialog. Not in a mockup |
| Follow-ups, referrals, no-shows (F-PC-07, F-PC-09) | R1/S | PC-07 Follow-up and referral task list (due, owner, status), PC-08 No-show follow-up queue with outcome (contacted / rebooked / closed). Pattern: data table + status chip. Not in a mockup |
| Brand-site CMS (F-BS-04) | R1 | `cms.` is a separate deployable with its own editor (off-the-shelf headless CMS UI). **Out of this design except branding of the login and the preview link.** Called out in section 14 |
| J-10, J-11 Prescribing, EPCS | R2 | DR-20 New prescription, DR-21 Interaction/allergy check panel, DR-22 Override reason dialog, DR-23 Pharmacy picker, DR-24 Sign (standard), DR-25 EPCS two-factor signing |
| J-12, J-13, J-15, J-20 Pharmacy fulfilment, no acknowledgement, refill, onboarding | R2 | **PH-01 Queue and detail (M, desktop 5; phone 5)**, PH-02 Reject with reason, PH-03 Query prescriber thread, PH-04 Controlled hand-over ID record, PH-05 Refill request, PH-06 Onboarding wizard, PP-30 Prescription status, PP-31 Choose another pharmacy (after rejection or 2 h no acknowledgement) |
| J-14 Delivery with failed attempt | R3 | **PP-32 Medicine tracking (M, phone 4)**, PP-33 Failed attempt with next step, PH-07 Status/tracking update form |
| J-16, J-17 Labs, critical results | R3 | DR-30 Order panel, DR-31 Results inbox, DR-32 Critical alert and acknowledge, DR-33 Release to patient, PC-10 Lab desk, PP-34 Results with plain-language explanation |

All navigation items in section 3.2 now map to a screen ID in this table, as a mockup or a pattern-level specification; items marked optional wait for the owner decision named in the row. Mockup coverage: 6 desktop screens (one per surface) and 6 phone screens. They are representative, not exhaustive. All other screens above are specified by the patterns in sections 6 to 8 and need design confirmation at build review before they ship.

## 5. Screen notes for the mockups (what each shows and why)

| Mockup | What it demonstrates | Rules and journeys |
| --- | --- | --- |
| Desktop 1 Brand site, Find a doctor | Filter set from the intake (specialty, language, location, gender, availability); "next available" with a note that it is about a minute old; cookie banner with "Essential only" equal in weight to "Accept all" | J-01, F-BS-02, BR-36, SBR (60 s staleness) |
| Desktop 2 Patient, Choose a time | Stepper; in-person/video toggle; time zone label; slot grid showing available times only; selection summary; **hold countdown**; cancellation policy sentence (**placeholder text in the mockup; real wording and cut-off are an admin setting, G2 decision**) | J-04, BR-01, BR-05, X-01, CN-06 (hold has its own idempotency key) |
| Desktop 3 Pre-consultation arrivals | Board with status chips, missing items, waits; red-flag bar is a read-only status ("Red flag raised. The on-duty doctor has been alerted."; no name or countdown, UXR-08 option B) with no button and no dismiss (UXR-02); triage panel with out-of-range vitals in red with text "Out of range"; keyboard hints | J-06, J-07, BR-09, BR-10, X-06 |
| Desktop 4 Doctor chart and note | Patient banner with allergies; uncoded medication warning; vitals trend; SOAP editor; sign-and-lock wording; draft status | J-09, BR-11, BR-34, SA-F-08 |
| Desktop 5 Pharmacy portal (R2) | Only own pharmacy's queue; "Ack due in 24 min" for the 2 h target; controlled substance marker and hand-over ID check notice; reject needs reason | J-12, BR-20, BR-21, BR-22 |
| Desktop 6 Admin audit and BTG | Admin banner; audit table with denied/allowed; BTG review with justified / not justified and a required note; re-enter security key | J-18, BR-14, AC-36, 7.2.5 |
| Phone 1 Brand home | Mobile-first hero, one primary action, cookie bar | J-01 |
| Phone 2 Booking slot taken | **Error state**: "That time was just taken", alternatives, waitlist offer, disabled primary with reason | X-02, `scheduling.slot_taken` |
| Phone 3 Telehealth join | Both time zones, device check with text status, state confirmation (TL-1), captions note | J-08, BR-05, TL-1 |
| Phone 4 Medicine tracking (R3) | Pharmacy-reported status, tracking link, history; "medicine names appear only after you sign in" | J-14, BR-23, BR-24 |
| Phone 5 Pharmacy queue (R2) | Same queue as desktop in card form with 44 px actions | J-12 |
| Phone 6 Doctor alerts | Red-flag alert with acknowledge; **live-connection warning** when the alert stream reconnects | J-07, SBR-10 (alert stream), 8.3 |

## 6. State catalogue (applies to every screen)

Each screen must define these states. The build tickets must list the ones that apply.

| State | Pattern | Rules |
| --- | --- | --- |
| **Loading, first** | Skeleton blocks in the final layout. No spinner-only screens. After 8 s add "Still working…" with a retry | `aria-busy`, live region announces "Loading" once |
| **Loading, refresh** | Keep old content, show a thin progress bar and "Updating" text. Never blank a clinical chart | Prevents flicker and lost place |
| **Empty, nothing yet** | Plain sentence + one action, e.g. "No appointments yet. Book your first visit." | Different text for "nothing exists" and "nothing matches filters" (offer "Clear filters") |
| **Empty, permitted none** | e.g. pharmacy queue empty: "No new prescriptions. We will show new ones here." | |
| **No access (403 `auth.forbidden`)** | "You don't have access to this." with a link to the user's home and a help link. No hint of what exists | CN-04 |
| **Not found or out of scope (404)** | "We can't find this, or it isn't available to you." Identical for both cases | CN-04: callers must not learn which |
| **Session ended (401)** | Dialog "Your session ended. Sign in to continue." Draft kept; after sign-in return to the same screen using the route (no PHI in it) | X-20, J-22 |
| **Validation error** | Inline under the field plus a summary at the top that receives focus; text says what to change, never the entered value in the summary | CN-03: field paths, not values. WCAG 3.3.1, 3.3.3 |
| **Conflict (412 stale version)** | "Someone changed this while you were editing." Offer "Reload and review changes"; keep the user's text in a side panel so nothing is lost | CN-07 |
| **Rate limited (429)** | "Too many tries. Try again in {n} s." with a live countdown | CN-11 |
| **Server error (5xx)** | "Something went wrong on our side. Your work is safe." + Retry + reference code (`requestId`) to quote to support. No technical detail | CN-03, CN-13 |
| **Offline / network lost** | Banner "You are offline. Changes will not be saved." Disable submit for clinical writes; keep drafts in the browser **only if no PHI persists after sign-out** (Architect to confirm, section 13 UX-A-12) | BR-33 |
| **Stale data** | Chip "Updated 3 min ago" on lists that can be stale: slot search when calendar busy data is old (X-03), "next available" (60 s), delivery status | Calendar stale flag is a contract need (UX-A-03) |
| **Permission-limited view** | A visible note where a role sees part of a record: "Showing pre-visit items only". Hidden data is not shown as blank fields that look empty | Role matrix |
| **Success** | Inline confirmation with next step; toast only for low-risk actions. Safety-critical results (signed, sent, acknowledged) stay on screen until dismissed | |
| **Partial failure** | List what worked and what did not, per item, e.g. an upload batch | BR-33 |
| **Idempotent retry** | Buttons disable on submit and show progress. A retry after a timeout reuses the same key for that step. UI shows the final state returned by the server | CN-06 |
| **Maintenance** | Banner with time and what is affected; sign-in remains visible | F-AD-11 |
| **New version available (non-blocking)** | Slim bar under the app bar: "A new version is available. Finish or save what you are doing, then reload." Actions "Reload" and "Remind me later". Never moves focus, never reloads by itself. Full behaviour in 7.7 | AL-04, ARCH 28.6 |
| **Page out of date (400 `kernel.client_release_unsupported`)** | Blocking dialog that asks to reload; the refused action had no effect. Unsaved input on the open form is lost on reload, and the dialog says so. Full behaviour in 7.7 | AL-04, ARCH 28.6, 30 |

## 7. Cross-cutting behaviour

### 7.1 Session and timeouts

Staff idle timeout default 15 minutes (G2 setting). The UI warns at 13 minutes with a dialog: "You will be signed out in 2:00. Stay signed in" (the dialog takes focus and reads out the time on open; it does not trap the user if they have a screen reader running). A draft note is preserved on sign-out (X-20). Signing a note re-authenticates only when the server answers `401 auth.reauth_required` (sign-in older than `note_sign_max_auth_age`, 12 h, G2 setting; BQ-8). The dialog then goes to `/auth/reauth`, returns, and repeats the request with the **same** idempotency key; the draft is kept (UXR-03). Prescriptions (R2) always re-authenticate through the vendor (BR-17). Patient and pharmacy timeouts are values for HEAAA-13 and G2; the same warning pattern applies. WCAG 2.2.1: timeouts are adjustable or extendable; the hold countdown extends only by returning to the previous step, and says so.

### 7.2 Slot hold and booking (PP-12 to PP-14)

- On selecting a time the UI creates the hold (step 1 key) and shows the countdown from the server expiry time, not a local timer started on click. It is a text countdown ("Held for 09:42") with `role="timer"`, announced politely at 5, 2 and 1 minute, not every second (WCAG 2.2.1, 4.1.3).
- Confirm uses its own idempotency key (step 2). Double-click and refresh are safe.
- Hold expired (X-01): inline banner, slots reload, same service/doctor kept.
- Slot taken (X-02, `scheduling.slot_taken`): the mobile mockup error pattern with nearby alternatives and a waitlist offer.
- A booking confirmed by a retried request shows the same confirmation, not an error.

### 7.3 Duplicate patient warning (BR-37, 6.6)

At registration the warning lists only fields the user may see. It never shows demographics of an out-of-scope record. Wording: "A record may already exist. Check before creating a new one." Actions: "Open existing record", "Create anyway (reason required)". Merge is a separate staff screen requiring `patient.merge`, with two-person approval if BQ-3 retains it. A write against a merged record (`409 patient.merged`) shows "This record was merged." with "Open the merged chart" only when the API returned the survivor ID, else the neutral message.

### 7.4 Notifications and alerts

- Patient: email, SMS, push and in-app. All external text is the fixed PHI-free prompt (BR-23). The in-app notice may say more after sign-in.
- Staff: live alert bar and tray from the SSE stream. Alert content: type, location/room, patient name and DOB only inside the signed-in app. Acknowledge is one click and recorded. Unacknowledged alerts escalate (X-06, X-15). **Countdown rule (AL-02, ARCH 29.3 `GET /alerts`):** the UI shows "Escalates in 4:10" only while `escalatesAt` is not null. The remaining time is `escalatesAt` minus the server time taken from the response `Date` header, moved on by the local time elapsed since that response; the device clock alone is never used. `open-ids` (the 60 s passive poll) refreshes `escalatesAt`, `escalationLevel` and `status`, so the tray corrects a drifting countdown without an interactive call. When `escalatesAt` is null the row says, by case: "Escalation time not set" (open alert with no configured time, for a red flag until D-12a), "Escalated" with the level (`status` escalated; R1 escalates once), or no escalation text (acknowledged). An escalated alert stays in every target's tray until someone acknowledges it (N-6). On acknowledge the row shows "Acknowledged by {name} at {time}" from the response; if the response says `alreadyAcknowledged` it says "Already acknowledged" (UXR-09: the acknowledge response carries a principal ID, not a name) and fills in "by {name} at {time}" only after the next `GET /alerts` refresh returns `acknowledgedByDisplayName`; no second confirmation sound or toast; `409 notifications.alert_closed` shows "This alert is closed." and removes the row. The countdown is text, not announced every second (section 10).
- Reconnect: if the stream drops, a banner states it and a visible "Check for alerts" button polls. On reconnect, missed alerts appear first (SBR-10 replay).
- Admin realm receives compliance alert types only.
- Patient and pharmacy portals have no realtime and **no timer-driven polling** on interactive routes, because that would reset the idle timer (contract 26.2). They refresh on focus, on user action ("Refresh" button) and on navigation, with "Updated at" text. The video waiting room checks status every 5 s on the passive status route only (UXR-01). A live patient view would need a new passive route (UX-A-06).
- Toasts never carry the only copy of a safety message.

### 7.5 External links

Delivery tracking links open the pharmacy's own page. Show an interstitial the first time: "You are leaving [Product name] for your pharmacy's tracking page." with the domain shown, `rel="noopener noreferrer"`, and no health data in the link we create. Links must not carry the patient's name.

### 7.6 Print and export

Print views carry the patient banner on every page and an access-logged footer (NFR-13). Export actions say what will be exported and are logged; admin and compliance export of audit data never includes record contents (6.7).

### 7.7 New version and half-completed forms (AL-04 UX part, ARCH 28.6)

**Why it exists.** A tab can stay open for days on an old portal bundle. The API refuses bundles older than its supported release. The user must learn that in time, without losing what they typed. All wording below is a **Proposal** for review. It applies to the patient, staff, admin and (from R2) partner portals. The public brand site has no API calls with the header and shows no prompt.

**What the user can rely on (rules, in priority order)**

1. **The page never reloads by itself** while any form on it has unsaved input, and the design does not reload by itself in other cases either: reload happens only when the user chooses it. This keeps the Architect's constraint without a special case.
2. **A form is "unsaved"** when a field differs from the last value the server accepted. The page tracks this in memory only. Nothing about it, and no field value, is written to `localStorage`, `sessionStorage` or IndexedDB (ARCH 26.2; UX-A-12 stays "server-side drafts only").
3. **The prompt is the moment to save.** The non-blocking prompt asks the user to finish or save first, and offers a save action only where the server has a draft route.
4. **A refused request changed nothing** (checked before the session lookup, ARCH 28.6). The blocking dialog says so, and says the action can be repeated after reload.

**Non-blocking prompt (a newer release exists).** Trigger: the page reads `release.json` (every 5 minutes and when the tab regains focus) and its release number is higher than the bundle's. That request is a static file on the portal's own origin, not an API call, so it does not touch the idle timer (ARCH 28.6).

| Part | Design |
| --- | --- |
| Placement | Slim bar under the app bar (below the patient banner is not used, so the banner stays at the top of the content area). Not a modal. Not a toast: it does not disappear on its own |
| Text | "A new version is available. Finish or save what you are doing, then reload." If a form is unsaved, the second line adds: "This page has unsaved input." |
| Actions | **Reload** (primary) and **Remind me later**. "Remind me later" hides the bar for 30 minutes, kept in memory only; it comes back earlier if an API call is refused (blocking dialog) |
| Reload with no unsaved input | Reloads at once to the same route (IDs only, no PHI in the route) |
| Reload with unsaved input | A confirm dialog first: "Reload and lose unsaved input?" listing the forms by name (for example "Visit note", "Message to clinic"), never by content. Buttons "Stay on this page" (default, focused) and "Reload anyway". If the form has a draft route, the dialog's first button is **Save draft and reload** (see below); the reload happens only after the server confirms the save |
| Focus and announcement | `role="status"` (polite), announced once. Focus is not moved. The bar is reachable by keyboard in reading order right after the skip link target and never hidden behind sticky elements (2.4.11) |

**Per form type**

| Form | What is already saved | What the prompt does |
| --- | --- | --- |
| Clinical note (SOAP) | Autosaves a server draft every 30 s (ARCH 28.6, 26.2). The editor shows "Draft saved 09:41:12" | Offers **Save draft and reload**: saves now, shows "Draft saved", then reloads. If the save fails, nothing reloads and the error state (section 6) shows with "Try again". At most the last 30 s is at risk, and the prompt says so if the last save is older than 30 s |
| Pre-visit questionnaire | Saves with an explicit "Save and continue later" (`PUT` of the response) | Offers **Save and reload** with the same rule: reload only after the server confirms |
| Any other form (booking steps, messages, admin settings, search filters) | Nothing is saved until submit | No save offered. The prompt asks the user to submit or finish first; the confirm dialog states plainly that unsaved input will be lost. A slot hold keeps running on the server and is not lost by a reload; the held slot survives on the server, but no route lists a patient's active holds (UXR-12a). The booking page can show the held slot after a reload only if the route keeps the `reservationId` and `GET /appointments/{reservationId}` returns a held reservation; ARCH does not say it does, so this is **open for the Architect** (13.2). Until answered, design for the fallback: after a reload the patient starts the slot choice again and the expired or still-held slot is shown by the server answer to the next hold request, with no stored form data |

**Blocking dialog (`400 kernel.client_release_unsupported`).** Trigger: any API call is refused with that code, or the live alert stream is refused (see below).

| Part | Design |
| --- | --- |
| Pattern | `role="alertdialog"`, takes focus, one assertive announcement (section 10), focus returns to the page if the user chooses to stay |
| Text | "This page is out of date and can't save changes. Reload to continue. Your last action did not go through, and you can repeat it after reload. Anything you typed on this page that was not saved will be lost." No technical detail; the `requestId` is shown for support, as for other errors |
| Actions | **Reload** (primary, the only way forward) and **Keep this page open** (secondary). Keep-open shows a red bar "This page is out of date. Saving is turned off. Reload to continue." and disables submit and save actions, because every API call would be refused. It lets the user read or write down what they typed. It does not offer to copy or store it |
| Not shown | No automatic reload, no countdown, no "try again" that would repeat a doomed request |

**Live alerts (staff).** The alert stream cannot send the header, so the client passes it as `clientRelease` and a refusal ends the stream with a plain `400` and no reconnect (ARCH 28.6). Missing alerts is a safety issue, so when the stream is refused the alert bar shows, in the alert colour and not as a small notice: "Live alerts are paused because this page is out of date. Reload now." with a **Reload** button, together with the blocking dialog. This state must never look like "no alerts". Missed alerts appear first after reload (SBR-10 replay, 7.4).

**Order against other states.** `401` session ended (section 6) wins over the release prompt while the open bundle is still accepted (the non-blocking bar): sign in first, then the page reloads on the new bundle anyway. Once the bundle is refused, ARCH 28.6 checks the release before the session lookup, so a tab with both an outdated bundle and an expired session gets `400 kernel.client_release_unsupported`, never `401`, and the blocking release dialog shows first; build and QA must not test the `401`-first order for that case (UXR-12b). A maintenance banner and the release bar can show together; the maintenance banner is above.

**Accessibility.** The bar and the dialogs are operable by keyboard and screen reader, have visible focus, hold text contrast at AA, reflow at 320 px and 200 % zoom, use no motion, and have no time limit (2.2.1). The non-blocking bar is never the only way to learn of the change: the blocking dialog follows the first refused call.

**What the design does not claim.** Whether the pipeline assigns the increasing release number and produces `release.json` is the DevOps confirmation DEV-1 (HEAAA-50). The 5 minute interval is DEVOPS-PLAN 6.2's. Real wording and the 30 minute reminder are a proposal for the reviewers, not a decision.

## 8. Safety-critical patterns

Each needs a negative-path test and clinical safety review (PRD 7). The patterns below are design proposals; wording requires the clinical safety reviewer (D-12).

| Pattern | Design |
| --- | --- |
| **Wrong-patient prevention** (BR-34) | Sticky patient banner (UX-R1). Before signing a note or prescription, the confirm dialog restates name + DOB. Two charts open in tabs show the patient name in the browser **window** only through the banner, never the tab title (UX-R4). Consider a distinct banner stripe colour per open chart; not required for R1 |
| **Allergies and uncoded items** | Allergy block on the banner in red with text. Uncoded allergy or medicine entries carry a chip "Uncoded: needs review" and, from R2, require acknowledgement in checks (SA-F-08) |
| **Drug alerts (R2, BR-15/16)** | Panel splits "Serious" (blocks signing until changed or an override reason is chosen/typed) from "Other" (acknowledge). Override is logged and the reason shown next to the medicine afterwards. No auto-dismiss, no dark patterns. Alert text is read in full by screen readers |
| **Signing** (BR-11, BR-17) | Dialog: patient name + DOB, what will be locked, re-authentication only when the server requires it (§7.1), button "Sign and lock note". After sign, note is read-only with "Add addendum". EPCS signing (R2) is a separate dialog that shows the two-factor step and the prescriber identity status; if the user is not identity-proofed the dialog states the reason and offers no override |
| **Consent gate** (BR-09) | "Start consultation" is disabled with the reason "Telehealth consent not signed." and a link to send/sign it. Emergency exception is a separate secondary action requiring a reason, recorded (X-07) |
| **Red flag** (BR-10, X-06) | Full-width danger bar, has no Dismiss or close control. Nurse side it is a status, not an action: saving triage already alerts the on-duty doctor in the same transaction. **UXR-08, option B:** the nurse bar shows only what the triage response gives the creator (`redFlag`, `alertId`): "Red flag raised. The on-duty doctor has been alerted." It shows no doctor name, no countdown, no "Escalated to", no acknowledged state, because no route returns target names, `escalatesAt` or `status` to the nurse who raised the flag (ARCH 29.3: `GET /alerts`, `open-ids` and the stream are own-targets only). The bar does not claim that the doctor has seen it; the nurse follows the clinic's own red-flag procedure and the screen does not replace it. If the Architect later adds a creator-readable alert status (UXR-08 option A, 13.2), the name, countdown and acknowledged state return here by the 7.4 rule. The doctor side keeps the full countdown in the tray (7.4). Nurses cannot acknowledge or close the bar (UXR-02); for the patient, a screen with the fixed emergency text and a call button on phones. No clinical advice beyond the reviewed text |
| **Out-of-range vitals** | Driven by the stored `rangeStatus` of each vital (AL-02, ARCH 22.11; the range table `clinical.vital_range` ships empty until the D-12a reviewer enters content). Never blocks saving. States: `out_of_range` = red border + the words "Out of range" + the value + "Range {low}-{high} {unit}", or "Range at least {low} {unit}" / "Range at most {high} {unit}" when only one bound is set (UXR-11; `low` or `high` may be null, ARCH 22.11); `in_range` = value with the same range text in neutral text, no green tick and no reassurance text; `no_range` = value only, with the neutral note "No reference range set", never drawn as normal or as out of range; `unit_mismatch` = value, with "Unit differs from the reference range, range not applied" and the entry form is meant to offer the range's unit for that code, but the staff realm has no read of range units (only the admin `GET /admin/vital-ranges`), so the entry form does **not** offer it until the Architect adds a route or drops the sentence (UXR-11, 13.2); `entered_in_error` (value empty) = struck-through history row with "Entered in error", no range. Bounds shown are the ones stored on that reading, so an old reading keeps the range it was judged against. Not designed in R1 (ARCH non-goals): percentile ranges for children, condition or pregnancy ranges, unit conversion. Nothing in the UI states or implies that a range is clinically validated |
| **Break-the-glass** (BR-14) | Dialog "This patient is not assigned to you." Reason required (free text, at least 10 characters; a selection may only prefill the text) (UXR-05), consequence stated: "Your access is logged and reviewed by compliance." Banner on the chart shows "Emergency access" until closed |
| **Critical result (R3, BR-25)** | Persistent alert, acknowledge required, escalation countdown visible; window from the clinical safety reviewer (D-11) |
| **Result release (R3, BR-26)** | Doctor sees "Releases to patient: now (normal)" or "Held for your review: abnormal" with the deadline in text |
| **Controlled hand-over (R2, BR-22)** | Pharmacy form has required fields: ID checked (checkbox), who received it (patient / authorised proxy), name. Submit disabled until complete |
| **Delivery status order** (BR-24) | Timeline only moves forward. A late "Ready" after "Out for delivery" is kept in history but does not move the current status back |
| **Merge** | Staff only; shows both records' non-clinical identifiers, a typed confirmation of the survivor's MRN, and an audit note |
| **Not acknowledged in 2 h (R2)** | Patient and care team see "The pharmacy has not confirmed yet" with "Choose another pharmacy" (J-13, BR-20). Definition of "acknowledged" is D-10 |

## 9. Responsive behaviour

**Breakpoints (Proposal).** 360 (design floor, NFR-11) · 600 · 768 (tablet) · 1024 · 1280 · 1440. Layouts reflow, never scroll horizontally at 320 CSS px with text zoom 200 % (WCAG 1.4.10 reflow). Content is not limited to one orientation.

| Surface | Phone (360–599) | Tablet (600–1023) | Desktop (1024+) |
| --- | --- | --- | --- |
| Brand site | Single column, sticky Book button, filters in a sheet | Two columns, filters inline | As mockup |
| Patient portal | **Mobile-first.** Bottom tabs, one task per screen, 44 px targets, full-width primary button, slot list in two columns | Side navigation, two panes for booking | Stepper with summary side card |
| Pre-consultation | Alerts, check-in and read-only boards. Table becomes cards with the same fields. Triage entry not offered under 600 px ("Open on a tablet or computer") | **Primary tablet target** at the desk. Board and triage panel as two panes, 44 px targets | Two panes as mockup |
| Doctor | Alerts, schedule, chart read. Note writing offered but secondary; sign requires full-width dialog | Chart and note as tabs or split pane | Chart left, note right as mockup |
| Partner pharmacy | Queue cards with 44 px Accept/Review; detail in a full screen | Queue + detail split | As mockup |
| Admin | Audit read and alerts; config shows "Use a larger screen" for complex editors | Read and light edit | Full |

Data tables: sticky header; on narrow widths each row becomes a card; the primary identifier and status stay first. Column choice for cards is part of each build ticket.

**Input.** All controls work with touch, mouse and keyboard. No hover-only content. No drag-only action (WCAG 2.5.7): rescheduling by drag in the schedule view has a "Move to…" menu alternative.

**Browsers.** Current Chrome, Safari, Edge, Firefox; phones from 360 px (NFR-11).

**Performance as design constraint.** LCP < 2.5 s on 4G (NFR-7): no auto-play video or large hero images on the brand site; images sized and lazy-loaded; skeletons instead of spinners; the first view of every portal loads critical data in one call where the contract allows (UX-A-11).

## 10. Accessibility: WCAG 2.2 AA (NFR-10)

### 10.1 Design requirements

| Area | Requirement (criterion) |
| --- | --- |
| Colour and contrast | Text ≥ 4.5:1, large text and UI components ≥ 3:1 (1.4.3, 1.4.11). Calculated in BRAND-BRIEF section 4 for the placeholder tokens. Status never by colour alone (1.4.1) |
| Focus | Visible 3 px ring with offset on every interactive element (2.4.7, 2.4.13 is AAA, but the design meets it). **Focus is never hidden behind sticky headers, patient banner, cookie banner or alert bar** (2.4.11): scroll-padding equals sticky height |
| Keyboard | Everything works by keyboard (2.1.1). No traps (2.1.2). Logical tab order. Shortcuts can be turned off or need a modifier (2.1.4). Table navigation with arrows is additional, not the only way |
| Targets | 24 × 24 minimum (2.5.8); design uses 44 on touch layouts |
| Forms | Visible labels (not placeholder only), hints, errors tied with `aria-describedby`, error summary with focus (3.3.1, 3.3.2, 3.3.3). **No retyping of data already given in the same flow** (3.3.7): booking, triage and prescribing carry values forward. Autocomplete attributes on identity fields (1.3.5) |
| Authentication | No cognitive function tests, paste allowed, passkeys first (3.3.8) |
| Help | Help link in the same place on every screen (3.2.6) |
| Structure | One `h1` per screen, landmarks (header, nav, main, footer), skip link (2.4.1), page titles by screen type without PHI (2.4.2) |
| Names and roles | Custom controls follow ARIA authoring practice via Radix/React Aria primitives (ARCHITECTURE section 12, UI row) (4.1.2) |
| Live updates | Alerts use `role="alert"` (red flag, critical) or `role="status"` (saves, holds). No more than one assertive announcement at a time. Countdowns are not announced every second (4.1.3) |
| Motion | `prefers-reduced-motion` respected; no flashing (2.3.1) |
| Video | Telehealth room: captions control and keyboard-operable controls. Brand-site video has captions and transcript (1.2.2, 1.2.1) |
| Language | `lang` set; mixed-language doctor names marked (3.1.1, 3.1.2). Layout tolerates 30 % longer strings and RTL if S-priority multilingual is later adopted (F-BS-06) |
| Zoom | 200 % text and 400 % zoom without loss (1.4.4, 1.4.10); text spacing overrides survive (1.4.12) |
| Time | Timeouts warn and can be extended (2.2.1); the hold countdown states what happens at zero |
| Documents | Uploaded PDFs are not guaranteed accessible; the viewer offers download and states when text is not available |
| Charts | Vitals trend has a table alternative and text summary (1.1.1) |
| Orientation | Not locked (1.3.4) |
| Reading level | Patient screens target plain language; fixed medical wording reviewed by the clinical safety reviewer |

### 10.2 How it is verified (planned; not yet run)

1. Automated scan (axe or equivalent) in CI on each portal's key screens (Frontend/QA; DevOps wires CI).
2. Manual keyboard-only run of each R1 journey.
3. Screen-reader run: NVDA + Firefox or Chrome on desktop; VoiceOver + Safari on iPhone; TalkBack on Android for the patient portal.
4. 200 % and 400 % zoom, reduced-motion, high-contrast (Windows) checks.
5. Contrast re-check when the real brand arrives.
6. UI/UX records the results against the build in BUILD_REVIEW with real screenshots. **Nothing in this document is accessibility test evidence yet.** The mockups cannot prove accessibility; they only show intent.

## 11. Content rules (summary)

- Buttons name the action and object. Error text: what happened, is data safe, what to do.
- No diagnoses, test names or medicine names outside the signed-in application. Service names that reveal a condition use the admin-set neutral display name (BR-23 extension).
- Whether a clinician's name may appear in messages is **BQ-2 (open, PM)**. Until decided, none does.
- Emergency copy is fixed, reviewed, and shown identically in all places (D-12a).
- Dates: "Wed, Nov 11 · 10:30 AM ET". Never ambiguous numeric dates in patient screens.

## 12. Component and state inventory for the build

Frontend will need, at minimum: App shell (portal accent, realm banner, help, user menu), Tabs, Stepper, Data table + card list, Filter bar, Status chip, Banner, Dialog (confirm risk, reauth, security key), Toast, Form field set, OTP input, Passkey prompt, Slot grid, Calendar week, Schedule day/week, Patient banner, Allergy block, Vitals form, SOAP editor with sign, Timeline, Alert bar + tray (with escalation countdown and paused-stream state), Release prompt (non-blocking bar, blocking dialog, confirm-reload dialog), Allergy block (recorded, none recorded, not shown, uncoded chip), Range text for vitals (five states), Upload with scan states, Document list, Message thread, Audit table with filters, BTG review panel, Empty/Error/Skeleton set. The design-system ticket belongs to the Delivery Planner; this list is input to it.

## 13. Needs routed to the Solution Architect and Product Manager

None of these is a decision. Each is a request to check feasibility or a gap in the contracts I could not see. IDs are mine and stable.

| ID | Need | To | Why (screen) |
| --- | --- | --- | --- |
| UX-A-01 | Hold response returns server `expiresAt`; confirm failure codes for hold expired (`scheduling.hold_expired`) and slot taken (`scheduling.slot_taken`) | Architect | PP-12/13 countdown and errors (X-01, X-02) |
| UX-A-02 | Slot search returns alternatives for the same doctor/service when a slot is taken, and next-available per doctor with a freshness timestamp | Architect | Mobile mockup 2; brand "updated ~1 min ago" |
| UX-A-03 | Slot search response flag `availabilityStale` on `POST /availability/search` (X-03; UXR-04) | Architect | Stale-data chip |
| UX-A-04 | Staff alert acknowledge endpoint and `escalatesAt` on each alert; alert types for red flag, BTG, R3 critical | Architect | Alert tray and countdown |
| UX-A-05 | Arrivals board: single call returning appointment, status, missing items, wait minutes, per location; define "wait" source | Architect | PC-01 |
| UX-A-06 | Architect: no 304/ETag, all routes no-store; portals refresh on focus/action/navigation only, no timer polling (UXR-01). Any live view needs a passive route | Architect | Updated-at text, battery/rate limits (CN-11) |
| UX-A-07 | `403 auth.forbidden` vs `404` copy: UI treats them as in section 6; confirm no endpoint leaks existence through other fields | Architect | CN-04 |
| UX-A-08 | Patient photo: where stored, who may set it, how the banner gets it without a PHI URL (signed short-lived image URL) | Architect | Patient banner (BR-34) |
| UX-A-09 | Allergy, medication and problem lists with coded/uncoded flag and last-reviewed date | Architect | Banner and chart |
| UX-A-10 | Vitals reference ranges: where configured and per-age/sex source; response includes range or flag | Architect + PM | Out-of-range warning |
| UX-A-11 | Per-portal "bootstrap" read that returns the home view in one call (or parallel-safe reads) | Architect | LCP target |
| UX-A-12 | Whether any draft may persist in browser storage (note drafts, forms) and clearing on sign-out. Default design: **server-side drafts only, no PHI in browser storage** | Architect + Security | Offline, session end |
| UX-A-13 | Self check-in QR: token content (no PHI), expiry, location binding | Architect | PP-20, PC-02 |
| UX-A-14 | Search by name/DOB uses `POST …/search` (CN-05): UI must not put terms in the URL. Confirm result shape without out-of-scope demographics (6.6) | Architect | PC-02, duplicate warning |
| UX-A-15 | Service neutral display name and a separate internal name in the catalogue API; brand site uses only the neutral name | Architect | BR-23 extension |
| UX-A-16 | Tracking-link field: URL validation and allowlist of pharmacy domains; link opened via interstitial | Architect + Security | PP-32 |
| UX-A-17 | Patient merge response `409 patient.merged` with optional survivor ID only if visible (9.2) | Architect | Merge handling |
| UX-A-18 | Elevation grant: state endpoint so the UI can show "Elevated until …" and handle expiry mid-form | Architect | Admin and privileged dialogs |
| UX-A-19 | Role changes/permissions seen by UI: the BA matrix is a proposal; UI gating is by capability flags returned by the API, never by role name | Architect | Permission-limited views |
| UX-A-20 | Draft 5 (AL-04): confirm the producer of the increasing release number and of `release.json` (DEV-1), and that the poll of it never carries a cookie | DevOps via Orchestrator | 7.7 |
| UX-P-01 | Confirm BQ-2: may a clinician's display name appear in messages? | PM | Notification content |
| UX-P-02 | Confirm whether fees/deposits (D-3), patient messaging (D-5), visit summary (D-6) stay in R1; designs for them are marked optional | PM | PP-13, messages, visit summary |
| UX-P-03 | Emergency advice wording and clinical thresholds need the clinical safety reviewer (D-12) | PM / owner | PP-22 and triage |

### 13.1 Dispositions from ARCHITECTURE draft 8.1 (draft 5)

| ID | Architect answer (ARCH draft 8.1) | What the design does with it |
| --- | --- | --- |
| UX-A-04 | `escalationLevel` and `escalatesAt` bound in `GET /alerts`, `open-ids`, SSE `alert` and the acknowledge response; null rule in 29.3; acknowledge idempotent; `409 notifications.alert_closed` | Countdown rule and null cases in 7.4 and the red-flag row of section 8. **Answered** |
| UX-A-09 | `patientBanner.allergies` with `state`, `items` (severe first, at most 10), `moreCount`, `uncodedCount`, `lastChangedAt`; `null` unless the caller has chart read or pre-visit read (28.2) | Allergy block rules in UX-R1. The "last-reviewed date" for list entries is not in the banner and remains a chart-list need for PM. **Answered for the banner (AL-01)** |
| UX-A-10 | `clinical.vital_range` table, ships empty, status stored per reading (22.11) | Five display states in the out-of-range row of section 8. Range content is BQ-12 to the D-12a reviewer. **Answered for the mechanism; content open** |
| UX-A-12 | Unchanged: no PHI in browser storage (26.2) | The unsaved-input rule in 7.7 relies on it. Unchanged |
| BQ-11 | R1 has no "no known allergies" assertion | Wording "No allergies recorded" (UX-R1). If PM adds the assertion, the text changes, nothing else |
| BQ-12 | Vital range content and number of escalations | The UI shows what the API returns; no default range text exists in the design |

### 13.2 Open Architect items from the draft 5 review (HEAAA-54 `ui-ux-draft5-review` rev `6772bc50`)

The design is written so that it builds on the current contract. These items stay open until the Architect answers; none blocks the UX text.

| ID | Question to the Architect | Design state meanwhile |
| --- | --- | --- |
| UXR-08 | Add a creator-readable red-flag status (option A, for example `{alertId, status, escalationLevel, escalatesAt, targetDisplayNames, acknowledgedByDisplayName}` and how it refreshes, 26.2)? | Option B in section 8: nurse bar is "Red flag raised. The on-duty doctor has been alerted.", no name, countdown or acknowledgement. QA red-flag cases follow option B |
| UXR-09 | Optionally add `acknowledgedByDisplayName` to the acknowledge response | "Already acknowledged", name after the next `GET /alerts` refresh (7.4) |
| UXR-10 | Align the ARCH 28.2 `null` sentence ("banner without the allergy block") with the UX chip "Allergies not available with your current access" | UX chip stays; the two documents disagree until 28.2 is changed |
| UXR-11 | Give the staff realm a read of range units per vital code, or drop the "offer the range's unit" sentence in 22.11 | Entry form does not offer the unit (section 8) |
| UXR-12a | Does `GET /appointments/{reservationId}` return a held reservation, with `reservationId` kept in the route? Or name the route that lists holds | Fallback in 7.7: the patient chooses the slot again after a reload |

## 14. Open items and decisions needed

| ID | Item | Owner | Effect |
| --- | --- | --- | --- |
| UX-O-01 | **Brand files missing** (`docs/intake/brand/` does not exist). Name, logo, colours, fonts, tone, photography | Owner | Placeholder visual identity until supplied. G2 cannot approve identity without it or an explicit decision |
| UX-O-02 | CMS UI is off-the-shelf; owner to confirm a configured CMS editor is acceptable for marketing staff, or ask for a custom editor (cost) | Owner via PM | Scope |
| UX-O-03 | Languages at launch (B8). English only until decided; RTL not designed | Owner | Layout margin only |
| UX-O-04 | Operating states (D-2): telehealth state-of-location confirmation list | Owner | PP-23 |
| UX-O-05 | Proxy visibility (D-7). Design shows appointments only | Owner / clinical reviewer | PP-06..09 |
| UX-O-06 | Patient queue position visible to patients? (not in PRD; I assume only "Doctor will join in about N min") | PM | Waiting room |
| UX-O-07 | Whether a native-like install prompt (PWA) is wanted. Not designed | PM | None |
| UX-O-08 | Independent accessibility specialist review is not in the plan; one person holds every gate. Recommend a specialist or user test before go-live | Owner | Risk (RK-5) |
| UX-O-09 | Hard-to-judge screens (R2/R3) are specified by pattern only | UI/UX | Further design at R2/R3 planning |

## 15. Visual verification plan for the build (BUILD_REVIEW)

When screens exist, UI/UX compares the running candidate to this design for each R1 journey at 360, 768 and 1280 px: layout, patient banner presence, states in section 6, focus order and visible focus, contrast with measured values, text zoom and reduced motion. Findings get stable IDs `UXV-nn`, are tied to the candidate commit and screenshot hashes, and are cumulative across rounds (maximum three consolidated rounds). Real screenshots are taken by running the candidate; **the mockups are never reused as evidence**. Draft 5 adds these checks: the banner allergy block in its states (recorded, none recorded, not shown for the role, uncoded chip, "+n more") on every screen that shows or edits clinical data, including pre-visit staff screens and the phone collapse; the escalation countdown from `escalatesAt` (null cases, escalated, already acknowledged, closed); the five vital range states; and the release prompts (non-blocking bar, confirm-reload with unsaved input, blocking dialog, paused-alerts bar) with an unsaved form to prove that nothing is lost without a confirmation.

## 16. Limitations

- No brand files; all colour, type and logo are placeholders.
- Mockups are static and drawn by hand-coded vector shapes; they were visually inspected by me only. They are not user-tested and not accessibility-tested.
- Contrast ratios were calculated for token pairs, not measured in a browser.
- I could not see HEAAA-13 contracts; section 13 lists what I need confirmed.
- R2/R3 screens are patterns, not final.
- Draft 5 changes only text. The mockups are unchanged from draft 4 (hashes in `MOCKUP-MANIFEST.md`); they do not show the allergy `null` state, the countdown null cases, the vital range states or the release prompts. Those are specified in text and checked at BUILD_REVIEW.
- This draft has no independent review yet and no human approval.

## 17. Next permitted action

Independent review of draft 6, limited to its diff from draft 5 (UXR-08..12, section 18 round 5), by the Solution Architect Reviewer. The Product Manager check of the desktop image is still pending and now covers the draft 6 image. This task is the bounded cycle opened by confirmation `5e0ef519`: no further UX edits are made, and any unresolved finding goes back to the Orchestrator for a human decision. After revision against findings the package goes to the Delivery Planner for the G2 package. The human UI/UX decision at G2 is the owner's.

## 18. Revision log (cumulative)

| Round | Finding | Status | Change |
| --- | --- | --- | --- |
| 1 | PMR-01 No patient screens for F-PP-07 | Addressed, review pending | PP-25, PP-26, PP-27 added to the J-06 row in section 4 |
| 1 | PMR-02 Nav items without screens | Addressed, review pending | Three rows added to section 4 (PP-35..37, DR-11..13, PC-07/08); messaging marked optional until D-5 |
| 1 | PMR-03 Phone banner dropped photo | Addressed, review pending | UX-R1 keeps the avatar in the collapsed banner |
| 1 | PMR-04 Red-flag "Dismiss" contradicts section 8 | Addressed, review pending | Desktop mockup 3 button changed to "Reassign"; sections 5 and 8 aligned |
| 1 | PMR-05 Unsupported claims in mockups | Addressed, review pending | "30+ clinics", "Free cancellation until 24 h before" and "Nothing was charged" removed or replaced by marked placeholders in both images |

Images were re-rendered from the edited SVG sources; hashes are in `MOCKUP-MANIFEST.md`. Owner decisions UX-P-01..03, UX-O-06/07 and brand files UX-O-01 remain open for the G2 package.

### Round 2 (Architect, contract feasibility; draft 3)

| Round | Finding | Status | Change |
| --- | --- | --- | --- |
| 2 | UXR-01 Portal polling resets idle timer | Addressed, review pending | 7.4: no timer polling; refresh on focus/action/navigation; waiting room 5 s passive only; UX-A-06 reworded |
| 2 | UXR-02 Red-flag bar actions not in contract | Addressed, review pending | Section 5 and 8 and desktop mockup 3: read-only status, no buttons, no dismiss (PMR-04 kept) |
| 2 | UXR-03 Note signing always re-auth | Addressed, review pending | 7.1: re-auth only on `auth.reauth_required`, same idempotency key, draft kept |
| 2 | UXR-04 `calendarBusyStale` name | Addressed, review pending | UX-A-03 uses `availabilityStale` |
| 2 | UXR-05 BTG reason selection | Addressed, review pending | Section 8: free text, min 10 characters; selection may only prefill |

Architect dispositions for UX-A-01..19 are accepted as given. Architect-owned gaps (`escalatesAt`/`escalationLevel` on alerts, arrivals board fields) go to HEAAA-13 via Orchestrator. UX-A-09 last-reviewed date and UX-A-10 range source go to PM/clinical reviewer.

### Round 3 (Architect, draft 4; bounded fix cycle approved by confirmation `c40be67a`)

| Round | Finding | Status | Change |
| --- | --- | --- | --- |
| 3 | UXR-02 residual "Reassign" button in triage panel | Addressed, review pending | Button removed from desktop mockup 3 (the contract has no reassign operation); image re-rendered |
| 3 | UXR-06 Re-authentication wording unconditional | Addressed, review pending | Section 4 J-09 row and section 8 Signing row now say re-authentication only when the server requires it (7.1) |
| 3 | UXR-07 Stale header and section 17 | Addressed, review pending | Header and section 17 show draft 4 and the current review state |

### Round 4 (HEAAA-17 alignment findings; draft 5; bounded correction cycle `a524dfdd`)

Ledger is cumulative and not reset: UX rounds 1-3 (PMR-01..05, UXR-01..05, UXR-02 residual, UXR-06, UXR-07) used three rounds; this is the one extra bounded cycle a human accepted. Finding IDs are the alignment IDs from HEAAA-17 `design-align` rev `4447e3ec`, section 4.

| Round | Finding | Status | Change |
| --- | --- | --- | --- |
| 4 | AL-06 UI/UX documents stale | Addressed, review pending | Draft 4 files copied unchanged from `9dcb7aa` into the task documents `ui-ux`, `brand-brief`, `mockup-manifest` (revision 1 each) and the two PNGs attached. Hash check: `UI-UX.md` `1176b121`, `BRAND-BRIEF.md` `d27cbb5b`, `MOCKUP-MANIFEST.md` `3b99fe3e`, PNGs `cda636a8` and `01d432df`, all equal to `9dcb7aa`. Draft 5 is revision 2 of `ui-ux` and `mockup-manifest` |
| 4 | AL-04 UX part: reload prompt and form preservation | Addressed, review pending | New 7.7, two state rows in section 6, UX-A-20, component list, visual checks |
| 4 | AL-01 banner allergy flag (UX follow-up to the Architect's decision) | Addressed, review pending | UX-R1 allergy block rules (recorded, none recorded, null for the role, uncoded, phone); UX-A-09 disposition in 13.1 |
| 4 | AL-02 alert countdown and vitals ranges (UX follow-up) | Addressed, review pending | 7.4 countdown rule and null cases; red-flag row; five vital range states in section 8; UX-A-04 and UX-A-10 dispositions in 13.1 |

`BRAND-BRIEF.md` is unchanged in draft 5 and still reads draft 2 inside the file; the reviewed file is what the AL-06 check binds to. Images are unchanged.

### Round 5 (HEAAA-54 review of draft 5; draft 6; bounded cycle opened by confirmation `5e0ef519`)

Ledger cumulative, not reset. Findings are those of HEAAA-54 `ui-ux-draft5-review` rev `6772bc50`. Architect-owned parts are listed in 13.2 and stay open.

| Round | Finding | Status | Change |
| --- | --- | --- | --- |
| 5 | UXR-08 (M) Nurse red-flag bar has no read route | UX part addressed (option B), Architect decision on option A open | Section 8 red-flag row, section 5 Desktop 3 row, desktop mockup 3 text now "Red flag raised. The on-duty doctor has been alerted."; 13.2 |
| 5 | UXR-09 Acknowledged-by name source | UX part addressed | 7.4: "Already acknowledged", name after `GET /alerts` refresh; optional Architect field in 13.2 |
| 5 | UXR-10 Banner `null` wording | UX part addressed, Architect alignment of ARCH 28.2 open | UX-R1 chip "Allergies not available with your current access" |
| 5 | UXR-11 One-sided ranges, range unit source | UX part addressed, Architect route open | Section 8 one-sided forms; "offer the unit" not offered until a route exists |
| 5 | UXR-12 Hold restore and 401 order | UX part addressed, Architect answer on (a) open | 7.7 fallback and the order sentence; 13.2 |
