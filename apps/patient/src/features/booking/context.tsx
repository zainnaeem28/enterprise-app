import { createContext, useContext, useEffect, useRef } from 'react';
import type { BookingApi } from './api.js';
import type { Appointment, Hold, PatientRef, Place, Service, Slot, VisitMode } from './types.js';

/** What the patient has chosen so far. Held in memory only: nothing about a booking goes to storage or the URL (UX-R4). */
export interface Draft {
  serviceId: string | undefined;
  locationId: string | undefined;
  /** `undefined` = any available doctor. */
  clinicianId: string | undefined;
  mode: VisitMode;
  /** Two-letter state the patient will be in, required for a video visit (TL-1). */
  patientState: string;
}

export const emptyDraft: Draft = {
  serviceId: undefined,
  locationId: undefined,
  clinicianId: undefined,
  mode: 'in_person',
  patientState: '',
};

/** A held time, with the keys of its two steps so a retry of either step is the same request (CN-06). */
export interface Pending {
  slot: Slot;
  hold: Hold;
  confirmKey: string;
  /** Set when the hold replaces an existing appointment (PP-16). */
  rescheduleOf?: { id: string; version: number };
}

export interface Booked {
  appointment: Appointment;
  kind: 'booked' | 'changed';
}

export interface CancellationPolicy {
  /** Hours before the start after which the patient cannot change online. Unknown until the API exposes it (README, open item 2). */
  cutoffHours?: number;
}

export interface BookingContextValue {
  api: BookingApi;
  go: (to: string) => void;
  patients: PatientRef[];
  patientId: string;
  setPatientId: (id: string) => void;
  draft: Draft;
  setDraft: (next: Draft | ((d: Draft) => Draft)) => void;
  pending: Pending | undefined;
  setPending: (p: Pending | undefined) => void;
  booked: Booked | undefined;
  setBooked: (b: Booked | undefined) => void;
  services: Service[];
  places: Place[];
  policy: CancellationPolicy;
  /** Start a new booking from the first step with nothing chosen. */
  reset: () => void;
}

export const BookingContext = createContext<BookingContextValue | undefined>(undefined);

export function useBooking(): BookingContextValue {
  const v = useContext(BookingContext);
  if (v === undefined) throw new Error('useBooking outside BookingRoutes');
  return v;
}

/** Browser tab title is the portal and the screen type, never a patient or appointment detail (UX-R4). */
export function usePageTitle(screen: string): void {
  useEffect(() => {
    document.title = `Patient portal - ${screen}`;
  }, [screen]);
}

/** Moves focus to the screen's heading when the screen changes, so keyboard and screen reader users land at the top. */
export function useHeadingFocus<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return ref;
}
