// Cookie consent (F-BS-07, RA-R1-26). The only cookie the site sets is this first-party choice, and it is essential.
// "Essential only" and "Accept all" carry equal weight (UI-UX desktop 1). Nothing non-essential runs before "all".
import { sanitise } from './analytics.js';
import type { Template } from './analytics.js';

export type Choice = 'essential' | 'all';
export const COOKIE_NAME = 'site_consent';
const MAX_AGE_S = 180 * 24 * 3600;

export function readChoice(cookieHeader: string): Choice | null {
  for (const part of cookieHeader.split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === COOKIE_NAME && (v === 'essential' || v === 'all')) return v;
  }
  return null;
}

export const serialiseChoice = (c: Choice, secure: boolean): string =>
  `${COOKIE_NAME}=${c}; Max-Age=${MAX_AGE_S}; Path=/; SameSite=Lax${secure ? '; Secure' : ''}`;

export interface ConsentEnv {
  document: Document;
  analyticsSrc: string | null;
  template: Template;
  secure: boolean;
}

/** Owns the choice and the analytics loader. The script is created only from `loadAnalytics`, which only `choose('all')`
 * and a stored 'all' reach; withdrawing stops later events and clears the queue (a loaded vendor script is gone on reload). */
export function createConsent(env: ConsentEnv) {
  let loaded = false;
  const listeners = new Set<(c: Choice | null) => void>();
  const win = env.document.defaultView as (Window & { dataLayer?: unknown[] }) | null;

  const current = (): Choice | null => readChoice(env.document.cookie);

  function loadAnalytics(): void {
    if (loaded || env.analyticsSrc === null) return;
    loaded = true;
    if (win !== null) win.dataLayer = win.dataLayer ?? [];
    const s = env.document.createElement('script');
    s.src = env.analyticsSrc;
    s.async = true;
    env.document.head.appendChild(s);
    track({ event: 'page_view', template: env.template });
  }

  function track(raw: unknown): void {
    if (current() !== 'all' || win === null) return;
    const ev = sanitise(raw);
    if (ev === null) return;
    (win.dataLayer = win.dataLayer ?? []).push(ev);
  }

  function choose(c: Choice): void {
    env.document.cookie = serialiseChoice(c, env.secure);
    if (c === 'all') loadAnalytics();
    else if (win !== null) win.dataLayer = [];
    listeners.forEach((l) => l(c));
  }

  return {
    current,
    choose,
    track,
    start: () => {
      if (current() === 'all') loadAnalytics();
    },
    subscribe: (l: (c: Choice | null) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}
