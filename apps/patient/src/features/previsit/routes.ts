export type PrevisitRoute =
  | { name: 'hub'; reservationId: string }
  | { name: 'questionnaire'; reservationId: string }
  | { name: 'consents'; reservationId: string }
  | { name: 'insurance'; reservationId: string }
  | { name: 'emergency'; reservationId: string };

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const PATTERN = new RegExp(
  `^/appointments/(${UUID})/previsit(?:/(questionnaire|consents|insurance|emergency))?/?$`,
);

/** Routes carry the reservation ID only (no PHI in the URL, UI-UX 6 session-ended rule). */
export function matchPrevisitRoute(path: string): PrevisitRoute | undefined {
  const m = PATTERN.exec(path);
  if (m === null) return undefined;
  const reservationId = (m[1] as string).toLowerCase();
  return { name: (m[2] ?? 'hub') as PrevisitRoute['name'], reservationId };
}

export const isPrevisitPath = (path: string): boolean => matchPrevisitRoute(path) !== undefined;

export const previsitPath = (reservationId: string, part?: string): string =>
  `/appointments/${reservationId}/previsit${part === undefined ? '' : `/${part}`}`;
