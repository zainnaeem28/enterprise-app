import { UUID_RE } from './directory.js';

/**
 * The "Book" hand-off to the patient portal (`my.`): service and doctor travel as opaque IDs and nothing else, so the URL
 * carries no name, date of birth or other personal data. An ID that is not a UUID is dropped rather than passed on.
 */
export function bookUrl(
  patientOrigin: string,
  sel: { serviceId?: string; clinicianId?: string },
): string {
  const u = new URL('/book', patientOrigin);
  if (sel.serviceId !== undefined && UUID_RE.test(sel.serviceId))
    u.searchParams.set('serviceId', sel.serviceId.toLowerCase());
  if (sel.clinicianId !== undefined && UUID_RE.test(sel.clinicianId))
    u.searchParams.set('clinicianId', sel.clinicianId.toLowerCase());
  return u.toString();
}
