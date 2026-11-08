import { createContext, useContext } from 'react';
import type { PatientRuntime } from '../../app/runtime.js';
import type { PrevisitApi } from './api.js';
import type { Previsit } from './types.js';

export interface PrevisitContextValue {
  runtime: PatientRuntime;
  api: PrevisitApi;
  go: (to: string) => void;
  reservationId: string;
  /** The person the visit is for (whose record the forms belong to). */
  patientId: string;
  previsit: Previsit;
  reload: () => void;
  /** Advice text from the last submit, kept in memory only (never storage, never the URL). */
  advice: string | undefined;
  setAdvice: (text: string | undefined) => void;
}

export const PrevisitContext = createContext<PrevisitContextValue | undefined>(undefined);

export function usePrevisit(): PrevisitContextValue {
  const v = useContext(PrevisitContext);
  if (v === undefined) throw new Error('usePrevisit outside PrevisitRoutes');
  return v;
}
