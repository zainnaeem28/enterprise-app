import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import type { PreconsultApi } from './api.js';
import type { Arrival } from './types.js';

export interface DeskContextValue {
  api: PreconsultApi;
  locationId: string;
  navigate: (path: string) => void;
  /** Switch to another tab of the current screen (no record identifier in the address). */
  showTab: (id: string) => void;
  can: (permission: string) => boolean;
  /** False while the browser reports no network: clinical writes (vitals, triage) are disabled meanwhile (UI-UX 6, offline). */
  online: boolean;
  /** Opens a chart by patient ID. Supplied by the host app (the chart is another surface); absent: the merged-record notice stays neutral. */
  openChart?: (patientId: string) => void;
}

export const DeskContext = createContext<DeskContextValue | null>(null);

export function useDesk(): DeskContextValue {
  const v = useContext(DeskContext);
  if (v === null) throw new Error('DeskContext missing');
  return v;
}

/**
 * The visit the desk is working on, kept in memory only so it survives a move between the arrivals, forms and triage screens.
 * Paths carry no record identifier (UI-UX 3.2) and nothing is written to browser storage (no PHI after sign-out), so a reload
 * starts clean.
 */
let selected: Arrival | null = null;
const listeners = new Set<() => void>();
export const selection = {
  get: (): Arrival | null => selected,
  set(a: Arrival | null) {
    selected = a;
    listeners.forEach((l) => l());
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};
export const useSelectedVisit = (): Arrival | null =>
  useSyncExternalStore(selection.subscribe, selection.get, selection.get);

export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return online;
}
