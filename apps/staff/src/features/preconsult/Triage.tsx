import { useRef, useState } from 'react';
import {
  AlertBar,
  Banner,
  Button,
  EmptyState,
  ErrorSummary,
  LoadingState,
  PatientBanner,
  RangeText,
  SelectField,
  StatusChip,
  TextAreaField,
  TextField,
} from '@ehr/ui';
import type { FieldError } from '@ehr/ui';
import { useDesk, useSelectedVisit } from './DeskContext.js';
import { ActionError, LoadError } from './Problem.js';
import { preStrings as p } from './strings.js';
import { ageOf, categoryLabel, nameOf } from './format.js';
import { newKey } from './http.js';
import type { Failure } from './http.js';
import { useLoad } from './useLoad.js';
import { TRIAGE_CATEGORIES } from './types.js';
import type { Arrival, Banner as BannerData, TriageCategory, TriageSaved, Vital } from './types.js';

interface VitalSpec {
  id: string;
  loinc: string;
  label: string;
  /** UCUM code sent to the API (the stored range is matched on it). */
  unit: string;
  /** What staff read. */
  shown: string;
}

// The common bedside set. LOINC codes and UCUM units are identifiers, not clinical ranges: no range value lives in the UI.
const VITALS: readonly VitalSpec[] = [
  { id: 'hr', loinc: '8867-4', label: p.vitalHeartRate, unit: '/min', shown: '/min' },
  { id: 'rr', loinc: '9279-1', label: p.vitalRespRate, unit: '/min', shown: '/min' },
  { id: 'spo2', loinc: '2708-6', label: p.vitalSpo2, unit: '%', shown: '%' },
  { id: 'temp', loinc: '8310-5', label: p.vitalTemp, unit: 'Cel', shown: '°C' },
  { id: 'sys', loinc: '8480-6', label: p.vitalSys, unit: 'mm[Hg]', shown: 'mmHg' },
  { id: 'dia', loinc: '8462-8', label: p.vitalDia, unit: 'mm[Hg]', shown: 'mmHg' },
  { id: 'wt', loinc: '29463-7', label: p.vitalWeight, unit: 'kg', shown: 'kg' },
  { id: 'ht', loinc: '8302-2', label: p.vitalHeight, unit: 'cm', shown: 'cm' },
];
const specOf = (loinc: string): VitalSpec | undefined => VITALS.find((v) => v.loinc === loinc);
const NUMBER = /^-?\d+([.,]\d+)?$/;

/** PC-04 with PC-06: the patient banner, vitals with range text, the triage category and the red-flag bar for one visit. */
export function Triage() {
  const visit = useSelectedVisit();
  if (visit === null) return <EmptyState message={p.pickVisit} />;
  return <TriageFor key={visit.reservationId} visit={visit} />;
}

function TriageFor({ visit }: { visit: Arrival }) {
  const { api } = useDesk();
  const checkInId = visit.reservationId;
  const banner = useLoad(() => api.banner(visit.patientId), [visit.patientId]);
  const current = useLoad(() => api.currentTriage(checkInId), [checkInId]);
  const [fresh, setFresh] = useState<BannerData | null>(null);
  const [saved, setSaved] = useState<TriageSaved | null>(null);

  const shownBanner = fresh ?? (banner.state.kind === 'ready' ? banner.state.data : null);
  const currentTriage = current.state.kind === 'ready' ? current.state.data.triage : null;
  const redFlag = saved?.redFlag === true || currentTriage?.redFlag === true;

  return (
    <section aria-labelledby="triage-title">
      <h2 id="triage-title">{p.triageTitle}</h2>
      {banner.state.kind === 'loading' && <LoadingState label={p.triageTitle} lines={2} />}
      {banner.state.kind === 'error' && (
        <LoadError failure={banner.state.failure} onRetry={banner.reload} />
      )}
      {shownBanner !== null && (
        <PatientBanner
          name={shownBanner.displayName}
          dob={shownBanner.dateOfBirth}
          age={ageOf(shownBanner.dateOfBirth)}
          mrn={shownBanner.mrn}
          allergies={shownBanner.allergies}
        />
      )}
      {banner.state.kind !== 'ready' && fresh === null && <p>{nameOf(visit.patientName)}</p>}
      <p className="ehr-muted">{p.wrongPatientCheck}</p>

      {/* UXR-08 option B: a status, never an action. No Dismiss, no doctor name, no countdown, no acknowledged state. */}
      {redFlag && (
        <>
          <AlertBar state="raised" />
          <p>{p.redFlagFollow}</p>
        </>
      )}
      {saved?.advice != null && (
        <Banner tone="warning" title={p.advice}>
          <p>{saved.advice}</p>
        </Banner>
      )}

      <p className="ehr-desk-phone-note">{p.phoneTriageNote}</p>
      <div className="ehr-desk-tablet-up">
        <VitalsForm checkInId={checkInId} onBanner={setFresh} />
      </div>

      {current.state.kind === 'loading' && <LoadingState label={p.triageTitle} lines={2} />}
      {current.state.kind === 'error' && current.state.failure.status !== 404 && (
        <LoadError failure={current.state.failure} onRetry={current.reload} />
      )}
      {current.state.kind === 'ready' && (
        <div className="ehr-desk-tablet-up">
          <TriageForm
            checkInId={checkInId}
            existing={currentTriage?.category ?? null}
            chainLength={current.state.etag}
            onSaved={(s) => {
              setSaved(s);
              if (s.banner !== null) setFresh(s.banner);
              current.reload();
            }}
          />
        </div>
      )}
    </section>
  );
}

