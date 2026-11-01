# 03 — Workflows and Business Rules

> **Status: CONFIRMED.** AI-prepared 2026-10-31. All sections Agreed by Zain Naeem (product owner) on 2026-10-31, and updated with his decisions of 2026-11-02 03:26 PKT (UTC+05:00) recorded in [07-OPEN-QUESTIONS.md](07-OPEN-QUESTIONS.md).
> Time windows, limits and fees below are **admin-configurable settings**; defaults are set in Plan & Design.

## 1. Appointment booking

1. The patient picks a service, then a doctor or "any available", a location or video, and a date.
2. The system shows slots computed from the doctor's availability template, minus existing bookings and minus busy times synced from the doctor's Google/Outlook calendar.
3. The patient confirms. The slot is held for a short configurable time during checkout so no one else takes it.
4. If the service needs payment or a deposit, the patient pays; otherwise the booking is confirmed.
5. Confirmation goes out by email/SMS with an .ics calendar file. The doctor's calendar gets a "Busy" block with no patient name.
6. Reminders go out at configurable times before the visit (two reminders by default), with links to confirm, reschedule or cancel.
7. The pre-visit questionnaire and consents are sent a configurable time before the visit.

**Statuses:** Requested → Confirmed → Checked-in → In consultation → Completed. Exits: Cancelled by patient, Cancelled by clinic, No-show, Rescheduled.

**Rules:**
- Patients may cancel or reschedule free until a cut-off set per service; after that a fee applies or the change is blocked, as configured per service.
- Double booking a doctor is impossible unless a slot is marked overbookable (maximum set per session by admins).
- When a slot frees up, waitlisted patients are offered it in order and have a configurable time to accept.
- Admins set the maximum number of future appointments a patient may hold per service.
- All times are stored in UTC and shown in the location's time zone. Video visits show both time zones when they differ.

## 2. Pre-consultation (triage)

1. The patient arrives or self-checks-in by QR code, or joins the virtual waiting room.
2. Pre-consultation staff review the questionnaire, consents and insurance, and mark missing items.
3. Staff record vitals; out-of-range values are highlighted.
4. Triage assigns an urgency category. A **red-flag answer** (for example chest pain) immediately alerts the on-duty doctor and shows emergency advice to the patient.
5. The patient is queued for the doctor or room, with the expected wait shown.

**Rule:** a consultation cannot start until required consents for that service are signed. Emergencies are the exception, and that exception is recorded.

## 3. Consultation and clinical documentation

1. The doctor opens the chart: summary, triage data, history, medications, allergies, recent results.
2. The doctor writes the note from a template, adding diagnoses, plan, orders, prescriptions and follow-up.
3. The doctor signs the note, which locks it. Later changes are addenda with author and time, never silent edits.
4. A visit summary is released to the patient portal per policy.

**Rules:**
- Trainee notes need a supervising doctor's co-signature before release.
- Every chart view is logged. Access to a patient outside the doctor's assignment needs a "break-the-glass" reason and is reviewed by compliance.

## 4. Prescribing and medicines processing

1. The doctor selects a medicine, dose, route, frequency, duration, quantity and refills.
2. The system checks allergies, drug–drug interactions, duplicate therapy and dose ranges using a licensed drug database. Serious alerts need a reason to override, and the override is logged.
3. The doctor signs. **Controlled substances (EPCS)** need DEA-compliant two-factor signing by an identity-proofed prescriber.
4. The prescription goes to the patient's chosen **external pharmacy** through the certified e-prescribing network (NCPDP SCRIPT). Partner pharmacies also see it in the partner pharmacy portal.
5. The pharmacy accepts it, queries the prescriber through secure messaging, or rejects it with a reason.
6. The pharmacy dispenses using its own systems and reports status: in progress, ready for pickup, out for delivery, delivered.
7. The patient sees each status change in the patient portal.

**Prescription statuses (as seen in our system):** Draft → Signed → Sent → Received by pharmacy → Query to prescriber (optional) → Accepted → In progress → Ready for pickup / Out for delivery → Collected / Delivered. Exits: Cancelled, Rejected by pharmacy (with reason), Expired, Not acknowledged (escalated).

**Rules:**
- Generic substitution is allowed unless the prescriber marks "dispense as written".
- EPCS prescriptions follow DEA rules: two-factor signing, prescriber identity proofing, access controls for who can prepare and sign, and an audit trail retained as the law requires.
- If a pharmacy hasn't acknowledged a prescription within 2 hours (the agreed goal), the care team and patient are alerted so they can choose another pharmacy.
- Refill requests go to the prescriber. The pharmacy can't extend a prescription on its own.

## 5. Medicine delivery (handled by external pharmacies)

1. The pharmacy's own delivery service delivers the medicine. We don't dispatch, route or employ drivers.
2. The pharmacy reports status and an optional tracking link, manually in the partner portal or automatically by API/webhook.
3. The patient sees "out for delivery", the tracking link and ETA, then "delivered", in the patient portal and by notification.
4. **Failed delivery:** the pharmacy reports the reason and the next step (new attempt, pickup instead), which the patient sees.

**Delivery statuses (pharmacy-reported):** Out for delivery → Delivered. Exits: Failed attempt → New attempt scheduled / Changed to pickup.

**Rules:**
- Controlled substances are handed only to the named patient or an authorised proxy with ID; the pharmacy records the ID check and recipient in the partner portal.
- Notifications never include medicine names or diagnoses, only a prompt to log in.
- Duplicate or out-of-order status updates from a pharmacy never move a delivery backwards.

## 6. Lab orders and results

1. The doctor orders tests, with priority and clinical notes.
2. The sample is collected at the clinic (labelled barcode) or at an external collection point.
3. The order is sent to the lab electronically, or by requisition PDF if the lab has no interface.
4. Results come back electronically and attach to the order. Unmatched results go to a reconciliation queue, never to a random chart.
5. The ordering doctor sees results in the inbox. Abnormal values are flagged.
6. **Critical results** alert the ordering doctor immediately. If not acknowledged within the escalation window (set with the clinical safety reviewer in Plan & Design), the alert escalates to the on-call doctor.
7. **Release to the patient (agreed):** normal results are released immediately; abnormal results are released after the ordering doctor reviews them, within the time US information-blocking rules allow.

**Lab order statuses:** Ordered → Sample collected → Sent to lab → Partial results → Final results → Reviewed → Released to patient. Exits: Cancelled, Sample rejected (recollect).

## 7. Documents

1. A patient or staff member uploads a file. It is virus-scanned, then classified (referral, lab report, ID, insurance, consent, imaging report).
2. Scanned documents go through OCR so they can be searched. Staff confirm the classification and patient match.
3. Consent forms are signed electronically, with signer, time and document version recorded.
4. Retention follows the configured legal period. Deletion requests are checked against legal holds before anything is removed.

## 8. Payments

- Prices come from the services catalogue and the pharmacy price list. Taxes are configured per location.
- Card data never touches our servers; the payment provider's hosted fields or tokens are used.
- Refunds follow the cancellation policy and need staff approval above a configured amount.
- Invoices and receipts are downloadable from the patient portal.
