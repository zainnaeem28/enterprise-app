import { useRef, useState } from 'react';
import { Banner, Button, ErrorSummary, StatusChip, TextAreaField, TextField } from '@ehr/ui';
import type { FieldError } from '@ehr/ui';
import { useDesk } from './DeskContext.js';
import { ActionError } from './Problem.js';
import { preStrings as p } from './strings.js';
import { newKey } from './http.js';
import type { Failure } from './http.js';
import type { MatchCandidate, MatchResult } from './types.js';

const FIELD_LABEL: Record<string, string> = {
  givenName: p.fieldGiven,
  familyName: p.fieldFamily,
  dateOfBirth: p.fieldDob,
  phone: p.fieldPhone,
  email: p.fieldEmail,
};

/**
 * The duplicate warning at registration (UI-UX 7.3, BR-37). It lists only what the API returned for records inside the user's scope;
 * a candidate outside it is a sentence with no demographics. Actions: open the existing record, or create anyway with a reason.
 */
export function DuplicateWarning({
  candidates,
  onOpen,
  onCreateAnyway,
  canCreate,
}: {
  candidates: MatchCandidate[];
  onOpen: (c: MatchCandidate) => void;
  onCreateAnyway: () => void;
  canCreate: boolean;
}) {
  return (
    <section aria-labelledby="dup-title" className="ehr-card ehr-card--warning">
      <h3 id="dup-title">{p.dupTitle}</h3>
      <ul className="ehr-plain-list">
        {candidates.map((c) => (
          <li key={c.candidateRef} className="ehr-card">
            <StatusChip tone={c.strength === 'exact' ? 'danger' : 'warning'}>
              {c.strength === 'exact' ? p.dupExact : p.dupProbable}
            </StatusChip>{' '}
            {c.display !== null ? (
              <>
                <strong>
                  {c.display.givenName} {c.display.familyName}
                </strong>{' '}
                <span className="ehr-muted">
                  {c.display.mrn} · {c.display.dateOfBirth}
                </span>
                <p className="ehr-muted">
                  {p.dupMatchedOn(c.matchedFields.map((f) => FIELD_LABEL[f] ?? f).join(', '))}
                </p>
                <Button onClick={() => onOpen(c)}>{p.dupOpen}</Button>
              </>
            ) : (
              <span>{p.dupOutOfScope}</span>
            )}
          </li>
        ))}
      </ul>
      {canCreate && <Button onClick={onCreateAnyway}>{p.dupCreateAnyway}</Button>}
    </section>
  );
}

const DOB = /^\d{4}-\d{2}-\d{2}$/;
const STATE = /^[A-Za-z]{2}$/;

type Step =
  | { kind: 'form' }
  | { kind: 'checked'; match: MatchResult }
  | { kind: 'ack'; match: MatchResult }
  | { kind: 'done'; mrn: string; flagged: boolean }
  | { kind: 'opened'; text: string };

