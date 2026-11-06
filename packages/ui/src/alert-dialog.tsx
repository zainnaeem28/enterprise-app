import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';

export interface AlertDialogProps {
  title: string;
  children: ReactNode;
  actions: ReactNode;
  /** Selector of the control that receives focus on open; defaults to the first button. */
  initialFocus?: string;
}

/** `role="alertdialog"`: takes focus on open, traps Tab inside, no timer, no auto-dismiss. */
export function AlertDialog({ title, children, actions, initialFocus }: AlertDialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    const root = ref.current;
    if (root === null) return;
    const previous = document.activeElement as HTMLElement | null;
    const target =
      (initialFocus ? root.querySelector<HTMLElement>(initialFocus) : null) ??
      root.querySelector<HTMLElement>('button');
    target?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = [
        ...root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href]',
        ),
      ];
      const first = items[0];
      const last = items[items.length - 1];
      if (first === undefined || last === undefined) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    // Pointer focus loss (backdrop click) or focus moving behind the dialog: bring it back.
    let last: HTMLElement | null = target;
    const onFocusIn = (e: FocusEvent) => {
      if (root.contains(e.target as Node)) last = e.target as HTMLElement;
      else (last ?? root.querySelector<HTMLElement>('button'))?.focus();
    };
    const onFocusOut = (e: FocusEvent) => {
      const next = e.relatedTarget as Node | null;
      if (next === null || !root.contains(next)) {
        queueMicrotask(() => {
          if (!root.contains(document.activeElement)) last?.focus();
        });
      }
    };
    root.addEventListener('keydown', onKey);
    root.addEventListener('focusout', onFocusOut);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      root.removeEventListener('keydown', onKey);
      root.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('focusin', onFocusIn);
      previous?.focus?.();
    };
  }, [initialFocus]);

  return (
    <div className="ehr-dialog-backdrop">
      <div
        ref={ref}
        className="ehr-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
      >
        <h2 id={titleId} className="ehr-dialog__title">
          {title}
        </h2>
        <div id={bodyId}>{children}</div>
        <div className="ehr-dialog__actions">{actions}</div>
      </div>
    </div>
  );
}
