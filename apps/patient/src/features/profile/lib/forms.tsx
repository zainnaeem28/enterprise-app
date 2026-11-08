import { useState } from 'react';
import { Banner, Button } from '@ehr/ui';
import type { Failure } from './core.js';

/** Inline errors per field plus the summary entries, from one set of messages keyed by field id. */
export function summaryOf(errors: Record<string, string>) {
  return Object.entries(errors).map(([fieldId, message]) => ({ fieldId, message }));
}

/** The 412 state (UI-UX 6): say what happened, keep what the patient typed in a side panel, offer the reload. */
export function ConflictPanel({
  mine,
  onReload,
}: {
  mine: { label: string; value: string }[];
  onReload: () => void;
}) {
  return (
    <Banner
      tone="warning"
      title="Someone changed this while you were editing."
      actions={<Button onClick={onReload}>Reload and review changes</Button>}
    >
      <p>Your changes were not saved. What you typed is kept here so nothing is lost.</p>
      <ul aria-label="What you typed">
        {mine.map((m) => (
          <li key={m.label}>
            {m.label}: {m.value === '' ? '(empty)' : m.value}
          </li>
        ))}
      </ul>
    </Banner>
  );
}

/** One-shot guard against a double submit: the second call while the first is in flight does nothing. */
export function useSubmit() {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => {
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

/** Plain-language lines for the refusals a patient can act on. */
export const failureText = (f: Failure): string | undefined =>
  f.code === 'patient.channel_unavailable'
    ? 'One of the ways you chose needs a phone number or email address that is not on your details yet. Add it under Your details first.'
    : f.code === 'patient.merged'
      ? 'This record has been combined with another. Please sign in again.'
      : undefined;
