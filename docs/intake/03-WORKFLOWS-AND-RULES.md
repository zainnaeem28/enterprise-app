# 03 — Workflows and Business Rules

> **Status: CONFIRMED** (AI-prepared 2026-10-31). Confirmed by: Zain Naeem (product owner) on 2026-10-31.
> All numbers below (time windows, limits, fees) are placeholders for the client to set.

## 1. Appointment booking

1. The patient picks a service, then a doctor or "any available", a location or video, and a date.
2. The system shows slots computed from the doctor's availability template, minus existing bookings and minus busy times synced from the doctor's Google/Outlook calendar.
3. The patient confirms. The slot is held for ____ minutes during checkout so no one else takes it.
4. If the service needs payment or a deposit, the patient pays; otherwise the booking is confirmed.
5. Confirmation goes out by email/SMS with an .ics calendar file. The doctor's calendar gets a "Busy" block with no patient name.
6. Reminders go out at ____ h and ____ h before, with links to confirm, reschedule or cancel.
7. The pre-visit questionnaire and consents are sent ____ h before.

**Statuses:** Requested → Confirmed → Checked-in → In consultation → Completed. Exits: Cancelled by patient, Cancelled by clinic, No-show, Rescheduled.

**Rules:**
- Patients may cancel or reschedule free until ____ h before; after that a fee of ____ applies, or the change is blocked.
- Double booking a doctor is impossible unless a slot is marked overbookable (max ____ per session).
- When a slot frees up, waitlisted patients are offered it in order and have ____ minutes to accept.
- A patient may hold at most ____ future appointments per service.
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
3. The doctor signs. Controlled substances need extra authentication where the law allows electronic prescribing.
4. The prescription goes to the patient's chosen pharmacy: internal, or external through the e-prescribing network.
5. **Pharmacy verification:** the pharmacist reviews clinical appropriateness, then accepts it or queries the prescriber.
6. **Dispensing:** a technician picks; barcode scanning confirms the right product, strength and batch, and blocks expired stock. A label is printed and the pharmacist does a final check.
7. The order is ready for pickup or goes to delivery dispatch.

**Prescription statuses:** Draft → Signed → Sent → Received → In verification → Query to prescriber (optional) → Verified → Dispensing → Ready → Collected / Out for delivery → Delivered. Exits: Cancelled, Rejected (with reason), Expired.

**Rules:**
- Stock is reserved at verification and deducted at final check, by batch, oldest expiry first.
- Generic substitution is allowed unless the prescriber marks "dispense as written".
- Controlled drugs: every movement is recorded in the register, the balance must reconcile, and certain steps need a witness.
- Refill requests go to the prescriber. The pharmacy cannot extend a prescription on its own.
- Recalled batches are blocked immediately, and affected patients are listed for follow-up.

## 5. Medicine delivery

1. At checkout the patient chooses a delivery address. The system validates it against delivery zones and shows available time slots and the fee.
2. When the order is Ready, it appears on the dispatch board.
3. The dispatcher batches orders into routes. A route goes to an in-house driver or a third-party courier.
4. The driver collects the packages and scans each one. The patient receives a tracking link and ETA.
5. At the door, the driver captures proof of delivery: signature, photo or one-time code. For restricted items, the driver also checks ID and age.
6. **Failed delivery** (nobody home, wrong address): the driver records the reason, the package returns to the pharmacy, and the patient is offered a new slot.

**Delivery statuses:** Awaiting dispatch → Assigned → Picked up → Out for delivery → Delivered. Exits: Failed attempt → Returned to pharmacy → Rescheduled / Refunded.

**Rules:**
- Cold-chain items must be delivered within ____ hours of leaving the pharmacy, and the temperature log is attached.
- Controlled drugs can only be delivered to the named patient or an authorised proxy with ID.
- Drivers see only the address, name, contact number and package IDs for their own assigned stops, never diagnoses or medicine names.

## 6. Lab orders and results

1. The doctor orders tests, with priority and clinical notes.
2. The sample is collected at the clinic (labelled barcode) or at an external collection point.
3. The order is sent to the lab electronically, or by requisition PDF if the lab has no interface.
4. Results come back electronically and attach to the order. Unmatched results go to a reconciliation queue, never to a random chart.
5. The ordering doctor sees results in the inbox. Abnormal values are flagged.
6. **Critical results** alert the ordering doctor immediately. If not acknowledged within ____ minutes, the alert escalates to the on-call doctor.
7. Results are released to the patient per policy (see the open question on immediate release vs release after doctor review).

**Lab order statuses:** Ordered → Sample collected → Sent to lab → Partial results → Final results → Reviewed → Released to patient. Exits: Cancelled, Sample rejected (recollect).

## 7. Documents

1. A patient or staff member uploads a file. It is virus-scanned, then classified (referral, lab report, ID, insurance, consent, imaging report).
2. Scanned documents go through OCR so they can be searched. Staff confirm the classification and patient match.
3. Consent forms are signed electronically, with signer, time and document version recorded.
4. Retention follows the configured legal period. Deletion requests are checked against legal holds before anything is removed.

## 8. Payments

- Prices come from the services catalogue and the pharmacy price list. Taxes are configured per location.
- Card data never touches our servers; the payment provider's hosted fields or tokens are used.
- Refunds follow the cancellation policy and need staff approval above ____.
- Invoices and receipts are downloadable from the patient portal.
