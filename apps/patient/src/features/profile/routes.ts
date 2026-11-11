export type ProfileRoute =
  | { name: 'profile' }
  | { name: 'notifications' }
  | { name: 'family' }
  | { name: 'family-add' }
  | { name: 'family-accept'; grantId: string };

const ROUTES: Record<string, ProfileRoute> = {
  '/profile': { name: 'profile' },
  '/profile/notifications': { name: 'notifications' },
  '/family': { name: 'family' },
  '/family/add': { name: 'family-add' },
};

/** The link in the invitation e-mail: `/family/accept/<grant id>`. The id is the invitation's, not a patient's. */
const ACCEPT =
  /^\/family\/accept\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function matchProfileRoute(path: string): ProfileRoute | undefined {
  const clean = path.length > 1 ? path.replace(/\/+$/, '') : path;
  const accept = ACCEPT.exec(clean);
  if (accept !== null) return { name: 'family-accept', grantId: accept[1] as string };
  return ROUTES[clean];
}

export const isProfilePath = (path: string): boolean => matchProfileRoute(path) !== undefined;
