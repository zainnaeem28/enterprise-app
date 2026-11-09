import { useSyncExternalStore } from 'react';
import { StatusChip } from '@ehr/ui';
import type { ElevationStore } from './elevation.js';
import { adminAuthStrings as s } from './strings.js';

const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

/** "Elevated until 10:42" while the grant is valid, nothing after it (UI-UX 3.1). The words carry the meaning; colour does not. */
export function ElevationChip({
  store,
  format = (ms) => clock.format(ms),
}: {
  store: ElevationStore;
  format?: (epochMs: number) => string;
}) {
  const until = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  if (until === undefined) return null;
  return (
    <span role="status">
      <StatusChip tone="info">{s.elevatedUntil(format(until))}</StatusChip>
    </span>
  );
}
