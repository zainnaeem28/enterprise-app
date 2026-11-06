import { useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { Button } from './button.js';
import { EmptyState } from './states.js';
import { StatusChip } from './primitives.js';
import type { Tone } from './primitives.js';
import { pick } from './strings.js';
import type { Copy } from './strings.js';
import { cx } from './cx.js';

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
}

/** Data table with sticky header. Rows open on Enter (UX-R6); J/K and arrows move between rows as an extra, not
 * the only way. Whole table scrolls in a labelled, focusable region so 400 % zoom loses nothing (1.4.10). */
export function DataTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  onOpen,
  emptyMessage,
  selectedKey,
  copy,
}: {
  caption: string;
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onOpen?: (row: T) => void;
  emptyMessage?: string;
  selectedKey?: string;
  copy?: Copy;
}) {
  const refs = useRef<Array<HTMLTableRowElement | null>>([]);
  if (rows.length === 0)
    return <EmptyState message={emptyMessage ?? pick(copy).nothingToShow} copy={copy} />;
  const move = (i: number, d: number) =>
    refs.current[Math.min(rows.length - 1, Math.max(0, i + d))]?.focus();
  const onKey = (e: KeyboardEvent, i: number, row: T) => {
    if (e.key === 'Enter' && onOpen !== undefined && e.target === e.currentTarget) {
      e.preventDefault();
      onOpen(row);
    } else if ((e.key === 'ArrowDown' || e.key === 'j') && e.target === e.currentTarget) {
      e.preventDefault();
      move(i, 1);
    } else if ((e.key === 'ArrowUp' || e.key === 'k') && e.target === e.currentTarget) {
      e.preventDefault();
      move(i, -1);
    }
  };
  return (
    <div className="ehr-table-wrap" role="region" aria-label={caption} tabIndex={0}>
      <table className="ehr-table">
        <caption className="ehr-visually-hidden">{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col">
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const key = rowKey(row);
            return (
              <tr
                key={key}
                ref={(el) => {
                  refs.current[i] = el;
                }}
                tabIndex={onOpen !== undefined ? 0 : undefined}
                className={cx(key === selectedKey && 'ehr-row--selected')}
                aria-selected={selectedKey !== undefined ? key === selectedKey : undefined}
                onKeyDown={(e) => onKey(e, i, row)}
                onDoubleClick={onOpen !== undefined ? () => onOpen(row) : undefined}
              >
                {columns.map((c) => (
                  <td key={c.key}>{c.render(row)}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Card list: the narrow-screen form of the same rows. Each card is a list item with its own action. */
export function CardList<T>({
  label,
  rows,
  rowKey,
  title,
  meta,
  action,
  emptyMessage,
  copy,
}: {
  label: string;
  rows: T[];
  rowKey: (row: T) => string;
  title: (row: T) => ReactNode;
  meta?: (row: T) => ReactNode;
  action?: (row: T) => ReactNode;
  emptyMessage?: string;
  copy?: Copy;
}) {
  if (rows.length === 0)
    return <EmptyState message={emptyMessage ?? pick(copy).nothingToShow} copy={copy} />;
  return (
    <ul className="ehr-cardlist" aria-label={label}>
      {rows.map((r) => (
        <li key={rowKey(r)} className="ehr-card">
          <div className="ehr-cardlist__title">{title(r)}</div>
          {meta !== undefined && <div className="ehr-cardlist__meta">{meta(r)}</div>}
          {action !== undefined && <div>{action(r)}</div>}
        </li>
      ))}
    </ul>
  );
}

/** Filter bar: a labelled search landmark; Apply and Clear are real buttons. */
export function FilterBar({
  label,
  children,
  onApply,
  onClear,
  copy,
}: {
  label: string;
  children: ReactNode;
  onApply: () => void;
  onClear?: () => void;
  copy?: Copy;
}) {
  const s = pick(copy);
  return (
    <form
      role="search"
      aria-label={label}
      className="ehr-filterbar"
      onSubmit={(e) => {
        e.preventDefault();
        onApply();
      }}
    >
      {children}
      <Button type="submit" variant="primary">
        Apply filters
      </Button>
      {onClear !== undefined && <Button onClick={onClear}>{s.clearFilters}</Button>}
    </form>
  );
}

export interface TimelineEntry {
  id: string;
  time: string;
  label: string;
  tone?: Tone;
  detail?: string;
  current?: boolean;
}

/** Timeline: only moves forward (BR-24); a late event is kept in history but the caller marks `current`. */
export function Timeline({ entries, label }: { entries: TimelineEntry[]; label: string }) {
  return (
    <ol className="ehr-timeline" aria-label={label}>
      {entries.map((e) => (
        <li key={e.id} className="ehr-timeline__item" aria-current={e.current ? 'step' : undefined}>
          <time>{e.time}</time>
          <StatusChip tone={e.tone ?? 'neutral'}>{e.label}</StatusChip>
          {e.current && <span className="ehr-visually-hidden"> (current)</span>}
          {e.detail !== undefined && <p className="ehr-timeline__detail">{e.detail}</p>}
        </li>
      ))}
    </ol>
  );
}

export type ScanState = 'scanning' | 'clean' | 'blocked' | 'failed';

export interface UploadItem {
  id: string;
  name: string;
  scan: ScanState;
}

/** Upload with scan states: every file shows a text status; blocked files cannot be opened. */
export function UploadList({
  items,
  onPick,
  onRemove,
  copy,
}: {
  items: UploadItem[];
  onPick: (files: FileList) => void;
  onRemove?: (id: string) => void;
  copy?: Copy;
}) {
  const s = pick(copy);
  const id = useId();
  const tone: Record<ScanState, Tone> = {
    scanning: 'info',
    clean: 'success',
    blocked: 'danger',
    failed: 'danger',
  };
  const text: Record<ScanState, string> = {
    scanning: s.uploadScanning,
    clean: s.uploadClean,
    blocked: s.uploadBlocked,
    failed: s.uploadFailed,
  };
  return (
    <div className="ehr-upload">
      <label htmlFor={id} className="ehr-field__label">
        Choose files
      </label>
      <input
        id={id}
        type="file"
        multiple
        className="ehr-input"
        onChange={(e) => e.target.files && onPick(e.target.files)}
      />
      <ul className="ehr-plain-list" aria-label="Uploaded files">
        {items.map((i) => (
          <li key={i.id} className="ehr-upload__row">
            <span>{i.name}</span>
            <StatusChip tone={tone[i.scan]}>{text[i.scan]}</StatusChip>
            {onRemove !== undefined && (
              <Button onClick={() => onRemove(i.id)} aria-label={`Remove ${i.name}`}>
                Remove
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface DocumentItem {
  id: string;
  name: string;
  meta?: string;
  href?: string;
  textAvailable: boolean;
}

/** Document list: offers download and states plainly when text is not available (PDFs are not guaranteed accessible). */
export function DocumentList({ documents, copy }: { documents: DocumentItem[]; copy?: Copy }) {
  const s = pick(copy);
  if (documents.length === 0) return <EmptyState message={s.noDocuments} copy={copy} />;
  return (
    <ul className="ehr-plain-list" aria-label="Documents">
      {documents.map((d) => (
        <li key={d.id} className="ehr-card">
          <strong>{d.name}</strong>{' '}
          {d.meta !== undefined && <span className="ehr-muted">{d.meta}</span>}
          {!d.textAvailable && <p className="ehr-muted">{s.textNotAvailable}</p>}
          {d.href !== undefined && (
            <a href={d.href} download>
              {s.download}
              <span className="ehr-visually-hidden"> {d.name}</span>
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}

export interface Message {
  id: string;
  from: string;
  at: string;
  body: string;
  mine?: boolean;
}

/** Message thread: a log region; the author and time are text, not position or colour alone. */
export function MessageThread({ messages, label }: { messages: Message[]; label: string }) {
  return (
    <ol className="ehr-thread" aria-label={label}>
      {messages.map((m) => (
        <li key={m.id} className={cx('ehr-message', m.mine && 'ehr-message--mine')}>
          <p className="ehr-message__head">
            <strong>{m.from}</strong> <time>{m.at}</time>
          </p>
          <p className="ehr-message__body">{m.body}</p>
        </li>
      ))}
    </ol>
  );
}

export interface AuditRow {
  id: string;
  time: string;
  who: string;
  action: string;
  record: string;
  outcome: 'allowed' | 'denied' | 'reason-given' | 'awaiting-approval';
}

const OUTCOME: Record<AuditRow['outcome'], { tone: Tone; text: string }> = {
  allowed: { tone: 'success', text: 'Allowed' },
  denied: { tone: 'danger', text: 'Denied' },
  'reason-given': { tone: 'warning', text: 'Reason given' },
  'awaiting-approval': { tone: 'warning', text: 'Awaiting approval' },
};

/** Audit table: read-only, record shown by a truncated random id only (never contents, UX-R4). */
export function AuditTable({
  rows,
  onOpen,
  copy,
}: {
  rows: AuditRow[];
  onOpen?: (row: AuditRow) => void;
  copy?: Copy;
}) {
  return (
    <DataTable
      caption="Audit log"
      rows={rows}
      rowKey={(r) => r.id}
      onOpen={onOpen}
      emptyMessage={pick(copy).noAuditEntries}
      copy={copy}
      columns={[
        { key: 'time', header: 'Time', render: (r) => r.time },
        { key: 'who', header: 'Who', render: (r) => r.who },
        { key: 'action', header: 'Action', render: (r) => r.action },
        { key: 'record', header: 'Record', render: (r) => r.record },
        {
          key: 'outcome',
          header: 'Outcome',
          render: (r) => (
            <StatusChip tone={OUTCOME[r.outcome].tone}>{OUTCOME[r.outcome].text}</StatusChip>
          ),
        },
      ]}
    />
  );
}

/** Controlled disclosure used by panels that expand on tap (phone patient banner). */
export function useToggle(initial = false) {
  const [on, setOn] = useState(initial);
  return [on, () => setOn((v) => !v)] as const;
}
