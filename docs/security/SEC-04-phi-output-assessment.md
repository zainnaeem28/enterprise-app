# SEC-04 Security assessment: documents, notifications and PHI-in-output controls

Ticket HEAAA-122 (SEC-04) · release R1 · milestone M3 · author: Cybersecurity (`83cd0a46`) · reviewer stage: Security Reviewer (`074b2525`)
Requirements: RA-R1-05, RA-R1-13 · PRD BR-23, BR-36 · ARCHITECTURE 25.10, 6 · TEST-CASES 7.4, 9.3

## 1. Scope, revision and method

**Assessed revision.** Branch `HEAAA-106-sdlc-ticket-be-14-...` at commit `8b513b76dfa9e046c8daf577ac12a5ad5b4f7349` (BE-14). It contains both prerequisite commits as ancestors, checked with `git merge-base --is-ancestor`:
- BE-10 documents: `50ba541881e10c9fa6003ba7cdd2f88dac6e10d0` (HEAAA-92)
- BE-06 notifications: `49155ff752eec6d492adf0b9a84982df8c04f348` (HEAAA-84)

None of these commits is on `main`, because nothing past the intake pack is integrated yet. If the integrated tree differs, the affected findings need a re-read against that revision.

**Method.** Static, read-only review of a `git archive` extract of the commit. Nothing was executed against it:
- **No tests were re-run.** The dbtests from BE-10, BE-06 and BE-14 (21/21, 33/33 plus 20/20, 63/63) were run by their reviewers. I rely on those reports and did not repeat them.
- **No active probing.** There was no dynamic testing, no scanner run and no network call. No tool was configured: no SAST, secret or dependency scan.
- **No code changed.** The only file written is this document.

**Surfaces reviewed (acceptance list).**

| Surface | Files read |
| --- | --- |
| Upload and scan path | `documents/service.ts` (`createUpload`, `completeUpload`, `downloadUrl`), `documents/ports.ts` (presigner), worker `await-scan.ts`, `sniff.ts`, `ocr-suggest.ts`, `ports.ts` |
| Object keys | `q/<128-bit random hex>` (quarantine) and `c/<128-bit random hex>` (clean) |
| Email, SMS, push, in-app | `notifications/allowlist.ts`, `forbidden.ts`, `render.ts`, `r1-templates.ts`, `send.ts`, worker `send-message.ts`, `adapters.ts`, `recipient.ts` |
| `.ics` and calendar content | `render.ts` (ics channel), `r1-templates.ts` (`ICS()`), worker `calendar-sync/google-adapter.ts`, `push-busy.ts`, `ids.ts` |
| Logs | kernel `logging/redact.ts`, API `platform/filter.ts`, worker `integration-core/call-vendor.ts`, migration 0400 (`outbound_call`) |

## 2. What holds (verified by reading the code)

1. **No filename reaches storage.** `createUpload` checks `fileName` against the type but never stores or signs it. Keys are `q/` or `c/` plus 16 random bytes. The upload URL is bound to key, type and length for 300 s. The download URL is for the clean bucket only and lasts 60 s. Audit rows carry IDs and action names only.
2. **Notification content is structural, not scanned-for.** A template can bind only 12 allowlisted variables of 6 types. The type checks are strict: ISO datetime, https URL on an allowed host, `[A-Za-z0-9]{4,12}` code, IANA zone, UUID. `location_name` is the only free text (1 to 80 characters, no markup).
   - The allowlist is enforced in four places: the service, a DB CHECK/trigger (0600), the render check at publish, and a final scan of rendered output in the send job. The send job fails closed with `phi_guard`.
3. **Address and message text are never stored or logged.** The recipient is a reference (`patient:<uuid>`). The address is resolved at send time. Adapters throw a fixed `bad_arguments` and never echo arguments. `outbound_call` rows hold IDs, an error class and the vendor reference, with no payload. The dedupe key may not contain the recipient ID.
4. **`.ics` is minimal.** `SUMMARY:Appointment`, a location name, the start and end, a UUID and a portal link. Values are escaped for RFC 5545 and lines are folded. The renderer takes no free text.
5. **Calendar sync to Google is "Busy" only.** The event carries start, end, `summary: Busy`, `visibility: private` and no reminders. The list call uses a `fields` mask that excludes title, description and attendee names.
6. **Logs.** The redactor allowlists field names, so unknown string fields become `[redacted]`. The error filter logs the error class and SQLSTATE and never the message or URL. The documents and notifications code logs IDs and classes only.

