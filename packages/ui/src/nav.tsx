import { useId, useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { cx } from './cx.js';

/** App bar: portal accent plus the portal name written out, so colour is never the only cue (UX-R2).
 * Set `data-portal` on the root element to change the accent. */
export function AppBar({
  portalName,
  productName,
  user,
  help,
  realmBanner,
  children,
}: {
  portalName: string;
  productName: string;
  user?: ReactNode;
  help?: ReactNode;
  /** Realm banner text, e.g. the admin sign-in realm notice. */
  realmBanner?: string;
  children?: ReactNode;
}) {
  return (
    <header className="ehr-appbar-wrap">
      <div className="ehr-appbar">
        <div>
          <p className="ehr-appbar__name">{productName}</p>
          <p className="ehr-appbar__portal">{portalName}</p>
        </div>
        <div className="ehr-appbar__spacer">{children}</div>
        {help}
        {user}
      </div>
      {realmBanner !== undefined && <p className="ehr-realm-banner">{realmBanner}</p>}
    </header>
  );
}

export interface TabItem {
  id: string;
  label: string;
  panel: ReactNode;
  count?: number;
}

/** Tabs per the ARIA authoring practices: roving tabindex, arrows/Home/End move and activate. */
export function Tabs({
  items,
  selected,
  onSelect,
  label,
}: {
  items: TabItem[];
  selected: string;
  onSelect: (id: string) => void;
  label: string;
}) {
  const base = useId();
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const onKey = (e: KeyboardEvent, index: number) => {
    let next: number;
    if (e.key === 'ArrowRight') next = (index + 1) % items.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else return;
    e.preventDefault();
    const target = items[next];
    if (target === undefined) return;
    onSelect(target.id);
    refs.current[target.id]?.focus();
  };
  return (
    <div className="ehr-tabs">
      <div role="tablist" aria-label={label} className="ehr-tabs__list">
        {items.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[t.id] = el;
            }}
            role="tab"
            type="button"
            id={`${base}-tab-${t.id}`}
            aria-selected={t.id === selected}
            aria-controls={`${base}-panel-${t.id}`}
            tabIndex={t.id === selected ? 0 : -1}
            className={cx('ehr-tab', t.id === selected && 'ehr-tab--active')}
            onClick={() => onSelect(t.id)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {t.label}
            {t.count !== undefined && ` (${t.count})`}
          </button>
        ))}
      </div>
      {items.map((t) => (
        <div
          key={t.id}
          role="tabpanel"
          id={`${base}-panel-${t.id}`}
          aria-labelledby={`${base}-tab-${t.id}`}
          hidden={t.id !== selected}
          tabIndex={0}
          className="ehr-tabs__panel"
        >
          {t.id === selected && t.panel}
        </div>
      ))}
    </div>
  );
}

export interface StepItem {
  id: string;
  label: string;
}

/** Stepper: ordered list; completed and current steps carry text, not just colour. */
export function Stepper({ steps, currentId }: { steps: StepItem[]; currentId: string }) {
  const at = steps.findIndex((s) => s.id === currentId);
  return (
    <nav aria-label="Progress">
      <ol className="ehr-stepper">
        {steps.map((s, i) => {
          const state = i < at ? 'done' : i === at ? 'current' : 'todo';
          return (
            <li
              key={s.id}
              className={`ehr-step ehr-step--${state}`}
              aria-current={state === 'current' ? 'step' : undefined}
            >
              <span aria-hidden="true" className="ehr-step__mark">
                {state === 'done' ? '✓' : i + 1}
              </span>
              {s.label}
              {state === 'done' && <span className="ehr-visually-hidden"> (completed)</span>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