/** Registration with the existing-record check first (`POST /patients/match`, then `POST /patients` with the check ID). */
export function Registration() {
  const { api, locationId, can } = useDesk();
  const [form, setForm] = useState({
    givenName: '',
    familyName: '',
    dateOfBirth: '',
    stateCode: '',
    phone: '',
    email: '',
  });
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [step, setStep] = useState<Step>({ kind: 'form' });
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const key = useRef<{ sig: string; key: string } | null>(null);

  const set = (k: keyof typeof form, v: string) => {
    setForm({ ...form, [k]: v });
    // A changed form invalidates the check: the server ties the check ID to the checked values.
    if (step.kind !== 'form') setStep({ kind: 'form' });
  };
  const err = (id: string) => errors.find((e) => e.fieldId === `reg-${id}`)?.message;

  function validate(): boolean {
    const errs: FieldError[] = [];
    if (form.givenName.trim() === '')
      errs.push({ fieldId: 'reg-given', message: `${p.givenName}: enter a name.` });
    if (form.familyName.trim() === '')
      errs.push({ fieldId: 'reg-family', message: `${p.familyName}: enter a name.` });
    if (!DOB.test(form.dateOfBirth.trim()))
      errs.push({ fieldId: 'reg-dob', message: `${p.dob}: ${p.dobHint}` });
    if (!STATE.test(form.stateCode.trim()))
      errs.push({ fieldId: 'reg-state', message: `${p.stateCode}: ${p.stateHint}` });
    setErrors(errs);
    return errs.length === 0;
  }

  const matchBody = () => ({
    givenName: form.givenName.trim(),
    familyName: form.familyName.trim(),
    dateOfBirth: form.dateOfBirth.trim(),
    locationId,
    ...(form.phone.trim() === '' ? {} : { phone: form.phone.trim() }),
    ...(form.email.trim() === '' ? {} : { email: form.email.trim() }),
  });

  async function check(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;
    setBusy(true);
    setFailure(null);
    const r = await api.matchPatient(matchBody());
    setBusy(false);
    if (r.ok) setStep({ kind: 'checked', match: r.data });
    else setFailure(r);
  }

  async function register(match: MatchResult, acknowledged: boolean) {
    if (acknowledged && reason.trim() === '') {
      setErrors([{ fieldId: 'reg-reason', message: p.dupReasonMissing }]);
      return;
    }
    setErrors([]);
    const sig = JSON.stringify([match.matchCheckId, acknowledged, reason]);
    if (key.current === null || key.current.sig !== sig) key.current = { sig, key: newKey() };
    setBusy(true);
    setFailure(null);
    const r = await api.register(
      {
        givenName: form.givenName.trim(),
        familyName: form.familyName.trim(),
        dateOfBirth: form.dateOfBirth.trim(),
        stateCode: form.stateCode.trim().toUpperCase(),
        locationId,
        matchCheckId: match.matchCheckId,
        ...(form.phone.trim() === '' ? {} : { phone: form.phone.trim() }),
        ...(form.email.trim() === '' ? {} : { email: form.email.trim() }),
        ...(acknowledged ? { duplicateAcknowledged: true, acknowledgeReason: reason.trim() } : {}),
      },
      key.current.key,
    );
    setBusy(false);
    if (r.ok) {
      key.current = null;
      setStep({ kind: 'done', mrn: r.data.mrn, flagged: r.data.duplicateFlags > 0 });
    } else {
      setFailure(r);
      if (r.status > 0 && r.status < 500 && r.status !== 429) key.current = null;
    }
  }

  if (!can('patient.register') && !can('patient.match'))
    return <p>{p.noPermission('register patients')}</p>;

  return (
    <section aria-labelledby="reg-title">
      <h2 id="reg-title">{p.registerTitle}</h2>
      <form onSubmit={(e) => void check(e)} noValidate>
        <ErrorSummary errors={step.kind === 'ack' ? [] : errors} />
        <div className="ehr-form-grid">
          <TextField
            id="reg-given"
            label={p.givenName}
            value={form.givenName}
            onChange={(e) => set('givenName', e.target.value)}
            error={err('given')}
            autoComplete="off"
          />
          <TextField
            id="reg-family"
            label={p.familyName}
            value={form.familyName}
            onChange={(e) => set('familyName', e.target.value)}
            error={err('family')}
            autoComplete="off"
          />
          <TextField
            id="reg-dob"
            label={p.dob}
            hint={p.dobHint}
            value={form.dateOfBirth}
            onChange={(e) => set('dateOfBirth', e.target.value)}
            error={err('dob')}
            autoComplete="off"
          />
          <TextField
            id="reg-state"
            label={p.stateCode}
            hint={p.stateHint}
            value={form.stateCode}
            onChange={(e) => set('stateCode', e.target.value)}
            error={err('state')}
            autoComplete="off"
          />
          <TextField
            id="reg-phone"
            label={p.phone}
            value={form.phone}
            onChange={(e) => set('phone', e.target.value)}
            error={err('phone')}
            autoComplete="off"
          />
          <TextField
            id="reg-email"
            label={p.email}
            value={form.email}
            onChange={(e) => set('email', e.target.value)}
            error={err('email')}
            autoComplete="off"
          />
        </div>
        {can('patient.match') && (
          <Button type="submit" variant="primary" disabled={busy}>
            {busy && step.kind === 'form' ? p.checking : p.checkExisting}
          </Button>
        )}
      </form>
      {failure !== null && <ActionError failure={failure} />}

      {step.kind === 'checked' && step.match.candidates.length === 0 && (
        <Banner tone="info">
          <p>{p.noMatch}</p>
          {can('patient.register') && (
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => void register(step.match, false)}
            >
              {busy ? p.registering : p.registerNow}
            </Button>
          )}
        </Banner>
      )}
      {step.kind === 'checked' && step.match.candidates.length > 0 && (
        <DuplicateWarning
          candidates={step.match.candidates}
          canCreate={can('patient.register')}
          onOpen={(c) =>
            setStep({
              kind: 'opened',
              text: p.openedRecord(
                `${c.display?.givenName ?? ''} ${c.display?.familyName ?? ''}`.trim(),
                c.display?.mrn ?? '',
              ),
            })
          }
          onCreateAnyway={() => setStep({ kind: 'ack', match: step.match })}
        />
      )}
      {step.kind === 'ack' && (
        <section aria-labelledby="ack-title" className="ehr-card">
          <h3 id="ack-title">{p.dupCreateAnyway}</h3>
          <ErrorSummary errors={errors.filter((e) => e.fieldId === 'reg-reason')} />
          <TextAreaField
            id="reg-reason"
            label={p.dupReason}
            hint={p.dupReasonHint}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            error={err('reason')}
            rows={3}
          />
          <Button variant="primary" disabled={busy} onClick={() => void register(step.match, true)}>
            {busy ? p.registering : p.dupConfirmCreate}
          </Button>{' '}
          <Button onClick={() => setStep({ kind: 'checked', match: step.match })}>
            {p.cancel}
          </Button>
        </section>
      )}
      {step.kind === 'done' && (
        <Banner tone="info">
          <p>{p.registered(step.mrn)}</p>
          {step.flagged && <p>{p.dupFlagNote}</p>}
        </Banner>
      )}
      {step.kind === 'opened' && (
        <Banner tone="info">
          <p>{step.text}</p>
        </Banner>
      )}
    </section>
  );
}
