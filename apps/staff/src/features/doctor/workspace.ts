import { useSyncExternalStore } from 'react';
import type { Note, Addendum, Visit } from './types.js';

/**
 * What the doctor is working on, in memory only: paths carry no record identifier (UI-UX 3.2) and nothing is written to browser
 * storage (no PHI after sign-out), so a reload starts clean.
 */
export interface Open {
  patientId: string;
  /** Shown while the chart loads; the chart's own banner replaces it. */
  label: string;
  visit?: Visit;
}

let current: Open | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const workspace = {
  get: (): Open | null => current,
  set(o: Open | null) {
    current = o;
    emit();
  },
  subscribe,
};
export const useOpen = (): Open | null =>
  useSyncExternalStore(subscribe, workspace.get, workspace.get);

/** A note this session has seen, with what the lists need to show without another call. */
export interface KnownNote {
  note: Note;
  patientName: string;
  dateOfBirth: string;
  addenda: Addendum[];
}
let notes: readonly KnownNote[] = [];
const noteListeners = new Set<() => void>();
export const noteStore = {
  get: (): readonly KnownNote[] => notes,
  put(k: Omit<KnownNote, 'addenda'> & { addenda?: Addendum[] }) {
    const prev = notes.find((n) => n.note.id === k.note.id);
    const next: KnownNote = { ...k, addenda: k.addenda ?? prev?.addenda ?? [] };
    notes = prev === undefined ? [...notes, next] : notes.map((n) => (n === prev ? next : n));
    noteListeners.forEach((l) => l());
  },
  addAddendum(noteId: string, a: Addendum) {
    notes = notes.map((n) => (n.note.id === noteId ? { ...n, addenda: [...n.addenda, a] } : n));
    noteListeners.forEach((l) => l());
  },
  clear() {
    notes = [];
    noteListeners.forEach((l) => l());
  },
  subscribe(l: () => void) {
    noteListeners.add(l);
    return () => noteListeners.delete(l);
  },
};
export const useKnownNotes = (): readonly KnownNote[] =>
  useSyncExternalStore(noteStore.subscribe, noteStore.get, noteStore.get);
