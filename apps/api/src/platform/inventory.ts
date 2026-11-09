// Route inventory (ARCHITECTURE 38.2 item 9, BD-07): every handler of every controller declares a permission, a
// resolver and, where it names a permission, a name that exists in the catalogue. Run by `test` and by the CLI.
import 'reflect-metadata';
import { HOST_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { isKnownPermission } from './permissions.js';
import { ROUTE_META } from './route.js';
import type { RouteDeclaration } from './route.js';

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD', 'SEARCH'];

export interface InventoryEntry {
  controller: string;
  handler: string;
  method: string;
  path: string;
  host?: string;
  declaration?: RouteDeclaration;
}

export interface InventoryReport {
  routes: InventoryEntry[];
  failures: string[];
}

const join = (a: string, b: string): string =>
  `/${[a, b]
    .map((s) => s.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/')}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctor = new (...args: any[]) => object;

export function inventory(controllers: readonly Ctor[]): InventoryReport {
  const routes: InventoryEntry[] = [];
  const failures: string[] = [];
  for (const c of controllers) {
    const base = (Reflect.getMetadata(PATH_METADATA, c) as string | string[] | undefined) ?? '';
    const host = Reflect.getMetadata(HOST_METADATA, c) as string | string[] | undefined;
    const hostName = Array.isArray(host) ? host.join(',') : host;
    const proto = c.prototype as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(proto)) {
      const fn = proto[name];
      if (name === 'constructor' || typeof fn !== 'function') continue;
      const method = Reflect.getMetadata(METHOD_METADATA, fn) as number | undefined;
      if (method === undefined) continue;
      const path = Reflect.getMetadata(PATH_METADATA, fn) as string | string[] | undefined;
      const decl = Reflect.getMetadata(ROUTE_META, fn) as RouteDeclaration | undefined;
      const entry: InventoryEntry = {
        controller: c.name,
        handler: name,
        method: METHODS[method] ?? String(method),
        path: join(
          Array.isArray(base) ? (base[0] ?? '') : base,
          Array.isArray(path) ? (path[0] ?? '') : (path ?? ''),
        ),
      };
      if (hostName !== undefined && hostName !== '') entry.host = hostName;
      if (decl !== undefined) entry.declaration = decl;
      routes.push(entry);
      const id = `${entry.method} ${entry.path} (${c.name}.${name})`;
      if (decl === undefined) {
        failures.push(`${id}: no route declaration`);
        continue;
      }
      if (typeof decl.permission !== 'string' || decl.permission === '')
        failures.push(`${id}: no permission declared`);
      else if (!isKnownPermission(decl.permission))
        failures.push(`${id}: permission ${decl.permission} is not in the catalogue`);
      if (typeof decl.resolver !== 'string' || decl.resolver === '')
        failures.push(`${id}: no resolver declared`);
    }
  }
  // One METHOD path may appear twice only when every occurrence is host-bound and the hosts differ (INT03-F21-O1).
  const byKey = new Map<string, InventoryEntry[]>();
  for (const r of routes)
    byKey.set(`${r.method} ${r.path}`, [...(byKey.get(`${r.method} ${r.path}`) ?? []), r]);
  for (const [key, list] of byKey) {
    if (list.length < 2) continue;
    const hosts = list.map((r) => r.host);
    if (hosts.some((h) => h === undefined) || new Set(hosts).size !== hosts.length)
      failures.push(
        `${key}: declared ${list.length} times (${list.map((r) => `${r.controller}.${r.handler}`).join(', ')}) without distinct host bindings`,
      );
  }
  return { routes, failures };
}
