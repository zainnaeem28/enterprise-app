/** The paths this feature serves. They match the doctor navigation items and carry no record identifier. */
export const DOCTOR_PATHS = ['/schedule', '/patients', '/alerts', '/notes-to-sign'] as const;
export type DoctorPath = (typeof DOCTOR_PATHS)[number];
export const isDoctorPath = (path: string): path is DoctorPath =>
  (DOCTOR_PATHS as readonly string[]).includes(path);
