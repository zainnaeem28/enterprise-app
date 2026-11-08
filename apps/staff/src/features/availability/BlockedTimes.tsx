import { useRef, useState } from 'react';
import {
  AlertDialog,
  Banner,
  Button,
  EmptyState,
  ErrorSummary,
  LoadingState,
  PermissionNote,
  SelectField,
  TextAreaField,
  TextField,
} from '@ehr/ui';
import type { FieldError } from '@ehr/ui';
import { useAvailability } from './AvailabilityContext.js';
import { ActionError, LoadError } from './Problem.js';
import { useLoad } from '../preconsult/useLoad.js';
import { newKey } from '../preconsult/http.js';
import type { Failure } from '../preconsult/http.js';
import { dateTimeOf } from '../doctor/format.js';
import { avStrings as s } from './strings.js';
import type { Blocked, BlockedKind, Conflicts } from './types.js';

interface Form {
  kind: BlockedKind;
  start: string;
  end: string;
  note: string;
}
const blank: Form = { kind: 'leave', start: '', end: '', note: '' };

/** `datetime-local` value in this device's time zone to an instant. */
const instant = (v: string): string | null => {
  if (v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/**
 * DR-12: leave and blocked time. "Check" asks the server for the appointments already booked in the period (`dryRun`, counts only,
 * nothing saved); saving is only offered after that, and with `acknowledgeConflicts` only once the doctor has confirmed the count.
 */
export function BlockedTimes() {
  const { api, can, principalId, online } = useAvailability();
  const allowed = can('scheduling.blocked_time.manage');
  const { state, reload } = useLoad(
    () => api.blockedTimes(principalId, new Date().toISOString()),
    [],
    allowed,
  );
  const [form, setForm] = useState<Form>(blank);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [conflicts, setConflicts] = useState<Conflicts | null>(null);
  const [ack, setAck] = useState(false);
  const [changed, setChanged] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Blocked | null>(null);
  const key = useRef(newKey());

  if (!allowed) return <PermissionNote scope={s.noPermission} />;
  if (state.kind === 'loading') return <LoadingState label={s.leaveTitle} lines={4} />;
  if (state.kind === 'error') return <LoadError failure={state.failure} onRetry={reload} />;

  const edit = (patch: Partial<Form>) => {
    setForm((f) => ({ ...f, ...patch }));
    setConflicts(null);
    setAck(false);
    setChanged(false);
    setErrors([]);
    setFailure(null);
    setDone(null);
    key.current = newKey();
  };

  const validate = (): { startsAt: string; endsAt: string } | null => {
    const startsAt = instant(form.start);
    const endsAt = instant(form.end);
    const found: FieldError[] = [];
    if (startsAt === null) found.push({ fieldId: 'av-b-start', message: s.errPeriod });
    else if (endsAt === null || endsAt <= startsAt)
      found.push({ fieldId: 'av-b-end', message: s.errPeriod });
    if (form.note.length > 200) found.push({ fieldId: 'av-b-note', message: s.errNote });
    setErrors(found);
    return found.length > 0 || startsAt === null || endsAt === null ? null : { startsAt, endsAt };
  };

  const check = async () => {
    const p = validate();
    if (p === null) return;
    setBusy(true);
    setFailure(null);
    const out = await api.saveBlocked(
      principalId,
      { ...p, kind: form.kind, note: form.note, dryRun: true },
      newKey(),
    );
    setBusy(false);
    if (out.ok) {
      setConflicts(out.data.conflicts);
      setAck(false);
      setChanged(false);
    } else setFailure(out);
  };

  const save = async () => {
    const p = validate();
    if (p === null || conflicts === null) return;
    setBusy(true);
    setFailure(null);
    const out = await api.saveBlocked(
      principalId,
      {
        ...p,
        kind: form.kind,
        note: form.note,
        ...(conflicts.total > 0 ? { acknowledgeConflicts: true } : {}),
      },
      key.current,
    );
    setBusy(false);
    if (out.ok) {
      setForm(blank);
      setConflicts(null);
      setAck(false);
      key.current = newKey();
      setDone(s.periodSaved);
      reload();
    } else if (out.conflicts !== undefined) {
      // New bookings arrived after the check: show the new count and ask again.
      setConflicts(out.conflicts);
      setAck(false);
      setChanged(true);
      key.current = newKey();
    } else setFailure(out);
  };

  return (
    <section aria-labelledby="av-leave-title">
      <h2 id="av-leave-title">{s.leaveTitle}</h2>
      <p>{s.leaveIntro}</p>
      {done !== null && (
        <Banner tone="info">
          <p>{done}</p>
        </Banner>
      )}
      <form
        className="ehr-av-editor"
        aria-label={s.leaveTitle}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (conflicts === null) void check();
          else void save();
        }}
      >
        <ErrorSummary title={s.fixErrors} errors={errors} />
        {failure !== null && <ActionError failure={failure} />}
        <SelectField
          label={s.kind}
          value={form.kind}
          onChange={(e) => edit({ kind: e.target.value as BlockedKind })}
        >
          {(['leave', 'blocked', 'admin'] as const).map((k) => (
            <option key={k} value={k}>
              {s.kindLabel(k)}
            </option>
          ))}
        </SelectField>
        <div className="ehr-av-dates">
          <TextField
            id="av-b-start"
            label={s.startsAt}
            type="datetime-local"
            value={form.start}
            onChange={(e) => edit({ start: e.target.value })}
          />
          <TextField
            id="av-b-end"
            label={s.endsAt}
            type="datetime-local"
            value={form.end}
            onChange={(e) => edit({ end: e.target.value })}
          />
        </div>
        <p className="ehr-muted">{s.deviceTime}</p>
        <TextAreaField
          id="av-b-note"
          label={s.note}
          hint={s.noteHint}
          rows={2}
          value={form.note}
          onChange={(e) => edit({ note: e.target.value })}
        />
        {changed && (
          <Banner tone="warning">
            <p>{s.periodChanged}</p>
          </Banner>
        )}
        {conflicts !== null && (
          <div className="ehr-av-preview" role="status">
            {conflicts.total === 0 ? (
              <p>{s.periodNone}</p>
            ) : (
              <>
                <Banner tone="warning" announce={false}>
                  <p>{s.periodSome(conflicts)}</p>
                  <p>{s.periodKept}</p>
                </Banner>
                <label className="ehr-av-check">
                  <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />{' '}
                  {s.periodAck}
                </label>
              </>
            )}
          </div>
        )}
        <div className="ehr-av-actions">
          {conflicts === null ? (
            <Button variant="primary" type="submit" disabled={!online || busy}>
              {s.checkPeriod}
            </Button>
          ) : (
            <Button
              variant="primary"
              type="submit"
              disabled={!online || busy || (conflicts.total > 0 && !ack)}
            >
              {s.savePeriod}
            </Button>
          )}
        </div>
      </form>

      {state.data.length === 0 ? (
        <EmptyState message={s.leaveEmpty} />
      ) : (
        <ul className="ehr-av-list">
          {state.data.map((b) => (
            <li key={b.id} className="ehr-av-card">
              <h3>{s.kindLabel(b.kind)}</h3>
              <p>
                {dateTimeOf(b.startsAt)} – {dateTimeOf(b.endsAt)}
              </p>
              {b.note !== null && <p>{b.note}</p>}
              <Button disabled={!online} onClick={() => setRemoving(b)}>
                {s.remove(s.kindLabel(b.kind), dateTimeOf(b.startsAt))}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {removing !== null && (
        <RemoveDialog
          blocked={removing}
          onClose={() => setRemoving(null)}
          onDone={() => {
            setRemoving(null);
            setDone(s.removed);
            reload();
          }}
        />
      )}
    </section>
  );
}

function RemoveDialog({
  blocked,
  onClose,
  onDone,
}: {
  blocked: Blocked;
  onClose: () => void;
  onDone: () => void;
}) {
  const { api, principalId, online } = useAvailability();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  return (
    <AlertDialog
      title={s.removeTitle}
      initialFocus="[data-first]"
      actions={
        <>
          <Button
            variant="primary"
            disabled={!online || busy}
            onClick={async () => {
              setBusy(true);
              const out = await api.deleteBlocked(principalId, blocked.id);
              setBusy(false);
              if (out.ok) onDone();
              else setFailure(out);
            }}
          >
            {s.removeConfirm}
          </Button>
          <Button data-first onClick={onClose}>
            {s.cancel}
          </Button>
        </>
      }
    >
      <p>
        {s.kindLabel(blocked.kind)}: {dateTimeOf(blocked.startsAt)} – {dateTimeOf(blocked.endsAt)}
      </p>
      <p>{s.removeBody}</p>
      {failure !== null && <ActionError failure={failure} />}
    </AlertDialog>
  );
}