function VitalsForm({
  checkInId,
  onBanner,
}: {
  checkInId: string;
  onBanner: (b: BannerData) => void;
}) {
  const { api, can, online } = useDesk();
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [recorded, setRecorded] = useState<Vital[]>([]);
  const [outOfRange, setOutOfRange] = useState<string[]>([]);
  const [notice, setNotice] = useState(false);
  const key = useRef<{ body: string; key: string } | null>(null);

  if (!can('clinical.vitals.record'))
    return <p className="ehr-muted">{p.noPermission('record vitals')}</p>;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const errs: FieldError[] = [];
    const entries = VITALS.flatMap((v) => {
      const raw = (values[v.id] ?? '').trim();
      if (raw === '') return [];
      if (!NUMBER.test(raw)) {
        errs.push({ fieldId: `vital-${v.id}`, message: p.mustBeNumber(v.label) });
        return [];
      }
      return [{ spec: v, value: Number(raw.replace(',', '.')) }];
    });
    if (errs.length === 0 && entries.length === 0)
      errs.push({ fieldId: `vital-${VITALS[0]?.id ?? 'hr'}`, message: p.nothingToSave });
    setErrors(errs);
    if (errs.length > 0) return;
    const measuredAt = new Date().toISOString();
    const body = entries.map(({ spec, value }) => ({
      loincCode: spec.loinc,
      value,
      unit: spec.unit,
      measuredAt,
    }));
    // The same values after a timeout reuse the same key; changed values are a new request.
    const sig = JSON.stringify(entries.map((x) => [x.spec.loinc, x.value]));
    if (key.current === null || key.current.body !== sig)
      key.current = { body: sig, key: newKey() };
    setBusy(true);
    setFailure(null);
    setNotice(false);
    const r = await api.recordVitals(checkInId, body, key.current.key);
    setBusy(false);
    if (r.ok) {
      key.current = null;
      setRecorded(r.data.vitals);
      setOutOfRange(r.data.outOfRange);
      if (r.data.banner !== null) onBanner(r.data.banner);
      setValues({});
      setNotice(true);
    } else {
      setFailure(r);
      if (r.status > 0 && r.status < 500 && r.status !== 429) key.current = null;
      if (r.fields.length > 0)
        setErrors(r.fields.map((f) => ({ fieldId: 'vital-hr', message: `Check ${f}.` })));
    }
  }

  return (
    <section aria-labelledby="vitals-title">
      <h3 id="vitals-title">{p.vitalsTitle}</h3>
      <form onSubmit={(e) => void submit(e)} noValidate>
        <ErrorSummary errors={errors} />
        <p className="ehr-muted">{p.vitalsHint}</p>
        <div className="ehr-form-grid">
          {VITALS.map((v) => (
            <TextField
              key={v.id}
              id={`vital-${v.id}`}
              label={`${v.label} (${v.shown})`}
              inputMode="decimal"
              autoComplete="off"
              value={values[v.id] ?? ''}
              onChange={(e) => setValues({ ...values, [v.id]: e.target.value })}
              error={errors.find((x) => x.fieldId === `vital-${v.id}`)?.message}
            />
          ))}
        </div>
        <Button type="submit" variant="primary" disabled={busy || !online}>
          {busy ? p.savingVitals : p.saveVitals}
        </Button>
      </form>
      {failure !== null && <ActionError failure={failure} />}
      {notice && (
        <Banner tone="info">
          <p>{p.vitalsSaved}</p>
        </Banner>
      )}
      {recorded.length > 0 && (
        <>
          <h4>{p.recorded}</h4>
          <ul className="ehr-plain-list" aria-label={p.recorded}>
            {recorded.map((v) => {
              const spec = specOf(v.loincCode);
              const unit = spec?.shown ?? v.unit ?? '';
              return (
                <li key={v.vitalId}>
                  <span>{spec?.label ?? v.loincCode}: </span>
                  <RangeText
                    status={v.enteredInError ? 'entered_in_error' : v.rangeStatus}
                    value={v.value === null ? '' : String(v.value)}
                    unit={unit}
                    low={v.rangeLow}
                    high={v.rangeHigh}
                  />
                </li>
              );
            })}
          </ul>
          {outOfRange.length > 0 && (
            <p className="ehr-muted">
              {outOfRange.length} value{outOfRange.length === 1 ? '' : 's'} flagged as out of range.
              Saving was not blocked.
            </p>
          )}
        </>
      )}
    </section>
  );
}

