// Fixtures for the clinical suites (QA-04): a checked-in visit today, questionnaire and consent templates, doctor sessions.
// Templates carry SYNTHETIC rules only; what counts as a red flag is the D-12a reviewer's decision, never QA's.
import { randomUUID } from 'node:crypto';
import {
  ORG,
  A1,
  newService,
  setPolicy,
  newDoctor,
  newStaff,
  newPatient,
  search,
  book,
  soon,
  deskCheckIn,
  sql,
  login,
} from './world.mjs';

export const W = (v) => `W/"${v}"`;
export const QUESTIONS = [
  { id: 'q_flag_a', type: 'boolean' },
  { id: 'q_flag_b', type: 'choice' },
  { id: 'q_score', type: 'number' },
  { id: 'q_note', type: 'text' },
];
export const RULES = [
  { question: 'q_flag_a', equals: true },
  { question: 'q_flag_b', in: ['red', 'purple'] },
  { question: 'q_score', gte: 8 },
];
export const ADVICE = 'Synthetic emergency advice text (QA fixture).';

/** Publishes a questionnaire template under a fresh key; returns the key. */
export async function publishQuestionnaire({
  rules = RULES,
  advice = ADVICE,
  questions = QUESTIONS,
} = {}) {
  const key = `qa-q-${randomUUID().slice(0, 8)}`;
  const schema = {
    questions,
    red_flag_rules: rules,
    ...(advice ? { emergency_advice: advice } : {}),
  };
  await sql(
    `INSERT INTO organisation.questionnaire_template (id, organisation_id, key, version, schema, status, approved_by_note) VALUES ($1,$2,$3,1,$4::jsonb,'published',$5)`,
    [
      randomUUID(),
      ORG,
      key,
      JSON.stringify(schema),
      rules.length ? 'Synthetic reviewer note (QA fixture, not a clinical review)' : null,
    ],
  );
  return key;
}
export async function publishConsent(version = 1, key = `qa-c-${randomUUID().slice(0, 8)}`) {
  await sql(
    `INSERT INTO organisation.consent_template (id, organisation_id, key, version, language, title, body_text, body_document_id, status) VALUES ($1,$2,$3,$4,'en',$5,$6,$7,'published')`,
    [
      randomUUID(),
      ORG,
      key,
      version,
      `QA consent ${key}`,
      `Placeholder wording ${key}, test data only.`,
      randomUUID(),
    ],
  );
  return key;
}
export const requireConsents = (svc, keys) =>
  Promise.all(
    keys.map((k) =>
      sql(
        `INSERT INTO organisation.service_required_consent (organisation_id, service_id, consent_template_key) VALUES ($1,$2,$3)`,
        [ORG, svc, k],
      ),
    ),
  );

/** A consent row for a patient straight in the database (status signed | superseded | withdrawn). */
export async function consentRow(patient, key, version = 1, status = 'signed') {
  const staff = (await sql(`SELECT id FROM identity.principal WHERE realm='google' LIMIT 1`))
    .rows[0].id;
  const w = status === 'withdrawn';
  await sql(
    `INSERT INTO patient.consent (id, organisation_id, patient_id, template_key, template_version, template_language, status, signed_at, signer_principal_id, signer_relationship, signed_name, withdrawn_at)
     VALUES ($1,$2,$3,$4,$5,'en',$6,${w ? 'NULL' : 'now()'},${w ? 'NULL' : '$7'},${w ? 'NULL' : "'staff_witnessed'"},${w ? 'NULL' : "'Synthetic Signer'"},${w ? 'now()' : 'NULL'})`,
    w
      ? [randomUUID(), ORG, patient.id, key, version, status]
      : [randomUUID(), ORG, patient.id, key, version, status, staff],
  );
}

/**
 * A booked visit today with its own service, doctor, patient and staff (not yet checked in).
 * Returns {svc, doc, patient, appt, reservationId, desk, tri, slot}.
 */
export async function visit({ consents = [], doc, desk, tri, patient } = {}) {
  const svc = await newService({ internal: 'QA clinical', display: 'Appointment' });
  await setPolicy(svc, { cutoff: 0, max: 50 });
  if (consents.length) await requireConsents(svc, consents);
  doc ??= await newDoctor({ services: [svc], allDay: true });
  await sql(
    `INSERT INTO organisation.service_clinician (organisation_id, service_id, clinician_principal_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
    [ORG, svc, doc.id],
  );
  desk ??= await newStaff([['front_desk', A1]], { name: 'STF-FD' });
  tri ??= await newStaff([['triage_nurse', A1]], { name: 'STF-TRI' });
  patient ??= await newPatient();
  const s = await search(patient.client, { serviceId: svc, clinicianId: doc.id, day: soon(1, 5) });
  if (!s.slots.length) throw new Error(`no slot: ${s.status} ${s.text.slice(0, 200)}`);
  const b = await book(patient, s.slots[0], svc);
  return {
    svc,
    doc,
    patient,
    appt: b.appointment,
    reservationId: b.reservationId,
    desk,
    tri,
    slot: s.slots[0],
  };
}
export async function checkIn(v) {
  const ci = await deskCheckIn(v.desk, v.appt);
  if (ci.status !== 200) throw new Error(`check-in ${ci.status} ${ci.text.slice(0, 200)}`);
  v.checkInId = ci.json.queueEntryId;
  return ci;
}
export const docClient = async (doc) => (doc.client ??= await login('staff', doc.key));