## 3. Findings

Severity scale: Critical / High block advancing; Medium needs a correction or an explicit, recorded risk acceptance; Low / Info are hardening. **No finding below is Critical or High, so none blocks SEC-04 or its consumers.** Every ID is stable across rounds. Owner is the role or ticket that should fix it. Parent is the lane the correction ticket sits under. `Routing` is a request to the Orchestrator: this ticket cannot create or assign work outside its allowed paths.

### SEC04-F01 · Medium · Action links are validated for host only; nothing governs their path, query or token
- **Where:** `allowlist.ts` `normaliseValue('url')`; `confirm_link`, `reschedule_link`, `cancel_link` and `sign_in_link` in `r1-templates.ts`.
- **Issue:** A link passes if it is https, on an allowed host, 500 characters or fewer, with no credentials. Path and query are unrestricted. A caller can put a patient ID, a reservation ID, a name or a long-lived token in a link that is then sent in clear over SMS and email. The final output scan only looks for condition words.
- **Evidence at this revision:** The only producers present are pre-visit and waitlist, and they pass the static `portalUrl`. No code yet produces `confirm`/`reschedule`/`cancel` links. The 48 h and 4 h reminder templates require them, so the producer is a future ticket.
- **Failure scenario:** The reminder producer builds `https://portal.example/c?patient=<uuid>&res=<uuid>`. The ID lands in the SMS, in the carrier and provider logs, in the browser history, and in a `Referer` header if the page loads third-party content. A link with a replayable token lets whoever holds the message cancel or confirm.
- **Remediation:**
  - Require links to be one-time or short-lived, bound to the recipient, and opaque. They must carry no patient, reservation or name identifier in clear.
  - Enforce a path/query shape per link variable in `normaliseValue`, for example `[A-Za-z0-9_-]{22,64}` for the token.
  - Add a canary test that a patient UUID or name in a link is refused.
  - The landing page must send `Referrer-Policy: no-referrer` and must not load third-party resources.
- **Owner / parent:** Backend Engineer who builds the reminder producer (BE scheduling-flow lane); contract owner Architect for the token shape. Parent HEAAA-25.

### SEC04-F02 · Medium · `location_name` condition check is a keyword list; specialty-revealing location names can pass
- **Where:** `forbidden.ts` and `send.ts` `cleanValues` (the only free-ish text in any message, `location_name`).
- **Issue:** BR-23 and BR-36 forbid any service, clinician or condition in a message. A location label like "Women's Health Suite", "Urology Rooms", "Dermatology", "Cardiology", "Gynaecology", "Paediatrics" or "Methadone Programme" is partly or wholly outside the regex list. The list catches many terms (oncology, rehab, sexual health, hepatitis), but it is a denylist and the code comment itself calls it a second line.
- **Failure scenario:** An administrator names a site after a specialty clinic. Every confirmation, reschedule and `.ics` shows it. SMS and calendar entries on a lock screen reveal the condition class.
- **Remediation:**
  - Make `location_name` come from a separate administrator-approved "patient-facing site label" setting with an explicit attestation that it names no specialty.
  - Keep the denylist, and extend it with specialty names (dermatology, urology, cardiology, gynae*, paediatric*, women's/men's health, and similar) for each configured language.
  - Add a render-check negative test for the extended list.
  - Record that a keyword list cannot prove absence.
- **Owner / parent:** Backend Engineer (notifications module owner); Product Manager decides the label rule. Parent HEAAA-25.

### SEC04-F03 · Medium · Third-party delivery of appointment content is unproven and needs a recorded human risk acceptance
- **Where:** `adapters.ts` (`ProviderClient` is injected; no real provider; C-10/C-11 not chosen); BR-23.
- **Issue:** Each message still states that the person has an appointment at the named location and when. That is the intended design, but it reaches carriers, a mail provider and a push service, and it sits on lock screens and in mail archives.
- **Not controlled in code, and not verifiable here:**
  - the provider's retention of message bodies and logs
  - TLS enforcement for mail
  - a BAA/DPA with the provider
  - sender identity (a short code or From name itself names the clinic)
  - push payload visibility on the lock screen
