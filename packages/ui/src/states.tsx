import { Icon } from './icon.js';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { AlertDialog } from './alert-dialog.js';
import { Button } from './button.js';
import { Banner, Skeleton } from './primitives.js';
import { pick } from './strings.js';
import type { Copy } from './strings.js';
import { cx } from './cx.js';

/** Loading, first: skeleton in the final layout, aria-busy, "Loading" announced once, "Still working…" after 8 s. */
export function LoadingState({
  label,
  lines,
  onRetry,
  stillWorkingAfterMs = 8000,
  copy,
}: {
  label?: string;
  lines?: number;
  onRetry?: () => void;
  stillWorkingAfterMs?: number;
  copy?: Copy;
}) {
  const s = pick(copy);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), stillWorkingAfterMs);
    return () => clearTimeout(t);
  }, [stillWorkingAfterMs]);
  return (
    <div aria-busy="true" className="ehr-state">
      <p role="status" className="ehr-visually-hidden">
        {label ?? s.loading}
      </p>
      <Skeleton lines={lines} />
      {slow && (
        <p className="ehr-state__text">
          {s.stillWorking} {onRetry !== undefined && <Button onClick={onRetry}>{s.retry}</Button>}
        </p>
      )}
    </div>
  );
}

/** Loading, refresh: old content stays, thin progress bar and "Updating" text. Never blank a clinical chart. */
export function RefreshingContent({
  refreshing,
  children,
  copy,
}: {
  refreshing: boolean;
  children: ReactNode;
  copy?: Copy;
}) {
  const s = pick(copy);
  return (
    <div aria-busy={refreshing}>
      {refreshing && (
        <div className="ehr-progress" role="status">
          <span className="ehr-progress__bar" aria-hidden="true" />
          <span className="ehr-progress__text">{s.updating}</span>
        </div>
      )}
      {children}
    </div>
  );
}

/** Empty states. `filtered` is different text from "nothing exists" and offers Clear filters. */
export function EmptyState({
  message,
  action,
  filtered,
  onClearFilters,
  copy,
}: {
  message: string;
  action?: ReactNode;
  filtered?: boolean;
  onClearFilters?: () => void;
  copy?: Copy;
}) {
  const s = pick(copy);
  return (
    <div className="ehr-state ehr-state--empty">
      <span className="ehr-state__icon">
        <Icon name="calendar" size={28} />
      </span>
      <p className="ehr-state__text">{filtered ? s.emptyFiltered : message}</p>
      {filtered && onClearFilters !== undefined ? (
        <Button onClick={onClearFilters}>{s.clearFilters}</Button>
      ) : (
        action
      )}
    </div>
  );
}

export type ErrorKind = 'forbidden' | 'not-found' | 'server' | 'rate-limited' | 'conflict';

/** Error pages and panels for the catalogue's 403, 404, 5xx, 429 and 412 states (UI-UX 6). Text is generic on
 * purpose: 403 gives no hint of what exists, 404 reads the same for "missing" and "out of scope" (CN-04),
 * and 5xx shows a reference code instead of technical detail (CN-13). */
