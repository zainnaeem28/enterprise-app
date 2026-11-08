import { failureOf, guard, matchHeader, NETWORK, rec } from '../preconsult/http.js';
import type { Api, Failure, Outcome } from '../preconsult/http.js';
import {
  conflictsFromError,
  parseBlocked,
  parseBlockedSaved,
  parseDay,
  parseLink,
  parseTemplate,
} from './types.js';
import type {
  Blocked,
  BlockedKind,
  BlockedSaved,
  Conflicts,
  DaySchedule,
  LinkView,
  Rule,
  Template,
} from './types.js';

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
type LooseCall = (
  path: string,
  init: {
    params: {
      header: Record<string, string>;
      path?: Record<string, string>;
      query?: Record<string, string>;
    };
    body?: unknown;
  },
) => Promise<{ data?: unknown; error?: unknown; response: Response }>;

/** A refused save of leave over booked appointments: the refusal plus the counts the server named (29.3). */
export type SaveFailure = Failure & { conflicts?: Conflicts };

const items = <T>(parse: (v: unknown) => T | undefined) => {
  return (d: unknown): T[] | undefined => {
    const list = rec(d)['items'];
    if (!Array.isArray(list)) return undefined;
    const out = list.map(parse);
    return out.every((x) => x !== undefined) ? (out as T[]) : undefined;
  };
};

const ruleBody = (r: Rule) => ({
  weekday: r.weekday,
  startLocal: r.startLocal,
  endLocal: r.endLocal,
  serviceIds: r.serviceIds,
  mode: r.mode,
  roomId: r.roomId,
  overbookable: r.overbookable,
});

export interface TemplateDraft {
  locationId: string;
  validFrom: string;
  validTo: string | null;
  rules: Rule[];
}

/**
 * Every call the availability screens make, over the shell's client (CSRF and release headers are added by the shell). The generated
 * types of these operations are opaque objects and the blocked-time DELETE of the catalogue has no identifier, so the calls are made
 * through the same untyped seam the doctor portal uses, with the bodies and paths of the controllers (BE-12 `controller.ts`, BE-14).
 */
