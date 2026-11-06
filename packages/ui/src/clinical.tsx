import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { AlertDialog } from './alert-dialog.js';
import { Button } from './button.js';
import { StatusChip } from './primitives.js';
import { TextAreaField } from './primitives.js';
import { pick } from './strings.js';
import type { Copy } from './strings.js';
import { cx } from './cx.js';

export interface AllergyItem {
  id: string;
  name: string;
  severity?: 'severe' | 'moderate' | 'mild';
}

/** `null` = the user passes neither the chart read nor the pre-visit read: shown as a neutral chip so a hidden
 * block is never read as "none" (UX-R1, AL-01). */
export type AllergyData = {
  state: 'none_recorded' | 'recorded';
  items: AllergyItem[];
  moreCount?: number;
  uncodedCount?: number;
} | null;

const MAX_ALLERGIES = 10;
const SEVERITY_ORDER = { severe: 0, moderate: 1, mild: 2 } as const;

/** Allergy block: recorded, none recorded, not shown, uncoded chip. Severe first, at most 10, "+n more" opens the
 * allergy list. "No allergies recorded", never "No known allergies" (BQ-11). Red and text, never colour alone. */
export function AllergyBlock({
  allergies,
  onOpenList,
  copy,
}: {
  allergies: AllergyData;
  onOpenList?: () => void;
  copy?: Copy;
}) {
  const s = pick(copy);
  if (allergies === null) {
    return (
      <div className="ehr-allergy ehr-allergy--hidden" data-allergy-state="not-shown">
        <StatusChip tone="neutral">{s.allergyNotAvailable}</StatusChip>
      </div>
    );
  }
  const sorted = [...allergies.items].sort(
    (a, b) => SEVERITY_ORDER[a.severity ?? 'mild'] - SEVERITY_ORDER[b.severity ?? 'mild'],
  );
  const shown = sorted.slice(0, MAX_ALLERGIES);
  const more = (allergies.moreCount ?? 0) + (sorted.length - shown.length);
  const uncoded = allergies.uncodedCount ?? 0;
  return (
    <div
      className={cx('ehr-allergy', allergies.state === 'recorded' && 'ehr-allergy--recorded')}
      data-allergy-state={allergies.state}
    >
      <strong className="ehr-allergy__label">Allergies</strong>{' '}
      {allergies.state === 'none_recorded' ? (
        <span>{s.allergyNoneRecorded}</span>
      ) : (
        <ul className="ehr-allergy__list" aria-label="Allergies">
          {shown.map((a) => (
            <li key={a.id}>
              {a.name}
              {a.severity === 'severe' && <span className="ehr-allergy__sev"> (severe)</span>}
            </li>
          ))}
        </ul>
      )}
      {more > 0 &&
        (onOpenList !== undefined ? (
          <button type="button" className="ehr-link-btn" onClick={onOpenList}>
            {s.allergyMore(more)}
            <span className="ehr-visually-hidden"> allergies, open the allergy list</span>
          </button>
        ) : (
          <span>{s.allergyMore(more)}</span>
        ))}
      {uncoded > 0 && <StatusChip tone="warning">{s.allergyUncoded(uncoded)}</StatusChip>}
    </div>
  );
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');
}

/** Patient banner (UX-R1, BR-34): photo or initials, name, DOB and age, MRN, allergies. Sticky; on phones it
 * collapses to avatar, name, DOB and the allergy flag and expands on tap. Name and DOB always stay visible.
 * Rendered with the banner that came with the screen's own call; it never fetches. */
export function PatientBanner({
  name,
  dob,
  age,
  sex,
  mrn,
  photoUrl,
  allergies,
  onOpenAllergies,
  actions,
  copy,
}: {
  name: string;
  dob: string;
  age: string;
  sex?: string;
  mrn: string;
  photoUrl?: string;
  allergies: AllergyData;
  onOpenAllergies?: () => void;
  actions?: ReactNode;
  copy?: Copy;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="ehr-patient-banner" aria-label="Patient">
      <div className="ehr-avatar" aria-hidden="true">
        {photoUrl !== undefined ? <img src={photoUrl} alt="" /> : initials(name)}
      </div>
      <div className="ehr-patient-banner__id">
        <p className="ehr-patient-banner__name">{name}</p>
        <p className="ehr-patient-banner__dob">
          DOB {dob} ({age})
        </p>
      </div>
      <div
        className={cx('ehr-patient-banner__more', open && 'ehr-patient-banner__more--open')}
        id="ehr-banner-more"
      >
        <p className="ehr-patient-banner__mrn">
          {sex !== undefined && `${sex} · `}MRN {mrn}
        </p>
        <AllergyBlock allergies={allergies} onOpenList={onOpenAllergies} copy={copy} />
      </div>
      <button
        type="button"
        className="ehr-btn ehr-patient-banner__toggle"
        aria-expanded={open}
        aria-controls="ehr-banner-more"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? 'Hide details' : 'Show details'}
      </button>
      {actions !== undefined && <div className="ehr-patient-banner__actions">{actions}</div>}
    </section>
  );
}

