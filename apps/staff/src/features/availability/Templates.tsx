import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertDialog,
  Banner,
  Button,
  EmptyState,
  ErrorSummary,
  LoadingState,
  PermissionNote,
  SelectField,
  TextField,
} from '@ehr/ui';
import type { FieldError } from '@ehr/ui';
import { useAvailability } from './AvailabilityContext.js';
import { usePreview, PREVIEW_DAYS } from './preview.js';
import type { Hours } from './preview.js';
import { ActionError, LoadError } from './Problem.js';
import { useLoad } from '../preconsult/useLoad.js';
import { newKey } from '../preconsult/http.js';
import type { Failure } from '../preconsult/http.js';
import { avStrings as s } from './strings.js';
import type { Mode, Rule, Template } from './types.js';

/** Weekday order on screen: Monday first (0 = Sunday in the data). */
const ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

interface Win {
  key: string;
  start: string;
  end: string;
  mode: Mode;
  /** The rule this came from: services, room and overbooking are kept as they are. */
  base?: Rule;
}
interface Draft {
  validFrom: string;
  validTo: string;
  days: Record<number, Win[]>;
}

const today = () => new Date().toLocaleDateString('en-CA');
const emptyDays = (): Record<number, Win[]> => ({
  0: [],
  1: [],
  2: [],
  3: [],
  4: [],
  5: [],
  6: [],
});

function draftOf(t: Template | null): Draft {
  const days = emptyDays();
  if (t === null) {
    for (const w of [1, 2, 3, 4, 5])
      days[w] = [{ key: newKey(), start: '09:00', end: '17:00', mode: 'either' }];
    return { validFrom: today(), validTo: '', days };
  }
  for (const r of t.rules)
    days[r.weekday]?.push({
      key: r.id ?? newKey(),
      start: r.startLocal,
      end: r.endLocal,
      mode: r.mode,
      base: r,
    });
  for (const w of Object.values(days)) w.sort((a, b) => a.start.localeCompare(b.start));
  return { validFrom: t.validFrom, validTo: t.validTo ?? '', days };
}

function rulesOf(d: Draft): Rule[] {
  return ORDER.flatMap((weekday) =>
    (d.days[weekday] ?? []).map((w) => ({
      weekday,
      startLocal: w.start,
      endLocal: w.end,
      mode: w.mode,
      serviceIds: w.base?.serviceIds ?? null,
      roomId: w.base?.roomId ?? null,
      overbookable: w.base?.overbookable ?? false,
    })),
  );
}

function validate(d: Draft): FieldError[] {
  const out: FieldError[] = [];
  if (!DATE.test(d.validFrom)) out.push({ fieldId: 'av-valid-from', message: s.errFrom });
  if (d.validTo !== '' && (!DATE.test(d.validTo) || d.validTo < d.validFrom))
    out.push({ fieldId: 'av-valid-to', message: s.errTo });
  if (ORDER.every((w) => (d.days[w] ?? []).length === 0))
    out.push({ fieldId: 'av-add-1', message: s.errNeedRule });
  for (const w of ORDER) {
    const day = s.weekdays[w] as string;
    const list = d.days[w] ?? [];
    list.forEach((x, i) => {
      if (x.start === '' || x.end === '' || x.end <= x.start)
        out.push({ fieldId: `av-end-${w}-${i}`, message: s.errOrder(day, i + 1) });
    });
    const sorted = [...list].sort((a, b) => a.start.localeCompare(b.start));
    if (sorted.some((x, i) => i > 0 && x.start < (sorted[i - 1] as Win).end))
      out.push({ fieldId: `av-start-${w}-0`, message: s.errOverlap(day) });
  }
  return out;
}

const summary = (t: Template): string =>
  ORDER.map((w) => {
    const r = t.rules.filter((x) => x.weekday === w);
    return r.length === 0
      ? null
      : `${(s.weekdays[w] as string).slice(0, 3)} ${r.map((x) => `${x.startLocal}–${x.endLocal}`).join(', ')}`;
  })
    .filter((x) => x !== null)
    .join(' · ');

