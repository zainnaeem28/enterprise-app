import { useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { pick } from './strings.js';
import type { Copy } from './strings.js';
import { cx } from './cx.js';

export interface Slot {
  id: string;
  label: string;
  available: boolean;
}

/** Slot grid: one toggle button per time, arrow keys move within the grid, selected state is `aria-pressed`
 * plus a visible check. Unavailable times are omitted ("Showing available times only"), not greyed. */
export function SlotGrid({
  slots,
  selectedId,
  onSelect,
  label,
  copy,
}: {
  slots: Slot[];
  selectedId?: string;
  onSelect: (id: string) => void;
  label: string;
  copy?: Copy;
}) {
  const s = pick(copy);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const shown = slots.filter((x) => x.available);
  if (shown.length === 0) {
    return (
      <p className="ehr-slots__none">
        {s.noSlots}. {s.slotsTryAnother}
      </p>
    );
  }
  const onKey = (e: KeyboardEvent, i: number) => {
    const d =
      e.key === 'ArrowDown' || e.key === 'ArrowRight'
        ? 1
        : e.key === 'ArrowUp' || e.key === 'ArrowLeft'
          ? -1
          : 0;
    if (d === 0) return;
    e.preventDefault();
    refs.current[Math.min(shown.length - 1, Math.max(0, i + d))]?.focus();
  };
  return (
    <div role="group" aria-label={label} className="ehr-slots">
      {shown.map((x, i) => (
        <button
          key={x.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          className={cx('ehr-slot', x.id === selectedId && 'ehr-slot--selected')}
          aria-pressed={x.id === selectedId}
          onClick={() => onSelect(x.id)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {x.id === selectedId && <span aria-hidden="true">✓ </span>}
          {x.label}
        </button>
      ))}
    </div>
  );
}

export interface DayColumn {
  id: string;
  heading: string;
  slots: Slot[];
}

/** Calendar week: a column of slots per day; days with no times say so in text. */
export function CalendarWeek({
  days,
  selectedId,
  onSelect,
  onPrev,
  onNext,
  weekLabel,
  copy,
}: {
  days: DayColumn[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onPrev: () => void;
  onNext: () => void;
  weekLabel: string;
  copy?: Copy;
}) {
  const s = pick(copy);
  return (
    <section aria-label={weekLabel} className="ehr-week">
      <div className="ehr-week__nav">
        <h3 className="ehr-week__title">{weekLabel}</h3>
        <button type="button" className="ehr-btn" onClick={onPrev}>
          Previous week
        </button>
        <button type="button" className="ehr-btn" onClick={onNext}>
          Next week
        </button>
      </div>
      <div className="ehr-week__days">
        {days.map((d) => (
          <div key={d.id} className="ehr-week__day">
            <h4 className="ehr-week__head">{d.heading}</h4>
            {d.slots.some((x) => x.available) ? (
              <SlotGrid
                slots={d.slots}
                selectedId={selectedId}
                onSelect={onSelect}
                label={d.heading}
                copy={copy}
              />
            ) : (
              <p className="ehr-muted">
                {s.noSlots}. {s.slotsTryAnother}
              </p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

export interface ScheduleEvent {
  id: string;
  start: string;
  end: string;
  title: string;
  status?: ReactNode;
}

/** Schedule day/week for staff: an ordered list of events with start and end times in text. */
export function ScheduleDay({
  heading,
  events,
  onOpen,
}: {
  heading: string;
  events: ScheduleEvent[];
  onOpen?: (id: string) => void;
}) {
  return (
    <section aria-label={heading} className="ehr-schedule">
      <h3 className="ehr-week__head">{heading}</h3>
      {events.length === 0 ? (
        <p className="ehr-muted">No appointments.</p>
      ) : (
        <ol className="ehr-plain-list">
          {events.map((e) => (
            <li key={e.id} className="ehr-schedule__event">
              <time>
                {e.start} to {e.end}
              </time>
              {onOpen !== undefined ? (
                <button type="button" className="ehr-link-btn" onClick={() => onOpen(e.id)}>
                  {e.title}
                </button>
              ) : (
                <span>{e.title}</span>
              )}
              {e.status}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
