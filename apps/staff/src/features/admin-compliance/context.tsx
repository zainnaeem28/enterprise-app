import { createContext, useContext } from 'react';
import type { ComplianceApi } from './api.js';

export const ComplianceContext = createContext<{ api: ComplianceApi } | undefined>(undefined);
export function useCompliance() {
  const v = useContext(ComplianceContext);
  if (v === undefined) throw new Error('admin compliance screens need a ComplianceContext');
  return v;
}

/** A list read: loading → ok | failed, keeping the old rows while a refresh runs (UI-UX 6). */
export const fmtTime = (iso: string | null): string => {
  if (iso === null) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
