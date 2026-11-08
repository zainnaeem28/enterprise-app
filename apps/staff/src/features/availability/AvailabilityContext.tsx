import { createContext, useContext } from 'react';
import type { AvailabilityApi } from './api.js';

export interface AvailabilityContextValue {
  api: AvailabilityApi;
  can: (permission: string) => boolean;
  principalId: string;
  online: boolean;
  /** Sends the browser to Google's consent page. A seam for tests; the default is a top-level navigation. */
  go: (url: string) => void;
}

export const AvailabilityContext = createContext<AvailabilityContextValue | null>(null);
export function useAvailability(): AvailabilityContextValue {
  const v = useContext(AvailabilityContext);
  if (v === null) throw new Error('AvailabilityContext missing');
  return v;
}