export type RangeStatus =
  'out_of_range' | 'in_range' | 'no_range' | 'unit_mismatch' | 'entered_in_error';

/** Range text for vitals, five states (UI-UX 8, AL-02). Never blocks saving, no green tick, no reassurance, and
 * nothing implies the range is clinically validated. `low`/`high` may be null (one-sided range). */
export function RangeText({
  status,
  value,
  unit,
  low,
  high,
  copy,
}: {
  status: RangeStatus;
  value?: string;
  unit: string;
  low?: number | null;
  high?: number | null;
  copy?: Copy;
}) {
  const s = pick(copy);
  const range =
    low != null && high != null
      ? `Range ${low}-${high} ${unit}`
      : low != null
        ? `Range at least ${low} ${unit}`
        : high != null
          ? `Range at most ${high} ${unit}`
          : '';
  if (status === 'entered_in_error') {
    return (
      <span className="ehr-range ehr-range--eie">
        <s className="ehr-range__struck">{value ?? ''}</s> {s.enteredInError}
      </span>
    );
  }
  return (
    <span
      className={cx('ehr-range', status === 'out_of_range' && 'ehr-range--out')}
      data-range-status={status}
    >
      <span className="ehr-range__value">
        {value} {unit}
      </span>
      {status === 'out_of_range' && (
        <>
          {' '}
          <strong>{s.outOfRange}</strong>
        </>
      )}
      {(status === 'out_of_range' || status === 'in_range') && range !== '' && (
        <span className="ehr-range__text"> {range}</span>
      )}
      {status === 'no_range' && <span className="ehr-range__text"> {s.noRange}</span>}
      {status === 'unit_mismatch' && <span className="ehr-range__text"> {s.unitMismatch}</span>}
    </span>
  );
}

/** Confirm-risk dialog (UX-R3): the button label names the consequence, no OK/Yes/No, Cancel is the default
 * focus. Optionally restates patient name + DOB (wrong-patient prevention, BR-34). No timer, no auto-dismiss. */
export function ConfirmRiskDialog({
  title,
  consequence,
  confirmLabel,
  onConfirm,
  onCancel,
  patient,
  busy,
  cancelLabel,
  children,
  copy,
}: {
  title: string;
  consequence: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  patient?: { name: string; dob: string };
  busy?: boolean;
  cancelLabel?: string;
  children?: ReactNode;
  copy?: Copy;
}) {
  const s = pick(copy);
  return (
    <AlertDialog
      title={title}
      initialFocus="[data-cancel]"
      actions={
        <>
          <Button variant="primary" onClick={onConfirm} disabled={busy}>
            {confirmLabel}
          </Button>
          <Button data-cancel onClick={onCancel}>
            {cancelLabel ?? s.cancel}
          </Button>
        </>
      }
    >
      {patient !== undefined && (
        <p className="ehr-dialog__patient">
          <strong>{patient.name}</strong>, DOB {patient.dob}
        </p>
      )}
      <p>{consequence}</p>
      {children}
    </AlertDialog>
  );
}

/** Signing dialog: patient name + DOB, what will be locked, and the button "Sign and lock note". */
export function SignNoteDialog(props: {
  patient: { name: string; dob: string };
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  copy?: Copy;
}) {
  const s = pick(props.copy);
  return (
    <ConfirmRiskDialog
      title={s.signAndLock}
      consequence="Signing locks this note. Later changes are addenda with author and time."
      confirmLabel={s.signAndLock}
      {...props}
    />
  );
}

/** Break-the-glass dialog: reason of at least 10 characters is required, consequence stated (BR-14, UXR-05). */
export function BreakTheGlassDialog({
  onConfirm,
  onCancel,
  copy,
}: {
  onConfirm: (reason: string) => void;
  onCancel: () => void;
  copy?: Copy;
}) {
  const s = pick(copy);
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const short = reason.trim().length < 10;
  return (
    <AlertDialog
      title={s.btgTitle}
      initialFocus="textarea"
      actions={
        <>
          <Button
            variant="primary"
            onClick={() => (short ? setTried(true) : onConfirm(reason.trim()))}
          >
            {s.btgContinue}
          </Button>
          <Button onClick={onCancel}>{s.cancel}</Button>
        </>
      }
    >
      <p>{s.btgConsequence}</p>
      <TextAreaField
        label={s.btgReason}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        error={tried && short ? s.btgReasonShort : undefined}
      />
    </AlertDialog>
  );
}

