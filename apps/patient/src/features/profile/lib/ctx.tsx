import { createContext, useContext } from 'react';
import type { ProfileApi } from '../api.js';
import type { Person } from './hooks.js';

export interface AccountContextValue {
  api: ProfileApi;
  go: (to: string) => void;
  people: Person[];
  /** The signed-in person's own record. Profile edits, notification preferences and proxies are always about this one. */
  selfId: string | undefined;
  /** Who the portal is acting for right now (PP-09); defaults to the person themselves. */
  activeId: string | undefined;
  setActiveId: (id: string) => void;
}

export const AccountContext = createContext<AccountContextValue | undefined>(undefined);

export function useAccountCtx(): AccountContextValue {
  const v = useContext(AccountContext);
  if (v === undefined) throw new Error('useAccountCtx outside ProfileRoutes');
  return v;
}
