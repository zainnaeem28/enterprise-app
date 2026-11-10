/** The paths this feature serves. They match the pre-consultation navigation items and carry no record identifier. */
export const PRECONSULT_PATHS = ['/arrivals', '/triage', '/forms', '/follow-ups'] as const;
export type PreconsultPath = (typeof PRECONSULT_PATHS)[number];
export const isPreconsultPath = (path: string): path is PreconsultPath =>
  (PRECONSULT_PATHS as readonly string[]).includes(path);
