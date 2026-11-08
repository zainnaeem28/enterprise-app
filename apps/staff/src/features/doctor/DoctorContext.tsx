import { createContext, useContext, useEffect, useState } from 'react';
import type { DoctorApi } from './api.js';
import type { VideoAdapter } from './video.js';

export interface DoctorContextValue {
  api: DoctorApi;
  can: (permission: string) => boolean;
  principalId: string;
  roleKeys: readonly string[];
  online: boolean;
  navigate: (path: string) => void;
  /** Opens the second sign-in the server asks for (`401 auth.reauth_required`) without leaving the page, so the draft stays. */
  openReauth: () => void;
  video?: VideoAdapter;
}

export const DoctorContext = createContext<DoctorContextValue | null>(null);
export function useDoctor(): DoctorContextValue {
  const v = useContext(DoctorContext);
  if (v === null) throw new Error('DoctorContext missing');
  return v;
}

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