- **Failure scenario:** The provider keeps SMS bodies for 90 days. A breach at the provider exposes patient phone number, clinic and appointment time.
- **Remediation:**
  - Before any real send, DevOps and the human owner must record: the chosen provider, a BAA/DPA, retention and log settings, mandatory TLS, and a sender name that does not reveal a specialty.
  - A human decision accepts the residual disclosure (clinic name plus time) at G3.
  - Push text stays generic ("appointment", no time) unless the human accepts it.
  - A staging check with a synthetic address must show that the provider's log has no body, or document that it does.
- **Owner / parent:** Orchestrator for the vendor decision (C-10/C-11); DevOps for configuration; human for acceptance. Parent HEAAA-25.

### SEC04-F04 · Medium · OCR sends whole patient documents to an unchosen third party; the access path is undefined
- **Where:** worker `ocr-suggest.ts` (`callVendor('ocr', 'classify', { bucket: 'clean', key })`).
- **Issue:** The vendor receives a bucket/key and must read the file. How it gets access (a presigned GET, a role, a copy) is not defined in code. The files are insurance cards, ID documents, consents and external records. No OCR vendor is chosen (C-10).
- **Failure scenario:** The implementer hands the vendor a long-lived presigned URL or a broad read role on the clean bucket. The vendor retains or trains on identity documents.
- **Remediation:**
  - Make OCR strictly optional and off by default. It is already `skipped` when disabled.
  - Before it is enabled, require: a BAA/DPA, no-retention and no-training terms, a per-object short-lived URL (60 s or less) or a vendor-side upload, data residency, and the vendor named in the privacy notice.
  - The adapter must never log the URL.
  - A human decision is required, and no vendor contact is authorised by this ticket.
- **Owner / parent:** Orchestrator (vendor decision); Integration/Backend Engineer for the adapter; human gate. Parent HEAAA-25.

### SEC04-F05 · Low · One-time sign-in codes persist in `notification.variables` and in the export part (carries SEC-BE06-N1)
- **Where:** `send.ts` inserts `variables` as given; `merge.ts` `exportPart`; `listInApp` returns `variables`.
- **Issue:** The `code` value stays in the row after delivery. The BE-06 Security Reviewer accepted it for R1 and asked for a follow-up. Nothing at this revision blanks it.
- **Failure scenario:** A data export or a read of the table by an authorised role recovers a past code. The code is short-lived, so the practical risk is small.
- **Remediation:** Blank `variables.code` when the row reaches `sent`, `suppressed`, `failed` or `cancelled`. Never return `code` from `listInApp` or `exportPart`. Add a test.
- **Owner / parent:** Backend Engineer (notifications module). Parent HEAAA-25. Not blocking.

### SEC04-F06 · Low · Log redaction safe-keys include `name`, `message` and `msg`, and the patterns miss common identifier shapes
- **Where:** kernel `logging/redact.ts`.
- **Issue:**
  - A string under `name`, `msg`, `message`, `code` or `event` is kept and only pattern-scrubbed.
  - The patterns cover email, SSN, phone, ISO dates, bearer tokens, JWTs and "CANARY". They do not cover personal names, street addresses, `DD/MM/YYYY` or `12 Jan 1980` birth dates, or medical record numbers.
- **Failure scenario:** A future `log.info('registered', { name: patient.fullName })` writes the name. The structural defence is "log IDs only", which the code follows today. The redactor is the second line and it is weaker than it reads.
- **Remediation:** Remove `name` from the safe keys, or restrict it to a fixed set of values. Extend the scrub patterns (non-ISO dates, MRN shape). Add a lint rule or review checklist: no free text in log fields. Add a canary corpus test of names and addresses across worker and API loggers.
- **Owner / parent:** Platform/Foundation owner (kernel logging). Parent HEAAA-25.