/** Banner on the chart while emergency access is open. */
export function EmergencyAccessBanner({ copy }: { copy?: Copy }) {
  return (
    <p role="status" className="ehr-bar ehr-bar--danger">
      <strong>{pick(copy).emergencyAccess}</strong>
    </p>
  );
}

/** Passkey prompt: states what to do, offers another way, never a timer-only cue. */
export function PasskeyPrompt({
  onCancel,
  waiting = true,
  title,
  body,
  copy,
}: {
  onCancel: () => void;
  waiting?: boolean;
  title?: string;
  body?: string;
  copy?: Copy;
}) {
  const s = pick(copy);
  return (
    <AlertDialog
      title={title ?? s.passkeyTitle}
      actions={<Button onClick={onCancel}>{s.passkeyCancel}</Button>}
    >
      <p aria-busy={waiting}>{body ?? s.passkeyBody}</p>
    </AlertDialog>
  );
}

/** Security-key step (admin and break-the-glass review re-entry): same pattern, its own words. */
export function SecurityKeyPrompt(props: { onCancel: () => void; waiting?: boolean; copy?: Copy }) {
  return (
    <PasskeyPrompt
      {...props}
      title="Use your security key"
      body="Touch your security key to continue."
    />
  );
}

/** Re-authentication dialog (`401 auth.reauth_required`): the draft is kept; the caller repeats the request
 * with the same idempotency key after return (UI-UX 7.1). */
export function ReauthDialog({
  onReauth,
  onCancel,
}: {
  onReauth: () => void;
  onCancel: () => void;
}) {
  return (
    <AlertDialog
      title="Confirm it's you"
      actions={
        <>
          <Button variant="primary" onClick={onReauth}>
            Sign in again
          </Button>
          <Button onClick={onCancel}>Cancel</Button>
        </>
      }
    >
      <p>For your safety, sign in again to finish this. Your draft is kept.</p>
    </AlertDialog>
  );
}

/** SOAP editor with sign: four labelled sections, draft-saved status, Save draft and Sign and lock. After signing the
 * note is read-only with "Add addendum". The server draft route owns saving; this component only reports intent. */
export function SoapEditor({
  value,
  onChange,
  onSaveDraft,
  onSign,
  draftSavedAt,
  signed,
  onAddAddendum,
  copy,
}: {
  value: { s: string; o: string; a: string; p: string };
  onChange: (next: { s: string; o: string; a: string; p: string }) => void;
  onSaveDraft: () => void;
  onSign: () => void;
  draftSavedAt?: string;
  signed?: boolean;
  onAddAddendum?: () => void;
  copy?: Copy;
}) {
  const s = pick(copy);
  const fields = [
    ['s', 'S: Subjective'],
    ['o', 'O: Objective'],
    ['a', 'A: Assessment'],
    ['p', 'P: Plan'],
  ] as const;
  return (
    <form className="ehr-soap" aria-label="Visit note" onSubmit={(e) => e.preventDefault()}>
      <p role="status" className="ehr-soap__status">
        {signed
          ? 'Signed. This note is read-only.'
          : draftSavedAt
            ? `Draft saved ${draftSavedAt}`
            : 'Draft, not signed'}
      </p>
      {fields.map(([k, label]) => (
        <TextAreaField
          key={k}
          label={label}
          value={value[k]}
          readOnly={signed}
          onChange={(e) => onChange({ ...value, [k]: e.target.value })}
        />
      ))}
      <div className="ehr-dialog__actions">
        {signed ? (
          onAddAddendum && <Button onClick={onAddAddendum}>Add addendum</Button>
        ) : (
          <>
            <Button onClick={onSaveDraft}>Save draft</Button>
            <Button variant="primary" onClick={onSign}>
              {s.signAndLock}
            </Button>
          </>
        )}
      </div>
    </form>
  );
}

export interface AlertRow {
  id: string;
  type: string;
  where: string;
  patient?: string;
  /** Server time (ms) at which the alert escalates; null = not set. */
  escalatesAtMs: number | null;
  status: 'open' | 'escalated' | 'acknowledged' | 'closed';
  escalationLevel?: number;
  acknowledgedBy?: string;
  acknowledgedAt?: string;
  alreadyAcknowledged?: boolean;
}

