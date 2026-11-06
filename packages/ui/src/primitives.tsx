import { useEffect, useId, useRef, useState } from 'react';
import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { pick } from './strings.js';
import type { Copy } from './strings.js';
import { cx } from './cx.js';

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

const TONE_ICON: Record<Tone, string> = {
  neutral: '•',
  info: 'ℹ',
  success: '✓',
  warning: '!',
  danger: '✕',
};

/** Status is text + icon + colour (UX-R9). The label is required so colour is never the only cue. */
export function StatusChip({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={cx('ehr-chip', `ehr-chip--${tone}`)}>
      <span aria-hidden="true" className="ehr-chip__icon">
        {TONE_ICON[tone]}
      </span>
      {children}
    </span>
  );
}

/** Banner: info, warning, danger. `danger` is announced assertively; others politely. Never auto-dismisses. */
export function Banner({
  tone = 'info',
  title,
  children,
  actions,
  announce = true,
}: {
  tone?: 'info' | 'warning' | 'danger';
  title?: string;
  children: ReactNode;
  actions?: ReactNode;
  announce?: boolean;
}) {
  const role = !announce ? undefined : tone === 'danger' ? 'alert' : 'status';
  return (
    <div className={cx('ehr-banner', `ehr-banner--${tone}`)} role={role}>
      <span aria-hidden="true" className="ehr-chip__icon">
        {TONE_ICON[tone]}
      </span>
      <div className="ehr-banner__body">
        {title !== undefined && <strong className="ehr-banner__title">{title}</strong>}
        <div>{children}</div>
      </div>
      {actions !== undefined && <div className="ehr-banner__actions">{actions}</div>}
    </div>
  );
}

/** Skeleton block in the final layout (UI-UX 6, loading first). Decorative: the parent carries aria-busy. */
export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="ehr-skeleton" aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="ehr-skeleton__line" />
      ))}
    </div>
  );
}

interface FieldChrome {
  label: string;
  hint?: string;
  error?: string;
}

function useFieldIds(id?: string) {
  const auto = useId();
  const base = id ?? auto;
  return { base, hintId: `${base}-hint`, errorId: `${base}-error` };
}

function FieldFrame({
  base,
  hintId,
  errorId,
  label,
  hint,
  error,
  children,
}: FieldChrome & { base: string; hintId: string; errorId: string; children: ReactNode }) {
  return (
    <div className={cx('ehr-field', error !== undefined && 'ehr-field--error')}>
      <label htmlFor={base} className="ehr-field__label">
        {label}
      </label>
      {hint !== undefined && (
        <p id={hintId} className="ehr-field__hint">
          {hint}
        </p>
      )}
      {children}
      {error !== undefined && (
        <p id={errorId} className="ehr-field__error">
          <span aria-hidden="true">✕ </span>
          {error}
        </p>
      )}
    </div>
  );
}

function describedBy(
  hint: string | undefined,
  error: string | undefined,
  ids: { hintId: string; errorId: string },
) {
  const parts = [hint !== undefined && ids.hintId, error !== undefined && ids.errorId].filter(
    Boolean,
  );
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/** Visible label, hint and error tied with aria-describedby (WCAG 3.3.1, 3.3.2). */
export function TextField({
  label,
  hint,
  error,
  id,
  ...rest
}: FieldChrome & InputHTMLAttributes<HTMLInputElement>) {
  const ids = useFieldIds(id);
  return (
    <FieldFrame {...ids} label={label} hint={hint} error={error}>
      <input
        {...rest}
        id={ids.base}
        className="ehr-input"
        aria-invalid={error !== undefined ? true : undefined}
        aria-describedby={describedBy(hint, error, ids)}
      />
    </FieldFrame>
  );
}

export function TextAreaField({
  label,
  hint,
  error,
  id,
  ...rest
}: FieldChrome & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ids = useFieldIds(id);
  return (
    <FieldFrame {...ids} label={label} hint={hint} error={error}>
      <textarea
        {...rest}
        id={ids.base}
        className="ehr-input ehr-input--area"
        aria-invalid={error !== undefined ? true : undefined}
        aria-describedby={describedBy(hint, error, ids)}
      />
    </FieldFrame>
  );
}

export function SelectField({
  label,
  hint,
  error,
  id,
  children,
  ...rest
}: FieldChrome & SelectHTMLAttributes<HTMLSelectElement>) {
  const ids = useFieldIds(id);
  return (
    <FieldFrame {...ids} label={label} hint={hint} error={error}>
      <select
        {...rest}
        id={ids.base}
        className="ehr-input"
        aria-invalid={error !== undefined ? true : undefined}
        aria-describedby={describedBy(hint, error, ids)}
      >
        {children}
      </select>
    </FieldFrame>
  );
}

export interface FieldError {
  fieldId: string;
  message: string;
}

/** Summary at the top that receives focus; names what to change, never the entered value (CN-03, 3.3.3). */
export function ErrorSummary({
  title,
  errors,
  copy,
}: {
  title?: string;
  errors: FieldError[];
  copy?: Copy;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (errors.length > 0) ref.current?.focus();
  }, [errors]);
  if (errors.length === 0) return null;
  return (
    <div ref={ref} tabIndex={-1} role="alert" className="ehr-error-summary">
      <h2 className="ehr-error-summary__title">{title ?? pick(copy).errorSummaryTitle}</h2>
      <ul>
        {errors.map((e) => (
          <li key={e.fieldId}>
            <a
              href={`#${e.fieldId}`}
              onClick={(ev) => {
                const el = document.getElementById(e.fieldId);
                if (el !== null) {
                  ev.preventDefault();
                  el.focus();
                }
              }}
            >
              {e.message}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface ToastItem {
  id: string;
  message: string;
  action?: ReactNode;
}

/** Toast: low-risk confirmations only (UI-UX 6, success). Never carries the only copy of a safety message.
 * It does not vanish on a timer shorter than the caller's `dismissAfterMs`; the user can always close it. */
export function ToastRegion({
  toasts,
  onDismiss,
  dismissAfterMs,
}: {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
  dismissAfterMs?: number;
}) {
  useEffect(() => {
    if (dismissAfterMs === undefined) return;
    const timers = toasts.map((t) => setTimeout(() => onDismiss(t.id), dismissAfterMs));
    return () => timers.forEach(clearTimeout);
  }, [toasts, dismissAfterMs, onDismiss]);
  return (
    <div className="ehr-toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="ehr-toast">
          <span>{t.message}</span>
          {t.action}
          <button
            type="button"
            className="ehr-toast__close"
            aria-label="Dismiss message"
            onClick={() => onDismiss(t.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

/** Single-field code entry (OTP). One input with autocomplete one-time-code, paste allowed (3.3.8). */
export function OtpInput({
  label,
  length = 6,
  value,
  onChange,
  error,
  hint,
  copy,
}: {
  copy?: Copy;
  label?: string;
  length?: number;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  hint?: string;
}) {
  return (
    <TextField
      label={label ?? pick(copy).otpLabel}
      hint={hint}
      error={error}
      value={value}
      inputMode="numeric"
      autoComplete="one-time-code"
      maxLength={length}
      pattern={`[0-9]{${length}}`}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, length))}
    />
  );
}

/** Busy-state helper for idempotent retry buttons: disables while pending and reports progress. */
export function useBusy() {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}
