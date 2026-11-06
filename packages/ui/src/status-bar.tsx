import type { ReactNode } from 'react';

export interface StatusBarProps {
  /** `info` is announced politely (role=status); `danger` is announced assertively (role=alert). */
  tone: 'info' | 'danger';
  children: ReactNode;
  actions?: ReactNode;
}

/** Slim bar under the app bar (UI-UX 7.7). Not a modal, no motion, does not move focus. */
export function StatusBar({ tone, children, actions }: StatusBarProps) {
  return (
    <div className={`ehr-bar ehr-bar--${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <p className="ehr-bar__text">{children}</p>
      {actions}
    </div>
  );
}
