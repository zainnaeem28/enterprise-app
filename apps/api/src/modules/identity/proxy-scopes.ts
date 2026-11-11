// The patient-realm routes a proxy may use beyond the appointment routes, by scope (ruling C item 3, D-7). The default scope is
// appointments only (`permission: 'proxy'` routes); the patient grants `documents` and `messages` one by one. Read-only on purpose:
// a proxy never writes documents, and a reply needs a thread participant, which belongs to the messaging module.
// The table is closed: a route that is not listed here stays closed to a proxy, whatever it holds. Row-level security repeats the
// rule underneath (`identity.proxy_allows`), so a route added to the table still reads only what the scope releases.
import type { ProxyScope } from './types.js';

interface ScopedRoute {
  scope: Exclude<ProxyScope, 'appointments'>;
  method: string;
  path: RegExp;
}

export const PROXY_SCOPED_ROUTES: readonly ScopedRoute[] = [
  { scope: 'documents', method: 'GET', path: /^\/api\/v1\/patients\/[^/]+\/documents$/ },
  { scope: 'documents', method: 'POST', path: /^\/api\/v1\/documents\/[^/]+\/download-url$/ },
  { scope: 'messages', method: 'GET', path: /^\/api\/v1\/patients\/[^/]+\/threads$/ },
];

/** Does a proxy holding `scopes` reach `method path`? */
export function proxyScopeCoversRoute(
  scopes: readonly ProxyScope[],
  method: string,
  path: string,
): boolean {
  const m = method.toUpperCase();
  return PROXY_SCOPED_ROUTES.some(
    (r) => r.method === m && r.path.test(path) && scopes.includes(r.scope),
  );
}
