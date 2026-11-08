export type ProfileRoute =
  { name: 'profile' } | { name: 'notifications' } | { name: 'family' } | { name: 'family-add' };

const ROUTES: Record<string, ProfileRoute> = {
  '/profile': { name: 'profile' },
  '/profile/notifications': { name: 'notifications' },
  '/family': { name: 'family' },
  '/family/add': { name: 'family-add' },
};

export const matchProfileRoute = (path: string): ProfileRoute | undefined =>
  ROUTES[path.length > 1 ? path.replace(/\/+$/, '') : path];

export const isProfilePath = (path: string): boolean => matchProfileRoute(path) !== undefined;
