import { useState } from 'react';
import { Button, EmptyState, ErrorSummary, LoadingState, TextField } from '@ehr/ui';
import type { FieldError } from '@ehr/ui';
import { useDesk } from './DeskContext.js';
import { ActionError } from './Problem.js';
import type { Failure } from './http.js';
import { preStrings as p } from './strings.js';
import type { PatientHit } from './types.js';

const DOB = /^\d{4}-\d{2}-\d{2}$/;

/** Find a patient by `POST /patients/search` (AC-34): in-scope patients only. Calls back with the chosen record. */
export function PatientPicker({
  onChoose,
  chooseLabel,
  chosenId,
  idPrefix,
}: {
  onChoose: (hit: PatientHit) => void;
  chooseLabel: string;
  chosenId?: string | null;
  idPrefix: string;
}) {
  const { api } = useDesk();
  const [form, setForm] = useState({ name: '', dateOfBirth: '', mrn: '', phone: '' });
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [busy, setBusy] = useState(false);
  const [hits, setHits] = useState<PatientHit[] | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const q: { name?: string; dateOfBirth?: string; mrn?: string; phone?: string } = {};
    if (form.name.trim() !== '') q.name = form.name.trim();
    if (form.dateOfBirth.trim() !== '') q.dateOfBirth = form.dateOfBirth.trim();
    if (form.mrn.trim() !== '') q.mrn = form.mrn.trim();
    if (form.phone.trim() !== '') q.phone = form.phone.trim();
    const errs: FieldError[] = [];
    if (Object.keys(q).length === 0)
      errs.push({ fieldId: `${idPrefix}-name`, message: p.findHint });
    if (q.dateOfBirth !== undefined && !DOB.test(q.dateOfBirth))
      errs.push({ fieldId: `${idPrefix}-dob`, message: `${p.searchDob}: ${p.dobHint}` });
    setErrors(errs);
    if (errs.length > 0) return;
    setBusy(true);
    setFailure(null);
    const r = await api.searchPatients(q);
    setBusy(false);
    if (r.ok) setHits(r.data);
    else {
      setHits(null);
      setFailure(r);
      if (r.fields.length > 0)
        setErrors(
          r.fields.map((f) => ({
            fieldId: `${idPrefix}-${f === 'dateOfBirth' ? 'dob' : f}`,
            message: `Check ${f}.`,
          })),
        );
    }
  }

  const err = (id: string) => errors.find((x) => x.fieldId === `${idPrefix}-${id}`)?.message;

  return (
    <div>
      <form onSubmit={(e) => void submit(e)} noValidate aria-label={p.findPatient}>
        <ErrorSummary errors={errors} />
        <p className="ehr-muted">{p.findHint}</p>
        <TextField
          id={`${idPrefix}-name`}
          label={p.searchName}
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          error={err('name')}
          autoComplete="off"
        />
        <TextField
          id={`${idPrefix}-dob`}
          label={p.searchDob}
          hint={p.dobHint}
          value={form.dateOfBirth}
          onChange={(e) => setForm({ ...form, dateOfBirth: e.target.value })}
          error={err('dob')}
          autoComplete="off"
        />
        <TextField
          id={`${idPrefix}-mrn`}
          label={p.searchMrn}
          value={form.mrn}
          onChange={(e) => setForm({ ...form, mrn: e.target.value })}
          error={err('mrn')}
          autoComplete="off"
        />
        <TextField
          id={`${idPrefix}-phone`}
          label={p.searchPhone}
          value={form.phone}
          onChange={(e) => setForm({ ...form, phone: e.target.value })}
          error={err('phone')}
          autoComplete="off"
        />
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? p.searching : p.search}
        </Button>
      </form>
      {busy && <LoadingState label={p.searching} lines={2} />}
      {failure !== null && <ActionError failure={failure} />}
      {hits !== null &&
        (hits.length === 0 ? (
          <EmptyState message={p.noPatients} />
        ) : (
          <ul className="ehr-plain-list" aria-label={p.findPatient}>
            {hits.map((h) => (
              <li key={h.id} className="ehr-card">
                <strong>
                  {h.givenName} {h.familyName}
                </strong>{' '}
                <span className="ehr-muted">
                  {h.mrn} · {h.dateOfBirth}
                </span>{' '}
                {chosenId === h.id ? (
                  <span role="status">{p.chosen}</span>
                ) : (
                  <Button
                    aria-label={`${chooseLabel}: ${h.givenName} ${h.familyName}`}
                    onClick={() => onChoose(h)}
                  >
                    {chooseLabel}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}
