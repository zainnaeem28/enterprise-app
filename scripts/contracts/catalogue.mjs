// Reads the R1 route catalogue (ARCHITECTURE sections 29.1-29.5, draft 8.1) from docs/ARCHITECTURE.md
// and expands every table row into routes: one {host, method, path} per route.
//
// Most first cells name one path with one or more methods and expand mechanically. A cell that
// uses "…/x" shorthand, lists several paths, or leaves a path implicit is expanded by the explicit
// table in route-expansions.mjs. That table is keyed by the exact cell text, so a changed document
// row makes the check fail instead of being silently skipped.
import { readFileSync } from 'node:fs';
import { EXPANSIONS } from './route-expansions.mjs';

const METHODS = 'GET|POST|PUT|PATCH|DELETE';
const SIMPLE = new RegExp(
  `^\`((?:${METHODS})(?:/(?:${METHODS}))*) (/[^\`\\s]*)\`( †)?(?: \\([^)]*\\))?$`,
);

export const SECTIONS = {
  29.1: { hosts: ['my', 'staff'], columns: ['who', 'notes'] },
  29.2: { hosts: ['my'], columns: ['perm', 'scope', 'idemIfMatch', 'notes'] },
  29.3: { hosts: ['staff'], columns: ['perm', 'scope', 'idemIfMatch', 'notes'] },
  29.4: { hosts: ['staff'], columns: ['perm', 'notes'] },
  29.5: { hosts: ['integrations'], columns: ['caller', 'authentication', 'notes'] },
};

/** Collapse a path to a comparable key: parameter names are not significant. */
export function normalisePath(path) {
  return path.replace(/\{[^}]+\}/g, '{}');
}

function splitRow(line) {
  return line
    .trim()
    .replace(/^\|\s*/, '')
    .replace(/\s*\|$/, '')
    .split(/ \| /)
    .map((c) => c.trim());
}

/** First table of each 29.x section as {section, cells[]} rows. */
export function readRows(markdown) {
  const lines = markdown.split('\n');
  const rows = [];
  let section = null;
  let inTable = false;
  let tableDone = false;
  for (const line of lines) {
    if (line.startsWith('## 30.')) break;
    const heading = /^### (29\.\d) /.exec(line);
    if (heading) {
      section = heading[1];
      inTable = false;
      tableDone = false;
      continue;
    }
    if (!section) continue;
    if (line.startsWith('|')) {
      if (tableDone) continue;
      inTable = true;
      if (/^\| -/.test(line) || /^\| Method and path/.test(line)) continue;
      rows.push({ section, cells: splitRow(line) });
    } else if (inTable) {
      tableDone = true;
    }
  }
  return rows;
}

/** Expand the first cell of a row into [{method, path, elevation}] (path as written, no query). */
export function expandCell(cell) {
  if (cell.startsWith('*(')) return []; // a note row (both rows above, draft 6), no route of its own
  const simple = SIMPLE.exec(cell);
  if (simple) {
    const [, methods, rawPath, dagger] = simple;
    const path = rawPath.split('?')[0];
    return methods.split('/').map((method) => ({ method, path, elevation: Boolean(dagger) }));
  }
  const explicit = EXPANSIONS[cell];
  if (!explicit) throw new Error(`No expansion for catalogue cell: ${cell}`);
  return explicit.map((entry) => {
    const [method, path, dagger] = entry.split(' ');
    return { method, path: path.split('?')[0], elevation: dagger === '†' };
  });
}

// 29.1 serves both portal hosts, except the admin sign-in family and the staff-only re-authentication.
function hostsFor(section, path, cell, defaults) {
  if (section !== '29.1') return defaults;
  return path.startsWith('/api/v1/admin/') || /\(staff\)/.test(cell) ? ['staff'] : defaults;
}

function parseIdemIfMatch(text) {
  // "Idem", "If-Match", "Idem; If-Match", "Idem on POST; If-Match", "If-Match on PUT", "—"
  const parts = text.split(';').map((p) => p.trim());
  const idem = parts.find((p) => p.startsWith('Idem'));
  const ifMatch = parts.find((p) => p.startsWith('If-Match'));
  return {
    idem: idem ? { raw: idem, onPostOnly: /on POST/.test(idem) } : null,
    ifMatch: ifMatch ? { raw: ifMatch, onMethod: /on (\w+)/.exec(ifMatch)?.[1] ?? null } : null,
  };
}

/** Every row with its routes and the cell values that apply to all of them. */
export function parseCatalogue(markdown) {
  const out = [];
  let rowNo = 0;
  for (const { section, cells } of readRows(markdown)) {
    rowNo += 1;
    const spec = SECTIONS[section];
    const named = Object.fromEntries(spec.columns.map((name, i) => [name, cells[i + 1] ?? '']));
    const routes = expandCell(cells[0]).map((r) => ({
      ...r,
      hosts: hostsFor(section, r.path, cells[0], spec.hosts),
    }));
    const flags =
      section === '29.2' || section === '29.3' ? parseIdemIfMatch(named.idemIfMatch) : null;
    out.push({ rowNo, section, cell: cells[0], columns: named, flags, routes });
  }
  return out;
}

/** Flat list of {host, method, path, key, rowNo, section} (reserved wildcard routes excluded). */
export function flattenRoutes(rows) {
  const flat = [];
  for (const row of rows) {
    for (const route of row.routes) {
      if (route.path.includes('*')) continue;
      for (const host of route.hosts) {
        flat.push({
          host,
          method: route.method,
          path: route.path,
          key: `${host} ${route.method} ${normalisePath(route.path)}`,
          rowNo: row.rowNo,
          section: row.section,
          elevation: route.elevation,
        });
      }
    }
  }
  return flat;
}

export function reservedRoutes(rows) {
  return rows.flatMap((row) =>
    row.routes
      .filter((r) => r.path.includes('*'))
      .map((r) => ({ ...r, rowNo: row.rowNo, section: row.section })),
  );
}

export function loadCatalogue(architecturePath) {
  return parseCatalogue(readFileSync(architecturePath, 'utf8'));
}
