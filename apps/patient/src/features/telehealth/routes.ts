export interface TelehealthRoute {
  name: 'join';
  reservationId: string;
}

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const PATTERN = new RegExp(`^/appointments/(${UUID})/video/?$`);

/** The route carries the reservation ID only (no PHI in the URL). */
export function matchTelehealthRoute(path: string): TelehealthRoute | undefined {
  const m = PATTERN.exec(path);
  return m === null ? undefined : { name: 'join', reservationId: (m[1] as string).toLowerCase() };
}

export const isTelehealthPath = (path: string): boolean => matchTelehealthRoute(path) !== undefined;
export const videoPath = (reservationId: string): string => `/appointments/${reservationId}/video`;
