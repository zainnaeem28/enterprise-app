import { preStrings as p } from './strings.js';
import type { QueueStage, TriageCategory } from './types.js';

export const timeOf = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

/** "12 min", "1 h 05 min": whole minutes, never seconds on a list people scan (TC-PC-05 shows minutes). */
export function waitText(seconds: number): string {
  const m = Math.max(0, Math.floor(seconds / 60));
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

export const nameOf = (n: string | null): string => n ?? p.unnamed;

export const stageLabel: Record<QueueStage, string> = {
  waiting: p.stageWaiting,
  vitals: p.stageVitals,
  triage: p.stageTriage,
  ready: p.stageReady,
  with_clinician: p.stageWithClinician,
  done: p.stageDone,
};

export const categoryLabel: Record<TriageCategory, string> = {
  emergency: p.categoryEmergency,
  urgent: p.categoryUrgent,
  standard: p.categoryStandard,
  non_urgent: p.categoryNonUrgent,
};

/** Age in whole years from a `YYYY-MM-DD` date of birth. */
export function ageOf(dob: string, now = new Date()): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dob);
  if (m === null) return '';
  let age = now.getFullYear() - Number(m[1]);
  const before =
    now.getMonth() + 1 < Number(m[2]) ||
    (now.getMonth() + 1 === Number(m[2]) && now.getDate() < Number(m[3]));
  if (before) age -= 1;
  return `${age} y`;
}