function TriageForm({
  checkInId,
  existing,
  chainLength,
  onSaved,
}: {
  checkInId: string;
  existing: TriageCategory | null;
  chainLength: number | undefined;
  onSaved: (s: TriageSaved) => void;
}) {
  const { api, can, online } = useDesk();
  const [category, setCategory] = useState<TriageCategory | ''>('');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [done, setDone] = useState(false);
  const key = useRef<{ sig: string; key: string } | null>(null);

  if (!can('clinical.triage.record'))
    return <p className="ehr-muted">{p.noPermission('record triage')}</p>;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const errs: FieldError[] = [];
    if (category === '') errs.push({ fieldId: 'triage-category', message: p.categoryMissing });
    if (notes.length > 5000) errs.push({ fieldId: 'triage-notes', message: p.notesTooLong });
    setErrors(errs);
    if (errs.length > 0 || category === '') return;
    const sig = JSON.stringify([category, notes, chainLength]);
    if (key.current === null || key.current.sig !== sig) key.current = { sig, key: newKey() };
    setBusy(true);
    setFailure(null);
    setDone(false);
    const r = await api.recordTriage(
      checkInId,
      { category, ...(notes.trim() === '' ? {} : { notes: notes.trim() }) },
      existing === null ? undefined : chainLength,
      key.current.key,
    );
    setBusy(false);
    if (r.ok) {
      key.current = null;
      setDone(true);
      setNotes('');
      onSaved(r.data);
    } else {
      setFailure(r);
      if (r.status > 0 && r.status < 500 && r.status !== 429) key.current = null;
    }
  }

  return (
    <section aria-labelledby="triage-form-title">
      <h3 id="triage-form-title">{p.triageFormTitle}</h3>
      {existing !== null && (
        <p>
          <StatusChip
            tone={existing === 'emergency' || existing === 'urgent' ? 'danger' : 'neutral'}
          >
            {p.currentTriage(categoryLabel[existing])}
          </StatusChip>{' '}
          <span className="ehr-muted">{p.retriage}</span>
        </p>
      )}
      <form onSubmit={(e) => void submit(e)} noValidate>
        <ErrorSummary errors={errors} />
        <SelectField
          id="triage-category"
          label={p.categoryLabel}
          hint={p.categoryHint}
          value={category}
          onChange={(e) => setCategory(e.target.value as TriageCategory | '')}
          error={errors.find((x) => x.fieldId === 'triage-category')?.message}
        >
          <option value="">{p.chooseCategory}</option>
          {TRIAGE_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {categoryLabel[c]}
            </option>
          ))}
        </SelectField>
        <TextAreaField
          id="triage-notes"
          label={p.notes}
          hint={p.notesHint}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          error={errors.find((x) => x.fieldId === 'triage-notes')?.message}
          rows={4}
        />
        <Button type="submit" variant="primary" disabled={busy || !online}>
          {busy ? p.savingTriage : p.saveTriage}
        </Button>
      </form>
      {failure !== null && <ActionError failure={failure} />}
      {done && (
        <Banner tone="info">
          <p>{p.triageSaved}</p>
        </Banner>
      )}
    </section>
  );
}
