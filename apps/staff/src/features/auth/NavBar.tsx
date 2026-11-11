import { BrandMark, Icon } from '@ehr/ui';
import type { MouseEvent } from 'react';
import { PHONE_VISIBLE } from './navigation.js';
import type { NavItem } from './navigation.js';
import { authStrings as s } from './strings.js';
import './auth.css';

function Link({
  item,
  current,
  onNavigate,
}: {
  item: NavItem;
  current: string;
  onNavigate: (path: string) => void;
}) {
  const go = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    onNavigate(item.path);
  };
  return (
    <a
      className="ehr-nav__link"
      href={item.path}
      onClick={go}
      {...(current === item.path ? { 'aria-current': 'page' as const } : {})}
    >
      <Icon
        name={
          (
            {
              alerts: 'bell',
              schedule: 'calendar',
              patients: 'people',
              tasks: 'message',
              notes: 'notes',
              availability: 'clock',
              arrivals: 'people',
              triage: 'heart',
              forms: 'notes',
              'follow-ups': 'calendar',
              waitlist: 'clock',
              compliance: 'shield',
              configuration: 'settings',
            } as Record<string, string>
          )[item.id] ?? 'notes'
        }
      />
      {item.label}
    </a>
  );
}

/**
 * Primary navigation. Wide screens: one row of links. Phone: the first three links and a "More" disclosure
 * (UI-UX 3.2), as a bar at the bottom of the screen. Both are real lists in one landmark; CSS shows one of them.
 */
export function NavBar({
  items,
  current,
  onNavigate,
}: {
  items: readonly NavItem[];
  current: string;
  onNavigate: (path: string) => void;
}) {
  if (items.length === 0) return null;
  const head = items.slice(0, PHONE_VISIBLE);
  const rest = items.slice(PHONE_VISIBLE);
  return (
    <nav aria-label={s.primaryNav} className="ehr-nav">
      <div className="ehr-nav__brand">
        <BrandMark />
        <div>
          <strong>Clinic</strong>
          <small>Care workspace</small>
        </div>
      </div>
      <p className="ehr-nav__section">Your workspace</p>
      <ul className="ehr-nav__list ehr-nav__list--wide">
        {items.map((i) => (
          <li key={i.id}>
            <Link item={i} current={current} onNavigate={onNavigate} />
          </li>
        ))}
      </ul>
      <ul className="ehr-nav__list ehr-nav__list--phone">
        {head.map((i) => (
          <li key={i.id}>
            <Link item={i} current={current} onNavigate={onNavigate} />
          </li>
        ))}
        {rest.length > 0 && (
          <li>
            <details className="ehr-nav__more">
              <summary>{s.more}</summary>
              <ul aria-label={s.moreNav}>
                {rest.map((i) => (
                  <li key={i.id}>
                    <Link item={i} current={current} onNavigate={onNavigate} />
                  </li>
                ))}
              </ul>
            </details>
          </li>
        )}
      </ul>
      <div className="ehr-nav__footer">
        <a href="/help">
          <Icon name="help" /> Help & support
        </a>
        <p>Thoughtful care. Every day.</p>
      </div>
    </nav>
  );
}