/** DR-11: weekly hours of the signed-in doctor at one location. Takes effect in the next search (RA-R1-23). */
export function Templates({ locationIds }: { locationIds: readonly string[] }) {
  const { api, can, principalId, online } = useAvailability();
  const [chosen, setChosen] = useState<string | null>(null);
  const locationId = chosen !== null && locationIds.includes(chosen) ? chosen : locationIds[0];
  const allowed = can('scheduling.template.manage');
  const { state, reload } = useLoad(() => api.templates(principalId), [], allowed);
  const [editing, setEditing] = useState<{ template: Template | null } | null>(null);
  const [retiring, setRetiring] = useState<Template | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const here = useMemo(
    () => (state.kind === 'ready' ? state.data.filter((t) => t.locationId === locationId) : []),
    [state, locationId],
  );

  if (!allowed) return <PermissionNote scope={s.noPermission} />;
  if (state.kind === 'loading') return <LoadingState label={s.hoursTitle} lines={4} />;
  if (state.kind === 'error') return <LoadError failure={state.failure} onRetry={reload} />;
  const all = state.data;

  return (
    <section aria-labelledby="av-hours-title">
      <h2 id="av-hours-title">{s.hoursTitle}</h2>
      <p>{s.hoursIntro}</p>
      {locationIds.length > 1 && (
        <div className="ehr-av-narrow">
          <SelectField
            label={s.location}
            value={locationId}
            onChange={(e) => {
              setChosen(e.target.value);
              setEditing(null);
            }}
          >
            {locationIds.map((id, i) => (
              <option key={id} value={id}>
                {s.locationN(i + 1)}
              </option>
            ))}
          </SelectField>
        </div>
      )}
      {done !== null && (
        <Banner tone="info">
          <p>{done}</p>
        </Banner>
      )}
      {state.failure !== undefined && (
        <Banner tone="warning">
          <p>{s.sessionFailed}</p>
        </Banner>
      )}
      {editing !== null && locationId !== undefined ? (
        <Editor
          key={editing.template?.id ?? 'new'}
          template={editing.template}
          locationId={locationId}
          others={all.filter((t) => t.locationId === locationId && t.id !== editing.template?.id)}
          onCancel={() => setEditing(null)}
          onSaved={(msg) => {
            setEditing(null);
            setDone(msg);
            reload();
          }}
        />
      ) : (
        <>
          <p>
            <Button
              variant="primary"
              disabled={!online || locationId === undefined}
              onClick={() => {
                setDone(null);
                setEditing({ template: null });
              }}
            >
              {s.newTemplate}
            </Button>
          </p>
          {here.length === 0 ? (
            <EmptyState message={s.hoursEmpty} />
          ) : (
            <ul className="ehr-av-list">
              {here.map((t) => (
                <li key={t.id} className="ehr-av-card">
                  <h3>{s.validity(t.validFrom, t.validTo)}</h3>
                  <p>{summary(t)}</p>
                  <div className="ehr-av-actions">
                    <Button
                      disabled={!online}
                      onClick={() => {
                        setDone(null);
                        setEditing({ template: t });
                      }}
                    >
                      {s.editTemplate}
                    </Button>
                    <Button disabled={!online} onClick={() => setRetiring(t)}>
                      {s.retireTemplate}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {retiring !== null && locationId !== undefined && (
        <RetireDialog
          template={retiring}
          others={all.filter((t) => t.locationId === locationId && t.id !== retiring.id)}
          onClose={() => setRetiring(null)}
          onDone={() => {
            setRetiring(null);
            setDone(s.retired);
            reload();
          }}
        />
      )}
    </section>
  );
}

/** The "affected appointments" result that both the editor and the stop dialog show before anything is saved. */
function PreviewResult({
  preview,
  acknowledged,
  onAcknowledge,
  onRetry,
}: {
  preview: ReturnType<typeof usePreview>['state'];
  acknowledged: boolean;
  onAcknowledge: (v: boolean) => void;
  onRetry: () => void;
}) {
  if (preview.kind === 'checking')
    return (
      <div role="status">
        <LoadingState label={s.checking} lines={2} />
      </div>
    );
  if (preview.kind === 'failed')
    return (
      <Banner tone="danger">
        <p>{s.previewFailed}</p>
        <Button onClick={onRetry}>{s.refresh}</Button>
      </Banner>
    );
  if (preview.kind !== 'ready') return null;
  const n = preview.stranded.length;
  return (
    <div className="ehr-av-preview" role="status">
      <p>{s.previewRange(PREVIEW_DAYS)}</p>
      {n === 0 ? (
        <p>{s.previewNone}</p>
      ) : (
        <>
          <Banner tone="warning" announce={false}>
            <p>{s.previewSome(n)}</p>
            <p>{s.previewKept}</p>
          </Banner>
          <ul>
            {preview.stranded.map(({ date, visit }) => (
              <li key={`${visit.startsAt}-${visit.endsAt}`}>
                {s.previewRow(
                  date,
                  new Date(visit.startsAt).toLocaleTimeString([], {
                    timeStyle: 'short',
                    timeZone: preview.timeZone,
                  }),
                  new Date(visit.endsAt).toLocaleTimeString([], {
                    timeStyle: 'short',
                    timeZone: preview.timeZone,
                  }),
                  visit.status.replace('_', ' '),
                )}
              </li>
            ))}
          </ul>
          <label className="ehr-av-check">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => onAcknowledge(e.target.checked)}
            />{' '}
            {s.previewAck}
          </label>
        </>
      )}
    </div>
  );
}

function Editor({
  template,
  locationId,
  others,
  onCancel,
  onSaved,
}: {
  template: Template | null;
  locationId: string;
  others: Template[];
  onCancel: () => void;
  onSaved: (message: string) => void;
}) {
  const { api, principalId, online } = useAvailability();
  const [draft, setDraft] = useState<Draft>(() => draftOf(template));
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  // One key per save attempt, reused if the same attempt is repeated after a timeout (the server replays the first answer).
  const key = useRef(newKey());
  const preview = usePreview(api, principalId, locationId);
  const checked = preview.state.kind === 'ready';
  const strandedCount = preview.state.kind === 'ready' ? preview.state.stranded.length : 0;

  const touch = (fn: (d: Draft) => Draft) => {
    setDraft(fn);
    setErrors([]);
    setFailure(null);
    setAck(false);
    key.current = newKey();
    preview.reset();
  };
  const setDay = (w: number, fn: (list: Win[]) => Win[]) =>
    touch((d) => ({ ...d, days: { ...d.days, [w]: fn(d.days[w] ?? []) } }));

  const hoursOf = (d: Draft): Hours => ({
    validFrom: d.validFrom,
    validTo: d.validTo === '' ? null : d.validTo,
    rules: rulesOf(d),
  });
  const check = () => {
    const found = validate(draft);
    setErrors(found);
    if (found.length > 0) return;
    setAck(false);
    // Before: every active template at this location. After: the same with this one replaced (or added).
    void preview.check(
      [...others, ...(template === null ? [] : [template])],
      [...others, hoursOf(draft)],
    );
  };
  const save = async () => {
    setBusy(true);
    setFailure(null);
    const body = {
      locationId,
      validFrom: draft.validFrom,
      validTo: draft.validTo === '' ? null : draft.validTo,
      rules: rulesOf(draft),
    };
    const out =
      template === null
        ? await api.createTemplate(principalId, body, key.current)
        : await api.replaceTemplate(principalId, template.id, template.version, body);
    setBusy(false);
    if (out.ok) onSaved(s.saved);
    else setFailure(out);
  };

  return (
    <form
      className="ehr-av-editor"
      aria-labelledby="av-editor-title"
      onSubmit={(e) => {
        e.preventDefault();
        if (!checked) check();
        else void save();
      }}
      noValidate
    >
      <h3 id="av-editor-title">{template === null ? s.newTemplate : s.editTemplate}</h3>
      <ErrorSummary title={s.fixErrors} errors={errors} />
      {failure !== null && <ActionError failure={failure} />}
      <div className="ehr-av-dates">
        <TextField
          id="av-valid-from"
          label={s.validFrom}
          type="date"
          value={draft.validFrom}
          onChange={(e) => touch((d) => ({ ...d, validFrom: e.target.value }))}
        />
        <TextField
          id="av-valid-to"
          label={s.validTo}
          type="date"
          value={draft.validTo}
          onChange={(e) => touch((d) => ({ ...d, validTo: e.target.value }))}
        />
      </div>
      <p className="ehr-muted">{s.keptNote}</p>
      {ORDER.map((w) => {
        const day = s.weekdays[w] as string;
        const list = draft.days[w] ?? [];
        return (
          <fieldset key={w} className="ehr-av-day">
            <legend>{day}</legend>
            {list.length === 0 && <p className="ehr-muted">{s.dayClosed}</p>}
            {list.map((x, i) => (
              <div key={x.key} className="ehr-av-window">
                <TextField
                  id={`av-start-${w}-${i}`}
                  label={s.windowStart(day, i + 1)}
                  type="time"
                  value={x.start}
                  onChange={(e) =>
                    setDay(w, (l) =>
                      l.map((y) => (y.key === x.key ? { ...y, start: e.target.value } : y)),
                    )
                  }
                />
                <TextField
                  id={`av-end-${w}-${i}`}
                  label={s.windowEnd(day, i + 1)}
                  type="time"
                  value={x.end}
                  onChange={(e) =>
                    setDay(w, (l) =>
                      l.map((y) => (y.key === x.key ? { ...y, end: e.target.value } : y)),
                    )
                  }
                />
                <SelectField
                  label={s.windowMode(day, i + 1)}
                  value={x.mode}
                  onChange={(e) =>
                    setDay(w, (l) =>
                      l.map((y) => (y.key === x.key ? { ...y, mode: e.target.value as Mode } : y)),
                    )
                  }
                >
                  {(['either', 'in_person', 'video'] as const).map((m) => (
                    <option key={m} value={m}>
                      {s.modeLabel(m)}
                    </option>
                  ))}
                </SelectField>
                <Button onClick={() => setDay(w, (l) => l.filter((y) => y.key !== x.key))}>
                  {s.removeWindow(day, i + 1)}
                </Button>
              </div>
            ))}
            <Button
              id={`av-add-${w}`}
              onClick={() =>
                setDay(w, (l) => [
                  ...l,
                  { key: newKey(), start: '09:00', end: '17:00', mode: 'either' },
                ])
              }
            >
              {s.addWindow(day)}
            </Button>
          </fieldset>
        );
      })}
      <PreviewResult
        preview={preview.state}
        acknowledged={ack}
        onAcknowledge={setAck}
        onRetry={check}
      />
      <div className="ehr-av-actions">
        {!checked ? (
          <Button
            variant="primary"
            type="submit"
            disabled={!online || preview.state.kind === 'checking'}
          >
            {s.review}
          </Button>
        ) : (
          <Button
            variant="primary"
            type="submit"
            disabled={!online || busy || (strandedCount > 0 && !ack)}
          >
            {s.saveHours}
          </Button>
        )}
        <Button onClick={onCancel}>{s.cancel}</Button>
      </div>
    </form>
  );
}

function RetireDialog({
  template,
  others,
  onClose,
  onDone,
}: {
  template: Template;
  others: Template[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { api, principalId, online } = useAvailability();
  const preview = usePreview(api, principalId, template.locationId);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const { check } = preview;
  useEffect(() => {
    void check([...others, template], others);
    // once per opening: the dialog is mounted for one template
  }, [check]);
  const n = preview.state.kind === 'ready' ? preview.state.stranded.length : 0;
  return (
    <AlertDialog
      title={s.confirmRetireTitle}
      initialFocus="[data-first]"
      actions={
        <>
          <Button
            variant="primary"
            disabled={!online || busy || preview.state.kind !== 'ready' || (n > 0 && !ack)}
            onClick={async () => {
              setBusy(true);
              const out = await api.retireTemplate(principalId, template.id, template.version);
              setBusy(false);
              if (out.ok) onDone();
              else setFailure(out);
            }}
          >
            {s.saveRetire}
          </Button>
          <Button data-first onClick={onClose}>
            {s.cancel}
          </Button>
        </>
      }
    >
      <p>{s.validity(template.validFrom, template.validTo)}</p>
      {failure !== null && <ActionError failure={failure} />}
      <PreviewResult
        preview={preview.state}
        acknowledged={ack}
        onAcknowledge={setAck}
        onRetry={() => void preview.check([...others, template], others)}
      />
    </AlertDialog>
  );
}
