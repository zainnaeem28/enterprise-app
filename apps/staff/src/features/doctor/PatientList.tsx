import { useState } from 'react';
import { Button, DataTable, ErrorSummary, LoadingState, TextField } from '@ehr/ui';
import type { FieldError } from '@ehr/ui';
import { useDoctor } from './DoctorContext.js';
import { ActionError } from './Problem.js';
import type { Failure } from '../preconsult/http.js';
import { docStrings as d } from './strings.js';
import type { PatientHit } from './types.js';
import { workspace } from './workspace.js';

const DOB = /^\d{4}-\d{2}-\d{2}$/;

/** DR-02: find a patient by `POST /patients/search` (in-scope patients only) and open the chart. */
export function PatientList() {
  const { api } = useDoctor();
  const [form, setForm] = useState({ name: '', dateOfBirth: '', mrn: '' });
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [busy, setBusy] = useState(false);
  const [hits, setHits] = useState<PatientHit[] | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const q: { name?: string; dateOfBirth?: string; mrn?: string } = {};
    if (form.name.trim() !== '') q.name = form.name.trim();
    if (form.dateOfBirth.trim() !== '') q.dateOfBirth = form.dateOfBirth.trim();
    if (form.mrn.trim() !== '') q.mrn = form.mrn.trim();
    const errs: FieldError[] = [];
    if (Object.keys(q).length === 0) errs.push({ fieldId: 'pl-name', message: d.needOne });
    if (q.dateOfBirth !== undefined && !DOB.test(q.dateOfBirth))
      errs.push({ fieldId: 'pl-dob', message: d.dobBad });
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
    }
  }

  const err = (id: string) => errors.find((x) => x.fieldId === id)?.message;

  return (
    <section aria-labelledby="patients-title">
      <h1 id="patients-title">{d.patientsTitle}</h1>
      <form onSubmit={submit} noValidate aria-label={d.findPatient}>
        <h2>{d.findPatient}</h2>
        <p className="ehr-muted">{d.findHint}</p>
        <ErrorSummary errors={errors} />
        <div className="ehr-form-grid">
          <TextField
            id="pl-name"
            label={d.searchName}
            value={form.name}
            error={err('pl-name')}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <TextField
            id="pl-dob"
            label={d.searchDob}
            hint="YYYY-MM-DD"
            value={form.dateOfBirth}
            error={err('pl-dob')}
            onChange={(e) => setForm({ ...form, dateOfBirth: e.target.value })}
          />
          <TextField
            id="pl-mrn"
            label={d.searchMrn}
            value={form.mrn}
            onChange={(e) => setForm({ ...form, mrn: e.target.value })}
          />
        </div>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? d.searching : d.search}
        </Button>
      </form>
      {busy && <LoadingState label={d.searching} lines={2} />}
      {failure !== null && <ActionError failure={failure} />}
      {hits !== null && (
        <DataTable
          caption={d.patientsTitle}
          rows={hits}
          rowKey={(h) => h.id}
          emptyMessage={d.noResults}
          onOpen={(h) =>
            workspace.set({ patientId: h.id, label: `${h.givenName} ${h.familyName}` })
          }
          columns={[
            { key: 'name', header: d.colPatient, render: (h) => `${h.givenName} ${h.familyName}` },
            { key: 'dob', header: d.colDob, render: (h) => h.dateOfBirth },
            { key: 'mrn', header: d.colMrn, render: (h) => h.mrn },
            {
              key: 'open',
              header: d.openChart,
              render: (h) => (
                <Button
                  onClick={() =>
                    workspace.set({ patientId: h.id, label: `${h.givenName} ${h.familyName}` })
                  }
                >
                  {d.openChart}
                  <span className="ehr-visually-hidden">
                    {' '}
                    {h.givenName} {h.familyName}
                  </span>
                </Button>
              ),
            },
          ]}
        />
      )}
    </section>
  );
}