function mmss(ms: number) {
  const t = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

/** Per-row escalation text per the countdown rule (UI-UX 7.4). `serverNow` is server time moved on by local
 * elapsed time; the device clock alone is never used. The text is rendered outside any live region so the
 * countdown is not announced every second. */
export function escalationText(row: AlertRow, serverNow: number, copy?: Copy): string | null {
  const s = pick(copy);
  if (row.status === 'acknowledged' || row.status === 'closed') return null;
  if (row.escalatesAtMs !== null) return s.escalatesIn(mmss(row.escalatesAtMs - serverNow));
  if (row.status === 'escalated') return s.escalated(row.escalationLevel ?? 1);
  return s.escalationNotSet;
}

/** Alert tray: persistent rows, one-click acknowledge, acknowledged/closed states in text. */
export function AlertTray({
  alerts,
  serverNow,
  onAcknowledge,
  copy,
}: {
  alerts: AlertRow[];
  serverNow: () => number;
  onAcknowledge: (id: string) => void;
  copy?: Copy;
}) {
  const s = pick(copy);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!alerts.some((a) => a.escalatesAtMs !== null)) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [alerts]);
  return (
    <section aria-label="Alerts" className="ehr-tray">
      {alerts.length === 0 && <p className="ehr-muted">No open alerts.</p>}
      <ul className="ehr-plain-list">
        {alerts.map((a) => {
          const esc = escalationText(a, serverNow(), copy);
          return (
            <li key={a.id} className="ehr-tray__row">
              <strong>{a.type}</strong> · {a.where}
              {a.patient !== undefined && <> · {a.patient}</>}
              {esc !== null && <span className="ehr-tray__esc"> · {esc}</span>}
              {a.status === 'closed' && <p>{s.alertClosed}</p>}
              {a.status === 'acknowledged' && (
                <p>
                  {a.alreadyAcknowledged ? s.alreadyAcknowledged : 'Acknowledged'}
                  {a.acknowledgedBy !== undefined && ` by ${a.acknowledgedBy}`}
                  {a.acknowledgedAt !== undefined && ` at ${a.acknowledgedAt}`}
                </p>
              )}
              {(a.status === 'open' || a.status === 'escalated') && (
                <Button variant="primary" onClick={() => onAcknowledge(a.id)}>
                  {s.acknowledge}
                  <span className="ehr-visually-hidden"> alert, {a.type}</span>
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Alert bar: full-width danger bar with NO dismiss or close control (red flag, critical). States:
 * `raised` (creator side: only what the triage response gives), `paused` (stream refused: never looks like
 * "no alerts"), `disconnected` (offers "Check for alerts"). */
export function AlertBar({
  state,
  onReload,
  onCheck,
  children,
  copy,
}: {
  state: 'raised' | 'paused' | 'disconnected';
  onReload?: () => void;
  onCheck?: () => void;
  children?: ReactNode;
  copy?: Copy;
}) {
  const s = pick(copy);
  const text =
    children ??
    (state === 'raised'
      ? s.redFlagCreator
      : state === 'paused'
        ? s.alertsPaused
        : s.alertsReconnect);
  return (
    <div className="ehr-bar ehr-bar--danger ehr-alertbar" role="alert" data-alert-state={state}>
      <p className="ehr-bar__text">
        <strong>{text}</strong>
      </p>
      {state === 'paused' && onReload !== undefined && (
        <Button variant="primary" onClick={onReload}>
          Reload
        </Button>
      )}
      {state === 'disconnected' && onCheck !== undefined && (
        <Button onClick={onCheck}>{s.checkForAlerts}</Button>
      )}
    </div>
  );
}

/** BTG review panel: who, when, patient, reason given and the two decisions with a required reviewer note. */
export function BtgReviewPanel({
  who,
  opened,
  patient,
  reason,
  onDecide,
}: {
  who: string;
  opened: string;
  patient: string;
  reason: string;
  onDecide: (decision: 'justified' | 'not-justified', note: string) => void;
}) {
  const [note, setNote] = useState('');
  const [decision, setDecision] = useState<'justified' | 'not-justified' | null>(null);
  const [tried, setTried] = useState(false);
  return (
    <section className="ehr-card" aria-label="Break-the-glass review">
      <h3 className="ehr-state__sub">Break-the-glass review</h3>
      <dl className="ehr-dl">
        <dt>Who</dt>
        <dd>{who}</dd>
        <dt>Opened</dt>
        <dd>{opened}</dd>
        <dt>Patient</dt>
        <dd>{patient}</dd>
        <dt>Reason given</dt>
        <dd>{reason}</dd>
      </dl>
      <div role="radiogroup" aria-label="Decision" className="ehr-dialog__actions">
        {(['justified', 'not-justified'] as const).map((d) => (
          <label key={d} className="ehr-radio">
            <input
              type="radio"
              name="btg-decision"
              checked={decision === d}
              onChange={() => setDecision(d)}
            />{' '}
            {d === 'justified' ? 'Justified' : 'Not justified'}
          </label>
        ))}
      </div>
      <TextAreaField
        label="Reviewer note (required)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        error={
          tried && (note.trim() === '' || decision === null)
            ? 'Choose a decision and enter a note.'
            : undefined
        }
      />
      <Button
        variant="primary"
        onClick={() => {
          if (decision === null || note.trim() === '') setTried(true);
          else onDecide(decision, note.trim());
        }}
      >
        Submit review
      </Button>
    </section>
  );
}
