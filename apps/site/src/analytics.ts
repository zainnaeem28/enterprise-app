// Analytics on the brand site (BR-36, NFR-18, SEC-D-07): no health data ever, and nothing loads before consent.
// Only the template of the page is reported ("doctor-profile", never a doctor, service or location name, ID or URL).
export const TEMPLATES = [
  'home',
  'services',
  'doctors',
  'doctor-profile',
  'locations',
  'contact',
  'legal',
  'not-found',
] as const;
export type Template = (typeof TEMPLATES)[number];

export type AnalyticsEvent =
  { event: 'page_view'; template: Template } | { event: 'book_click'; template: Template };

const EVENTS = new Set(['page_view', 'book_click']);

/** Allow-list: unknown events, unknown properties and non-template values are dropped, so no caller can add free text. */
export function sanitise(raw: unknown): AnalyticsEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const event = r['event'];
  const template = r['template'];
  if (typeof event !== 'string' || !EVENTS.has(event)) return null;
  if (typeof template !== 'string' || !(TEMPLATES as readonly string[]).includes(template))
    return null;
  return { event, template } as AnalyticsEvent;
}
