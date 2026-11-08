import { createContext, useContext } from 'react';
import type { MessagesApi } from './api.js';

export interface MessagesContextValue {
  api: MessagesApi;
  can: (permission: string) => boolean;
  principalId: string;
  locationIds: readonly string[];
  online: boolean;
}
export const MessagesContext = createContext<MessagesContextValue | null>(null);
export function useMessages(): MessagesContextValue {
  const v = useContext(MessagesContext);
  if (v === null) throw new Error('MessagesContext missing');
  return v;
}