export function createAvailabilityApi(api: Api) {
  const header = api.header;
  const loose = api as unknown as Record<Method, LooseCall>;
  const keyed = (key: string) => ({ ...header, 'Idempotency-Key': key });

  return {
    /** `GET /clinicians/{id}/availability-templates?status=active` */
    templates: (clinicianId: string): Promise<Outcome<Template[]>> =>
      guard(
        () =>
          loose.GET('/api/v1/clinicians/{id}/availability-templates', {
            params: { header, path: { id: clinicianId }, query: { status: 'active' } },
          }),
        items(parseTemplate),
      ),

    createTemplate: (
      clinicianId: string,
      t: TemplateDraft,
      key: string,
    ): Promise<Outcome<Template>> =>
      guard(
        () =>
          loose.POST('/api/v1/clinicians/{id}/availability-templates', {
            params: { header: keyed(key), path: { id: clinicianId } },
            body: {
              locationId: t.locationId,
              validFrom: t.validFrom,
              ...(t.validTo === null ? {} : { validTo: t.validTo }),
              rules: t.rules.map(ruleBody),
            },
          }),
        parseTemplate,
      ),

    /** `PUT` replaces the rules; it needs the version we hold (`If-Match`), never an invented one. */
    replaceTemplate: (
      clinicianId: string,
      templateId: string,
      version: number,
      t: TemplateDraft,
    ): Promise<Outcome<Template>> =>
      guard(
        () =>
          loose.PUT('/api/v1/clinicians/{id}/availability-templates/{templateId}', {
            params: {
              header: { ...header, ...matchHeader(version) },
              path: { id: clinicianId, templateId },
            },
            body: {
              locationId: t.locationId,
              validFrom: t.validFrom,
              ...(t.validTo === null ? {} : { validTo: t.validTo }),
              rules: t.rules.map(ruleBody),
            },
          }),
        parseTemplate,
      ),

    retireTemplate: (
      clinicianId: string,
      templateId: string,
      version: number,
    ): Promise<Outcome<Template>> =>
      guard(
        () =>
          loose.DELETE('/api/v1/clinicians/{id}/availability-templates/{templateId}', {
            params: {
              header: { ...header, ...matchHeader(version) },
              path: { id: clinicianId, templateId },
            },
          }),
        parseTemplate,
      ),

    /** `GET /clinicians/{id}/schedule?locationId&date`: the caller's own visits that day (today when no date), with the location's time zone. */
    day: (clinicianId: string, locationId: string, date?: string): Promise<Outcome<DaySchedule>> =>
      guard(
        () =>
          loose.GET('/api/v1/clinicians/{id}/schedule', {
            params: {
              header,
              path: { id: clinicianId },
              query: date === undefined ? { locationId } : { locationId, date },
            },
          }),
        parseDay,
      ),

    /** `GET /clinicians/{id}/blocked-times?from=`: leave and blocked time that has not ended yet. */
    blockedTimes: (clinicianId: string, from: string): Promise<Outcome<Blocked[]>> =>
      guard(
        () =>
          loose.GET('/api/v1/clinicians/{id}/blocked-times', {
            params: { header, path: { id: clinicianId }, query: { from } },
          }),
        items(parseBlocked),
      ),

    /**
     * `POST /clinicians/{id}/blocked-times`. With `dryRun` the server saves nothing and answers the counts (200). Without it, booked
     * appointments in the period make it answer `409 scheduling.conflicts_with_appointments` unless `acknowledgeConflicts` is sent.
     */
    saveBlocked: async (
      clinicianId: string,
      body: {
        startsAt: string;
        endsAt: string;
        kind: BlockedKind;
        note: string | null;
        dryRun?: boolean;
        acknowledgeConflicts?: boolean;
      },
      key: string,
    ): Promise<{ ok: true; data: BlockedSaved } | SaveFailure> => {
      try {
        const { data, error, response } = await loose.POST(
          '/api/v1/clinicians/{id}/blocked-times',
          {
            params: { header: keyed(key), path: { id: clinicianId } },
            body: {
              startsAt: body.startsAt,
              endsAt: body.endsAt,
              kind: body.kind,
              ...(body.note === null || body.note === '' ? {} : { note: body.note }),
              ...(body.dryRun === true ? { dryRun: true } : {}),
              ...(body.acknowledgeConflicts === true ? { acknowledgeConflicts: true } : {}),
            },
          },
        );
        if (!response.ok) {
          const f = failureOf(response, error);
          const conflicts =
            f.code === 'scheduling.conflicts_with_appointments'
              ? conflictsFromError(error)
              : undefined;
          return conflicts === undefined ? f : { ...f, conflicts };
        }
        const parsed = parseBlockedSaved(data);
        return parsed === undefined
          ? { ok: false, status: response.status, code: 'kernel.unavailable', fields: [] }
          : { ok: true, data: parsed };
      } catch {
        return NETWORK;
      }
    },

    /** `DELETE /clinicians/{id}/blocked-times/{blockedId}` answers 204. */
    deleteBlocked: (clinicianId: string, blockedId: string): Promise<Outcome<true>> =>
      guard(
        () =>
          loose.DELETE('/api/v1/clinicians/{id}/blocked-times/{blockedId}', {
            params: { header, path: { id: clinicianId, blockedId } },
          }),
        () => true,
      ),

    /** `GET /calendar-link` (calendar.link.own): status only, never a token. */
    link: (): Promise<Outcome<LinkView>> =>
      guard(() => loose.GET('/api/v1/calendar-link', { params: { header } }), parseLink),

    /** `POST /calendar-link/start`: the Google consent address to send the browser to. */
    startLink: (): Promise<Outcome<{ authorizationUrl: string }>> =>
      guard(
        () => loose.POST('/api/v1/calendar-link/start', { params: { header } }),
        (d) => {
          const u = rec(d)['authorizationUrl'];
          return typeof u === 'string' ? { authorizationUrl: u } : undefined;
        },
      ),

    unlink: (): Promise<Outcome<true>> =>
      guard(
        () => loose.DELETE('/api/v1/calendar-link', { params: { header } }),
        () => true,
      ),
  };
}
export type AvailabilityApi = ReturnType<typeof createAvailabilityApi>;
