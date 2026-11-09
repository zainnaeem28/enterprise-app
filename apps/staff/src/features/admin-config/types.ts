// Shapes the admin configuration screens read. The response types of these operations are opaque, so each reader keeps only what a
// screen shows. A field the server adds later is ignored, never displayed. Secrets never appear in a response and are never read.
import { arr, num, rec, str, strOrNull } from '../preconsult/http.js';

export type Row = Record<string, unknown>;
export interface Page {
  items: Row[];
  nextCursor: string | null;
}

export function parsePage(data: unknown): Page | undefined {
  const d = rec(data);
  if (!Array.isArray(d['items'])) return undefined;
  const items = arr(d['items']);
  if (items.some((i) => typeof i !== 'object' || i === null || Array.isArray(i))) return undefined;
  return { items: items as Row[], nextCursor: strOrNull(d['nextCursor']) };
}
export const parseRow = (data: unknown): Row | undefined =>
  typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as Row) : undefined;

export const text = (r: Row, k: string): string => str(r[k]) ?? '';
export const flag = (r: Row, k: string): boolean => r[k] === true;
export const version = (r: Row): number | undefined => {
  const v = r['rowVersion'];
  const n = typeof v === 'string' ? Number(v) : num(v);
  return n !== undefined && Number.isInteger(n) ? n : undefined;
};
/** Stable key of a row: the id, or the natural key of rows that have none (opening hours). */
export const keyOf = (r: Row): string =>
  str(r['id']) ?? `${text(r, 'locationId')}|${String(r['weekday'] ?? '')}|${text(r, 'opens')}`;

export type Health = 'unknown' | 'ok' | 'degraded' | 'down';
export const HEALTH: readonly string[] = ['unknown', 'ok', 'degraded', 'down'];
export interface Integration {
  id: string;
  kind: string;
  vendor: string;
  enabled: boolean;
  health: Health;
  lastTestAt: string | null;
  version: number | undefined;
}
export function parseIntegration(r: Row): Integration | undefined {
  const id = str(r['id']);
  const kind = str(r['kind']);
  if (id === undefined || kind === undefined) return undefined;
  const h = str(r['health']);
  return {
    id,
    kind,
    vendor: str(r['vendor']) ?? '',
    enabled: r['enabled'] === true,
    health: h !== undefined && HEALTH.includes(h) ? (h as Health) : 'unknown',
    lastTestAt: strOrNull(r['lastTestAt']),
    version: version(r),
  };
}
export function parseTest(data: unknown): { health: Health; checkedAt: string } | undefined {
  const o = rec(data);
  const h = str(o['health']);
  const at = str(o['checkedAt']);
  if (h === undefined || at === undefined || !HEALTH.includes(h)) return undefined;
  return { health: h as Health, checkedAt: at };
}
export function parseVersionId(data: unknown): string | undefined {
  return str(rec(data)['versionId']);
}

export interface VitalRange {
  id: string;
  loincCode: string;
  unit: string;
  sex: string;
  ageFrom: number | null;
  ageTo: number | null;
  low: number | null;
  high: number | null;
  status: string;
  approvedByNote: string;
}
/** The age band arrives as `{from, to?}` (the request shape) or as a range text such as `[18,65)`. */
function ageBand(v: unknown): { from: number | null; to: number | null } {
  const o = rec(v);
  if (typeof v === 'object' && v !== null)
    return {
      from: num(o['from']) ?? num(o['lower']) ?? null,
      to: num(o['to']) ?? num(o['upper']) ?? null,
    };
  const m = typeof v === 'string' ? /^[[(]\s*(\d*)\s*,\s*(\d*)\s*[\])]$/.exec(v) : null;
  return m === null
    ? { from: null, to: null }
    : { from: m[1] === '' ? null : Number(m[1]), to: m[2] === '' ? null : Number(m[2]) };
}
const numOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v)
    ? v
    : typeof v === 'string' && v !== '' && Number.isFinite(Number(v))
      ? Number(v)
      : null;
export function parseVitalRange(r: Row): VitalRange | undefined {
  const id = str(r['id']);
  const loincCode = str(r['loincCode']);
  if (id === undefined || loincCode === undefined) return undefined;
  const band = ageBand(r['ageYears']);
  return {
    id,
    loincCode,
    unit: str(r['unit']) ?? '',
    sex: str(r['sex']) ?? 'any',
    ageFrom: band.from,
    ageTo: band.to,
    low: numOrNull(r['low']),
    high: numOrNull(r['high']),
    status: str(r['status']) ?? 'active',
    approvedByNote: str(r['approvedByNote']) ?? '',
  };
}