### SEC04-F07 · Low · Scan and download hardening that depends on the real object store (carries SEC-BE10-O1 and O2)
- **Where:** `ports.ts` presigner (test-only), `await-scan.ts`, `sniff.ts`.
- **Issues:**
  - **O1.** The scanner verdict for the quarantine key is not bound to the object version, ETag or hash. The worker then reads the bytes, so a replaced object between scan and read is not detected.
  - **O2.** PDFs get only a `%PDF-` prefix check and are not rewritten. The GET presigner sets no `Content-Disposition: attachment` and no `X-Content-Type-Options: nosniff`. Images get a container-level metadata strip only, with no pixel re-encode.
  - **O3.** The `uploads_per_day` count is soft under concurrency (BE-10 reviewer note).
- **Failure scenario:** A polyglot PDF with active content passes a weak scanner and is served inline from a bucket origin. A quarantine PUT overwrites the object after the verdict.
- **Remediation:** At staging:
  - bind the verdict to the object version/ETag, or recompute the hash after reading and compare
  - make the quarantine bucket reject overwrite after the scan tag
  - set `response-content-disposition=attachment` and `nosniff` on the real presigner
  - serve from an origin that is not the application origin
  - decide the image re-encode dependency (README O-5)
- **Owner / parent:** DevOps (bucket and presigner configuration) with the BE-10 owner. Parent HEAAA-25. Not blocking at this revision; it blocks real-data use.

### SEC04-F08 · Info · Internal occupancy ID appears in the Google event ID
- **Where:** `calendar-sync/ids.ts` `eventIdFor` (`ehr` plus the occupancy UUID).
- **Issue:** The event ID is derived from the internal occupancy UUID and is visible in the doctor's Google calendar. It is not a patient identifier and not PHI. It is a stable internal reference, only meaningful with database access.
- **Remediation:** Optional. Derive the ID as an HMAC of the occupancy ID to avoid exposing an internal key. Record the decision either way.
- **Owner / parent:** Backend Engineer (calendar sync). Parent HEAAA-25. Optional improvement, not a defect.

### SEC04-F09 · Info · `.ics` `DTSTAMP` is set to the event start
- **Where:** `r1-templates.ts` `ICS()` (`DTSTAMP:{{start_at}}`).
- **Issue:** RFC 5545 expects `DTSTAMP` to be the creation time. Using the start is not a PHI risk, but a client may treat an update as stale or ignore it. Also the `.ics` is `METHOD:PUBLISH`, so the recipient's calendar app copies it into whichever cloud calendar it syncs to. That disclosure is by design and covered by F03.
- **Remediation:** Add a `created_at` datetime variable, or emit the render time in the worker. Not a security defect.
- **Owner / parent:** Backend Engineer (notifications module). Parent HEAAA-25.

## 4. Acceptance coverage

| Acceptance item | Result |
| --- | --- |
| Upload and scan path reviewed for PHI | Done (sections 2.1, F04, F07). No PHI in keys, URLs, audit or logs. |
| Object keys | Done. Random 128-bit, no PHI, no filename, no extension. |
| Email, SMS, push content | Done (2.2, F01, F02, F03). |
| `.ics` / calendar content | Done (2.4, 2.5, F08, F09). |
| Logs | Done (2.3, 2.6, F06). |
| Findings routed | Nine findings with stable IDs, severity, owner and parent. No finding blocks. |

## 5. Limitations (not waived)

- Static review only. I ran no tests, probes or scanners, and no secret, dependency or SAST tool is configured.
- Real providers (e-mail, SMS, push, OCR, scanner, object store) do not exist yet (C-01, C-10, C-11). F03, F04 and F07 describe what must be proven when they do.
- The patient portal (FE-04) and the reminder producer were not part of the assessed tree for notification links. F01 is a requirement for them.
- This is not a review PASS, not human approval, and not a deployment statement.

## 6. Routing request to the Orchestrator

No finding is Critical or High, so no blocking correction ticket is required. Please create correction or tracking items under HEAAA-25 for F01, F02, F05 and F06, and fold F03, F04 and F07 into the DevOps and vendor-decision gates before any real data or real provider is used. F08 and F09 are optional. The cumulative round count for this ticket is round 1 and belongs in the ticket's `review-ledger` document.