export function ErrorState({
  kind,
  homeHref,
  helpHref,
  requestId,
  retryAfterSeconds,
  onRetry,
  onReload,
  userText,
  copy,
  headingLevel = 2,
}: {
  kind: ErrorKind;
  homeHref?: string;
  helpHref?: string;
  requestId?: string;
  retryAfterSeconds?: number;
  onRetry?: () => void;
  onReload?: () => void;
  /** Conflict only: the user's own unsaved text, kept in a side panel so nothing is lost. */
  userText?: string;
  copy?: Copy;
  headingLevel?: 1 | 2;
}) {
  const s = pick(copy);
  const H = headingLevel === 1 ? 'h1' : 'h2';
  const [left, setLeft] = useState(retryAfterSeconds ?? 0);
  useEffect(() => {
    if (kind !== 'rate-limited' || left <= 0) return;
    const t = setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [kind, left]);
  const title =
    kind === 'forbidden'
      ? s.forbidden
      : kind === 'not-found'
        ? s.notFound
        : kind === 'server'
          ? s.serverError
          : kind === 'rate-limited'
            ? s.rateLimited(left)
            : s.conflictTitle;
  return (
    <section className={cx('ehr-state', 'ehr-state--error')} aria-labelledby="ehr-error-title">
      <H id="ehr-error-title" className="ehr-state__title">
        {title}
      </H>
      {kind === 'forbidden' && (
        <p>
          {homeHref !== undefined && <a href={homeHref}>{s.forbiddenHome}</a>}
          {helpHref !== undefined && (
            <>
              {' · '}
              <a href={helpHref}>{s.forbiddenHelp}</a>
            </>
          )}
        </p>
      )}
      {kind === 'not-found' && homeHref !== undefined && <a href={homeHref}>{s.forbiddenHome}</a>}
      {kind === 'server' && (
        <>
          {onRetry !== undefined && <Button onClick={onRetry}>{s.retry}</Button>}
          {requestId !== undefined && (
            <p className="ehr-state__ref">
              {s.referenceCode}: <code>{requestId}</code>
            </p>
          )}
        </>
      )}
      {kind === 'rate-limited' && onRetry !== undefined && (
        <Button onClick={onRetry} disabled={left > 0}>
          {s.retry}
        </Button>
      )}
      {kind === 'conflict' && (
        <>
          {onReload !== undefined && (
            <Button variant="primary" onClick={onReload}>
              {s.conflictReload}
            </Button>
          )}
          {userText !== undefined && (
            <aside className="ehr-card" aria-label={s.conflictYourText}>
              <h3 className="ehr-state__sub">{s.conflictYourText}</h3>
              <p className="ehr-preserve">{userText}</p>
            </aside>
          )}
        </>
      )}
    </section>
  );
}

/** "Updated 3 min ago" chip for lists that can be stale (UI-UX 6). */
export function StaleChip({ ago, copy }: { ago: string; copy?: Copy }) {
  const s = pick(copy);
  return (
    <span className="ehr-chip ehr-chip--warning">
      <span aria-hidden="true" className="ehr-chip__icon">
        !
      </span>
      {s.stale(ago)}
    </span>
  );
}

/** Offline banner; the caller disables clinical writes while `offline` and keeps no PHI in browser storage. */
export function OfflineBanner({ copy }: { copy?: Copy }) {
  return (
    <Banner tone="warning" title={undefined}>
      {pick(copy).offline}
    </Banner>
  );
}

export function MaintenanceBanner({ children, copy }: { children: ReactNode; copy?: Copy }) {
  return (
    <Banner tone="warning" title={pick(copy).maintenance}>
      {children}
    </Banner>
  );
}

/** Visible note where a role sees part of a record; hidden data is never drawn as blank fields. */
export function PermissionNote({ scope, copy }: { scope: string; copy?: Copy }) {
  return (
    <p className="ehr-permission-note">
      <span aria-hidden="true">🛈 </span>
      {pick(copy).permissionLimited(scope)}
    </p>
  );
}

export interface PartialItem {
  id: string;
  label: string;
  ok: boolean;
  reason?: string;
}

/** Partial failure: what worked and what did not, per item (BR-33). */
export function PartialFailureList({ items, copy }: { items: PartialItem[]; copy?: Copy }) {
  const s = pick(copy);
  return (
    <Banner tone="warning" title={s.partialFailure}>
      <ul className="ehr-plain-list">
        {items.map((i) => (
          <li key={i.id}>
            <span aria-hidden="true">{i.ok ? '✓ ' : '✕ '}</span>
            {i.label}: {i.ok ? s.worked : `${s.failed}${i.reason ? `. ${i.reason}` : ''}`}
          </li>
        ))}
      </ul>
    </Banner>
  );
}

/** Session ended (401): dialog, draft kept. Sign-in returns to the same route (no PHI in it). */
export function SessionEndedDialog({ onSignIn, copy }: { onSignIn: () => void; copy?: Copy }) {
  const s = pick(copy);
  return (
    <AlertDialog
      title={s.sessionEndedTitle}
      actions={
        <Button variant="primary" onClick={onSignIn}>
          {s.signIn}
        </Button>
      }
    >
      <p>{s.sessionEndedBody}</p>
    </AlertDialog>
  );
}

function fmt(totalSeconds: number) {
  const m = Math.floor(totalSeconds / 60);
  const sec = totalSeconds % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

/** Session warning: takes focus on open and reads out the time once; the visible countdown is not announced
 * every second. It does not trap a screen-reader user (UI-UX 7.1): Escape stays available as "Stay signed in". */
export function SessionWarningDialog({
  secondsLeft,
  onStay,
  onSignOut,
  copy,
}: {
  secondsLeft: number;
  onStay: () => void;
  onSignOut?: () => void;
  copy?: Copy;
}) {
  const s = pick(copy);
  const [announced] = useState(secondsLeft);
  return (
    <AlertDialog
      title={s.sessionWarningTitle}
      actions={
        <>
          <Button variant="primary" onClick={onStay}>
            {s.staySignedIn}
          </Button>
          {onSignOut !== undefined && <Button onClick={onSignOut}>{s.signOutNow}</Button>}
        </>
      }
    >
      <p>{s.sessionWarningBody(fmt(announced))}</p>
      <p aria-hidden="true" className="ehr-countdown">
        {fmt(secondsLeft)}
      </p>
    </AlertDialog>
  );
}
