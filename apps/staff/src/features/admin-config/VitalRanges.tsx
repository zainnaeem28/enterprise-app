import { useState } from 'react';
import {
  Banner,
  Button,
  DataTable,
  EmptyState,
  ErrorSummary,
  SelectField,
  StatusChip,
  TextAreaField,
  TextField,
} from '@ehr/ui';
import type { Failure } from '../preconsult/http.js';
import { useConfig, usePrivileged, useRows } from './hooks.js';
import { ActionError, ListShell } from './Problem.js';
import { configStrings as s } from './strings.js';
import { parseRow, parseVitalRange } from './types.js';
import type { VitalRange } from './types.js';

const blank = {
  loincCode: '',
  unit: '',
  sex: 'any',
  ageFrom: '',
  ageTo: '',
  low: '',
  high: '',
  note: '',
};
const isNumber = (v: string) => v.trim() !== '' && Number.isFinite(Number(v));

/**
 * Vital-sign reference ranges (ARCHITECTURE 22.11). No range content is supplied by the design (BQ-12): the table ships empty and
 * every range is typed in with the clinical reviewer's note. A change is a new range plus retiring the old one; there is no edit.
 */
export function VitalRanges() {
  const { api } = useConfig();
  const run = usePrivileged();
  const rows = useRows('vital-ranges', s.elevateRead);
  const [v, setV] = useState(blank);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | undefined>();
  const [done, setDone] = useState<string | undefined>();
  const set = (k: keyof typeof blank) => (e: { target: { value: string } }) =>
    setV((p) => ({ ...p, [k]: e.target.value }));

  const ranges = rows.items
    ?.map((r) => parseVitalRange(r))
    .filter((r): r is VitalRange => r !== undefined);

  const fieldErrors = [
    ['loincCode', s.loinc],
    ['unit', s.unit],
    ['ageFrom', s.ageFrom],
    ['ageTo', s.ageTo],
    ['low', s.low],
    ['high', s.high],
    ['note', s.noteLabel],
  ]
    .filter(([k]) => errors[k as string] !== undefined)
    .map(([k, label]) => ({ fieldId: `vr-${k}`, message: `${label}: ${errors[k as string]}` }));

  const submit = async () => {
    const e: Record<string, string> = {};
    if (v.loincCode.trim() === '') e['loincCode'] = s.required;
    if (v.unit.trim() === '') e['unit'] = s.required;
    if (!/^\d{1,3}$/.test(v.ageFrom.trim())) e['ageFrom'] = s.mustBeNumber;
    if (v.ageTo.trim() !== '' && !/^\d{1,3}$/.test(v.ageTo.trim())) e['ageTo'] = s.mustBeNumber;
    else if (v.ageTo.trim() !== '' && Number(v.ageTo) <= Number(v.ageFrom)) e['ageTo'] = s.invalid;
    if (v.low.trim() !== '' && !isNumber(v.low)) e['low'] = s.numberInvalid;
    if (v.high.trim() !== '' && !isNumber(v.high)) e['high'] = s.numberInvalid;
    if (e['low'] === undefined && e['high'] === undefined) {
      if (v.low.trim() === '' && v.high.trim() === '') e['low'] = s.boundsMissing;
      else if (v.low.trim() !== '' && v.high.trim() !== '' && Number(v.low) >= Number(v.high))
        e['high'] = s.boundsOrder;
    }
    if (v.note.trim().length < 10) e['note'] = s.noteShort;
    setErrors(e);
    setFailure(undefined);
    setDone(undefined);
    if (Object.keys(e).length > 0) return;
    setBusy(true);
    try {
      const out = await run(
        { action: 'Add a vital-sign range', target: v.loincCode.trim(), approver: null },
        () =>
          api.send('POST', 'vital-ranges', {
            loincCode: v.loincCode.trim(),
            unit: v.unit.trim(),
            sex: v.sex,
            ageYears: {
              from: Number(v.ageFrom),
              ...(v.ageTo.trim() === '' ? {} : { to: Number(v.ageTo) }),
            },
            ...(v.low.trim() === '' ? {} : { low: Number(v.low) }),
            ...(v.high.trim() === '' ? {} : { high: Number(v.high) }),
            approvedByNote: v.note.trim(),
          }),
        parseRow,
      );
      if (out === undefined) return;
      if (!out.ok) return setFailure(out);
      setV(blank);
      setDone(s.saved);
      await rows.reload();
    } finally {
      setBusy(false);
    }
  };

  const retire = async (r: VitalRange) => {
    setFailure(undefined);
    setDone(undefined);
    setBusy(true);
    try {
      const out = await run(
        { action: 'Retire a vital-sign range', target: r.loincCode, approver: null },
        () => api.retireRange(r.id),
        parseRow,
      );
      if (out === undefined) return;
      if (!out.ok) return setFailure(out);
      setDone(s.retiredDone);
      await rows.reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="vitals-title">
      <h1 id="vitals-title">{s.vitalsTitle}</h1>
      <p>{s.vitalsIntro}</p>
      <p>{s.auditNote}</p>
      <ListShell
        state={rows.state}
        items={ranges}
        reload={() => void rows.reload()}
        more={() => void rows.more()}
      >
        {ranges?.length === 0 ? (
          <EmptyState message={s.vitalsEmpty} />
        ) : (
          <DataTable
            caption={s.vitalsTitle}
            rows={ranges ?? []}
            rowKey={(r) => r.id}
            columns={[
              { key: 'code', header: s.loinc, render: (r) => <code>{r.loincCode}</code> },
              { key: 'unit', header: s.unit, render: (r) => r.unit },
              { key: 'sex', header: s.sex, render: (r) => s.sexes[r.sex] ?? r.sex },
              { key: 'age', header: 'Age (years)', render: (r) => s.bandText(r.ageFrom, r.ageTo) },
              {
                key: 'low',
                header: s.low,
                render: (r) => (r.low === null ? s.none : String(r.low)),
              },
              {
                key: 'high',
                header: s.high,
                render: (r) => (r.high === null ? s.none : String(r.high)),
              },
              {
                key: 'status',
                header: 'State',
                render: (r) => (
                  <StatusChip tone={r.status === 'active' ? 'success' : 'neutral'}>
                    {r.status === 'active' ? s.active : s.retired2}
                  </StatusChip>
                ),
              },
              {
                key: 'actions',
                header: '',
                render: (r) =>
                  r.status === 'active' ? (
                    <Button
                      disabled={busy}
                      aria-label={`${s.retire}: ${r.loincCode}, ${s.sexes[r.sex] ?? r.sex}, ${s.bandText(r.ageFrom, r.ageTo)}`}
                      onClick={() => void retire(r)}
                    >
                      {s.retire}
                    </Button>
                  ) : null,
              },
            ]}
          />
        )}
      </ListShell>
      {done !== undefined && (
        <Banner tone="info" announce>
          <p>{done}</p>
        </Banner>
      )}
      <form
        noValidate
        className="ehr-panel"
        aria-labelledby="vr-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2 id="vr-form">{`${s.add}: ${s.vitalsTitle}`}</h2>
        <ErrorSummary title={s.summaryTitle} errors={fieldErrors} />
        <TextField
          id="vr-loincCode"
          label={s.loinc}
          value={v.loincCode}
          maxLength={20}
          onChange={set('loincCode')}
          {...(errors['loincCode'] ? { error: errors['loincCode'] } : {})}
        />
        <TextField
          id="vr-unit"
          label={s.unit}
          hint="The unit the range is stated in, for example mm[Hg]."
          value={v.unit}
          maxLength={30}
          onChange={set('unit')}
          {...(errors['unit'] ? { error: errors['unit'] } : {})}
        />
        <SelectField id="vr-sex" label={s.sex} value={v.sex} onChange={set('sex')}>
          {Object.entries(s.sexes).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </SelectField>
        <TextField
          id="vr-ageFrom"
          label={s.ageFrom}
          inputMode="numeric"
          value={v.ageFrom}
          onChange={set('ageFrom')}
          {...(errors['ageFrom'] ? { error: errors['ageFrom'] } : {})}
        />
        <TextField
          id="vr-ageTo"
          label={s.ageTo}
          hint={s.ageToHint}
          inputMode="numeric"
          value={v.ageTo}
          onChange={set('ageTo')}
          {...(errors['ageTo'] ? { error: errors['ageTo'] } : {})}
        />
        <TextField
          id="vr-low"
          label={s.low}
          hint={s.boundsHint}
          inputMode="decimal"
          value={v.low}
          onChange={set('low')}
          {...(errors['low'] ? { error: errors['low'] } : {})}
        />
        <TextField
          id="vr-high"
          label={s.high}
          inputMode="decimal"
          value={v.high}
          onChange={set('high')}
          {...(errors['high'] ? { error: errors['high'] } : {})}
        />
        <TextAreaField
          id="vr-note"
          label={s.noteLabel}
          hint={s.noteHint}
          value={v.note}
          maxLength={1000}
          onChange={set('note')}
          {...(errors['note'] ? { error: errors['note'] } : {})}
        />
        {failure !== undefined && <ActionError failure={failure} />}
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? s.saving : s.save}
        </Button>
      </form>
    </section>
  );
}
