import { allNavPaths } from './navigation.js';

/**
 * `returnTo` is sent to `GET /api/v1/auth/sign-in?returnTo=` and comes back after sign-in. Only a fixed screen path
 * from the navigation map is ever allowed: no query, no hash, no other path, so a record identifier or any PHI
 * cannot travel in the URL and an attacker cannot make the portal redirect somewhere else.
 */
export function safeReturnTo(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  return allNavPaths.includes(value) ? value : undefined;
}

/** Full-page navigation target of the "Continue with Google" link (top-level GET; the API answers 302 to Google). */
export function googleSignInHref(returnTo: string | undefined): string {
  const safe = safeReturnTo(returnTo);
  return safe === undefined
    ? '/api/v1/auth/sign-in'
    : `/api/v1/auth/sign-in?returnTo=${encodeURIComponent(safe)}`;
}
