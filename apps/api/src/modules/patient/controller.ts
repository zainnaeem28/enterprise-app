// The patient routes of ARCHITECTURE 29.2 (patient portal `my.`), 29.3 (staff portal `staff.`) and 29.4 (admin: the `consents`
// slice and the patient label). Merge routes (`/patient-merges`) belong to BE-09. Every handler declares {permission, resolver}
// (BD-07). The guard has already authenticated, checked CSRF, the realm, the permission and the resolver result by the time a
// handler runs; the handler then opens the one transaction under the caller's scope, so row-level security is the second line.
//
// A resource the caller cannot see is 404 (CN-04), never 403, and the guard has audited the attempt as `denied` with the reason
// `not_visible` (RA-R1-17). A merged record the caller can read is 409 `patient.merged`, with the survivor's ID only when the
// caller may read the survivor (9.2).
import {
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Req as ReqParam,
  Res as ResParam,
} from '@nestjs/common';
import type { Type } from '@nestjs/common';
import { beginIdempotent, completeIdempotent, parseIdempotencyKey, requestHash } from '@ehr/kernel';
import type { KernelDb, Tx } from '@ehr/kernel';
import { ApiError } from '../../platform/errors.js';
import type { Req, Res } from '../../platform/http.js';
import type { RateLimiter } from '../../platform/rate-limit.js';
import { Route } from '../../platform/route.js';
import { requireAuthContext } from '../identity/index.js';
import type { ProxyService, ResourceResolver } from '../identity/index.js';
import {
  PatientNotFoundError,
  PatientRateLimitedError,
  PreconditionFailedError,
  PreconditionRequiredError,
  PatientValidationError,
  ProxyRulesNotConfiguredError,
} from './errors.js';
import { isUuid } from './ids.js';
import type { PatientRecordsService } from './records.js';
import type { PatientService } from './service.js';
import type { PatientBanner, PatientRecord, RequestMeta } from './types.js';

export interface PatientControllerDeps {
  db: KernelDb;
  patients: PatientService;
  records: PatientRecordsService;
  proxies: ProxyService;
  /** Exact across instances (PgRateLimiter): the identity-label limit of 6.7 is a compliance control. */
  limiter: RateLimiter;
  /** 60 per hour per principal (6.7 planning value). */
  labelLimitPerHour?: number;
  /** D-7: the proxy verification rule values (RA-R1-20b) do not exist yet. Until they do, a proxy request is refused. */
  proxyRulesConfigured?: boolean;
}

const metaOf = (req: Req): RequestMeta => ({
  requestId: req.requestId ?? null,
  ip: req.ip ?? null,
  userAgent: req.header('user-agent') ?? null,
});

const send = (
  res: Res,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void => {
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(body);
};

const etag = (version: number): string => `W/"${version}"`;

/** `If-Match`: the row version in a weak or strong ETag. Absent -> 428; unreadable -> 412. */
export function ifMatchVersion(req: Req, required = true): number | undefined {
  const h = req.header('if-match');
  if (h === undefined || h.trim() === '') {
    if (required) throw new PreconditionRequiredError();
    return undefined;
  }
  const m = /^(?:W\/)?"?(\d{1,15})"?$/.exec(h.trim());
  if (m === null) throw new PreconditionFailedError();
  return Number(m[1]);
}

const itemsOf = <T>(items: T[]): { items: T[]; nextCursor: null } => ({ items, nextCursor: null });

/** The profile as the API returns it: no internal columns beyond what the screens need. */
const profileBody = (p: PatientRecord): Record<string, unknown> => ({
  id: p.id,
  mrn: p.mrn,
  givenName: p.givenName,
  familyName: p.familyName,
  middleName: p.middleName,
  dateOfBirth: p.dateOfBirth,
  sexAtBirth: p.sexAtBirth,
  genderIdentity: p.genderIdentity,
  phone: p.phone,
  email: p.email,
  address: p.address,
  stateCode: p.stateCode,
  preferredLanguage: p.preferredLanguage,
  photoDocumentId: p.photoDocumentId,
  preferredPharmacy: p.preferredPharmacy,
  status: p.status,
  mergedInto: p.mergedInto,
  version: p.rowVersion,
});

/**
 * Resource resolvers (27.1). Each returns the resource's patient (or location) when the caller's own RLS shows it, `undefined`
 * otherwise, which the guard answers with 404 and an audited `not_visible`.
 */
export function patientResolvers(): Record<string, ResourceResolver> {
  const param = (req: Req, name: string): string | undefined => {
    const m = new RegExp(`/${name}/([0-9a-f-]{36})(?:/|$)`, 'i').exec(req.path);
    return m?.[1];
  };
  return {
    // /patients/{patientId}/...
    patient: async (req, _ctx, tx) => {
      const id = param(req, 'patients');
      if (id === undefined || !isUuid(id)) return undefined;
      const r = await tx.query(`SELECT 1 FROM patient.patient WHERE id = $1::uuid`, [id]);
      return r.rows.length === 0 ? undefined : { patientId: id.toLowerCase() };
    },
    // /consents/{consentId}/sign
    consent: async (req, _ctx, tx) => {
      const id = param(req, 'consents');
      if (id === undefined || !isUuid(id)) return undefined;
      const r = await tx.query(`SELECT patient_id FROM patient.consent WHERE id = $1::uuid`, [id]);
      return r.rows[0] === undefined
        ? undefined
        : { patientId: String((r.rows[0] as Record<string, unknown>)['patient_id']) };
    },
    // /insurance-coverages/{id}/eligibility
    coverage: async (req, _ctx, tx) => {
      const id = param(req, 'insurance-coverages');
      if (id === undefined || !isUuid(id)) return undefined;
      const r = await tx.query(
        `SELECT patient_id FROM patient.insurance_coverage WHERE id = $1::uuid`,
        [id],
      );
      return r.rows[0] === undefined
        ? undefined
        : { patientId: String((r.rows[0] as Record<string, unknown>)['patient_id']) };
    },
    // body.locationId: the location the staff member acts at (must be one of their own, checked by the guard and the database)
    'location-body': (req) => {
      const loc = (req.body as Record<string, unknown> | undefined)?.['locationId'];
      return Promise.resolve(isUuid(loc) ? { locationId: loc.toLowerCase() } : {});
    },
    // ?locationId=
    'location-query': (req) => {
      const loc = req.query['locationId'];
      return Promise.resolve(isUuid(loc) ? { locationId: loc.toLowerCase() } : undefined);
    },
  };
}

export function createPatientControllers(d: PatientControllerDeps): Type<unknown>[] {
  const run = <T>(req: Req, fn: (tx: Tx) => Promise<T>): Promise<T> =>
    d.db.withScope(requireAuthContext(req).scope, fn);

  /**
   * An idempotent create (28.3): the idempotency row is inserted first, in the business transaction, and completed with the
   * response in the same transaction, so a retry returns the stored response and never writes twice.
   */
  async function idempotent(
    req: Req,
    res: Res,
    template: string,
    pathParams: string[],
    body: unknown,
    handler: (tx: Tx) => Promise<{ status: number; body: unknown; location?: string }>,
  ): Promise<void> {
    let key: string;
    try {
      key = parseIdempotencyKey(req.header('idempotency-key'));
    } catch {
      throw new ApiError(400, 'kernel.idempotency_key_required');
    }
    const hash = requestHash({
      method: req.method,
      routeTemplate: template,
      pathParams,
      query: {},
      body,
    });
    const out = await d.db.withScope(
      requireAuthContext(req).scope,
      async (tx) => {
        const begun = await beginIdempotent(tx, template, key, hash);
        if (begun.kind === 'replay') return { kind: 'replay' as const, replay: begun.response };
        const fresh = await handler(tx);
        await completeIdempotent(tx, template, key, {
          status: fresh.status,
          body: Buffer.from(JSON.stringify(fresh.body)),
          ...(fresh.location === undefined ? {} : { location: fresh.location }),
        });
        return { kind: 'fresh' as const, fresh };
      },
      { idempotent: true },
    );
    if (out.kind === 'replay') {
      const r = out.replay;
      res.setHeader('Idempotent-Replay', 'true');
      if (r.location !== null) res.setHeader('Location', r.location);
      send(res, r.status, r.body === null ? {} : JSON.parse(r.body.toString('utf8')));
      return;
    }
    send(
      res,
      out.fresh.status,
      out.fresh.body,
      out.fresh.location === undefined ? {} : { Location: out.fresh.location },
    );
  }

  /** The patient the route names, open for writing: 404 if invisible, 409 `patient.merged` (+ survivor when readable) if merged. */
  const open = (tx: Tx, patientId: string): Promise<PatientRecord> =>
    d.patients.requireOpen(tx, patientId);

  // ===== patient portal (29.2) ===============================================================================================

  @Controller('api/v1')
  class PatientPortalController {
    @Post('patients/self-registration')
    @Route({ permission: 'patient', resolver: 'none' })
    async selfRegister(@ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      await idempotent(req, res, 'POST /patients/self-registration', [], req.body, async (tx) => {
        const r = await d.patients.register(tx, metaOf(req), (req.body ?? {}) as never);
        return {
          status: 201,
          body: { patientId: r.patientId },
          location: `/api/v1/patients/${r.patientId}/profile`,
        };
      });
    }

    @Get('patients/:patientId/profile')
    @Route({ permission: 'patient', resolver: 'patient' })
    async profile(
      @Param('patientId') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      const p = await run(req, async (tx) => {
        const rec = await d.patients.get(tx, id);
        if (rec === undefined) throw new PatientNotFoundError();
        return { rec, contacts: await d.records.listContacts(tx, id) };
      });
      send(
        res,
        200,
        { ...profileBody(p.rec), contacts: p.contacts },
        { ETag: etag(p.rec.rowVersion) },
      );
    }

    @Patch('patients/:patientId/profile')
    @Route({ permission: 'patient', resolver: 'patient' })
    async patchProfile(
      @Param('patientId') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      const version = ifMatchVersion(req) as number;
      const rec = await run(req, async (tx) => {
        await open(tx, id);
        return d.patients.updateProfile(tx, metaOf(req), id, version, req.body);
      });
      send(res, 200, profileBody(rec), { ETag: etag(rec.rowVersion) });
    }

    @Get('patients/:patientId/contacts')
    @Route({ permission: 'patient', resolver: 'patient' })
    async contacts(
      @Param('patientId') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      send(res, 200, itemsOf(await run(req, (tx) => d.records.listContacts(tx, id))));
    }

    @Post('patients/:patientId/contacts')
    @Route({ permission: 'patient', resolver: 'patient' })
    async addContact(
      @Param('patientId') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      await idempotent(
        req,
        res,
        'POST /patients/{patientId}/contacts',
        [id],
        req.body,
        async (tx) => {
          await open(tx, id);
          const c = await d.records.addContact(tx, metaOf(req), id, req.body);
          return { status: 201, body: c, location: `/api/v1/patients/${id}/contacts` };
        },
      );
    }

    @Patch('patients/:patientId/contacts/:contactId')
    @Route({ permission: 'patient', resolver: 'patient' })
    async patchContact(
      @Param('patientId') id: string,
      @Param('contactId') contactId: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      const version = ifMatchVersion(req) as number;
      const c = await run(req, async (tx) => {
        await open(tx, id);
        return d.records.updateContact(tx, metaOf(req), id, contactId, version, req.body);
      });
      send(res, 200, c, { ETag: etag(c.rowVersion) });
    }

    @Delete('patients/:patientId/contacts/:contactId')
    @Route({ permission: 'patient', resolver: 'patient' })
    async deleteContact(
      @Param('patientId') id: string,
      @Param('contactId') contactId: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      await run(req, async (tx) => {
        await open(tx, id);
        await d.records.deleteContact(tx, metaOf(req), id, contactId);
      });
      res.status(204).end();
    }

    @Get('patients/:patientId/insurance-coverages')
    @Route({ permission: 'patient', resolver: 'patient' })
    async coverages(
      @Param('patientId') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      send(res, 200, itemsOf(await run(req, (tx) => d.records.listCoverages(tx, id))));
    }

    @Post('patients/:patientId/insurance-coverages')
    @Route({ permission: 'patient', resolver: 'patient' })
    async addCoverage(
      @Param('patientId') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      await idempotent(
        req,
        res,
        'POST /patients/{patientId}/insurance-coverages',
        [id],
        req.body,
        async (tx) => {
          await open(tx, id);
          const c = await d.records.addCoverage(tx, metaOf(req), id, req.body);
          return { status: 201, body: c, location: `/api/v1/patients/${id}/insurance-coverages` };
        },
      );
    }

    @Patch('patients/:patientId/insurance-coverages/:coverageId')
    @Route({ permission: 'patient', resolver: 'patient' })
    async patchCoverage(
      @Param('patientId') id: string,
      @Param('coverageId') coverageId: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      const version = ifMatchVersion(req) as number;
      const c = await run(req, async (tx) => {
        await open(tx, id);
        return d.records.updateCoverage(tx, metaOf(req), id, coverageId, version, req.body);
      });
      send(res, 200, c, { ETag: etag(c.rowVersion) });
    }

    @Get('patients/:patientId/communication-preferences')
    @Route({ permission: 'patient', resolver: 'patient' })
    async preferences(
      @Param('patientId') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      const p = await run(req, (tx) => d.records.getPreferences(tx, id));
      if (p === undefined) throw new PatientNotFoundError();
      send(res, 200, p, p.rowVersion === null ? {} : { ETag: etag(p.rowVersion) });
    }

    @Put('patients/:patientId/communication-preferences')
    @Route({ permission: 'patient', resolver: 'patient' })
    async putPreferences(
      @Param('patientId') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      const version = ifMatchVersion(req, false);
      const p = await run(req, async (tx) => {
        await open(tx, id);
        return d.records.putPreferences(tx, metaOf(req), id, version, req.body);
      });
      send(res, 200, p, p.rowVersion === null ? {} : { ETag: etag(p.rowVersion) });
    }

    @Get('patients/:patientId/proxies')
    @Route({ permission: 'patient', resolver: 'patient' })
    async proxies(
      @Param('patientId') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      send(res, 200, itemsOf(await run(req, (tx) => d.proxies.listForPatient(tx, id))));
    }

    /** Blocked on D-7 (RA-R1-20b): without the verification rule values the request is refused, not queued. */
    @Post('patients/:patientId/proxy-requests')
    @Route({ permission: 'patient', resolver: 'patient' })
    proxyRequest(): Promise<void> {
      if (d.proxyRulesConfigured !== true) throw new ProxyRulesNotConfiguredError();
      throw new ProxyRulesNotConfiguredError();
    }

    @Delete('patients/:patientId/proxies/:grantId')
    @Route({ permission: 'patient', resolver: 'patient' })
    async revokeProxy(
      @Param('patientId') id: string,
      @Param('grantId') grantId: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      const ok = await run(req, async (tx) => {
        await open(tx, id);
        // the grant must be one of THIS patient's: the policy limits to the caller's own patients, the id check ties it to the path
        const g = (await d.proxies.listForPatient(tx, id)).find((x) => x.id === grantId);
        if (g === undefined) return false;
        return d.proxies.revokeByPatient(tx, grantId);
      });
      if (!ok) throw new PatientNotFoundError();
      res.status(204).end();
    }

    @Post('consents/:consentId/sign')
    @Route({ permission: 'patient', resolver: 'consent' })
    async signConsent(
      @Param('consentId') consentId: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      await idempotent(
        req,
        res,
        'POST /consents/{consentId}/sign',
        [consentId],
        req.body,
        async (tx) => {
          const patientId = await d.records.consentPatient(tx, consentId);
          if (patientId === undefined) throw new PatientNotFoundError();
          await open(tx, patientId);
          const c = await d.records.signConsent(tx, metaOf(req), consentId, req.body);
          return { status: 200, body: c };
        },
      );
    }
  }

  // ===== staff portal (29.3) ===================================================================================================

  @Controller('api/v1')
  class PatientStaffController {
    @Post('patients/search')
    @Route({ permission: 'patient.read', resolver: 'none' })
    async search(@ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      const rows = await run(req, (tx) =>
        d.patients.search(tx, metaOf(req), (req.body ?? {}) as never),
      );
      send(res, 200, itemsOf(rows.map(profileBody)));
    }

    @Post('patients/lookup')
    @Route({ permission: 'patient.lookup', resolver: 'none' })
    async lookup(@ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      // The counter is the handler's first statement: 30 calls a minute per principal, a counter of its own (31.3, draft 8.3).
      const hit = await d.limiter.hit(
        `patient.lookup:${requireAuthContext(req).session.principalId}`,
        30,
        60_000,
      );
      if (!hit.allowed) throw new PatientRateLimitedError(hit.retryAfterSeconds);
      send(res, 200, await run(req, (tx) => d.patients.lookup(tx, metaOf(req), req.body)));
    }

    @Post('patients/match')
    @Route({ permission: 'patient.match', resolver: 'location-body' })
    async match(@ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      const b = (req.body ?? {}) as Record<string, unknown>;
      send(
        res,
        200,
        await run(req, (tx) => d.patients.matchCandidates(tx, metaOf(req), b, b['locationId'])),
      );
    }

    @Post('patients')
    @Route({ permission: 'patient.register', resolver: 'location-body' })
    async register(@ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      await idempotent(req, res, 'POST /patients', [], req.body, async (tx) => {
        const r = await d.patients.register(tx, metaOf(req), (req.body ?? {}) as never);
        return {
          status: 201,
          body: { patientId: r.patientId, mrn: r.mrn, duplicateFlags: r.duplicateFlags },
          location: `/api/v1/patients/${r.patientId}`,
        };
      });
    }

    @Post('patients/:patientId/attach')
    @Route({ permission: 'patient.attach', resolver: 'location-body' })
    async attach(
      @Param('patientId') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      await idempotent(
        req,
        res,
        'POST /patients/{patientId}/attach',
        [id],
        req.body,
        async (tx) => {
          const b = (req.body ?? {}) as Record<string, unknown>;
          const r = await d.patients.attach(tx, metaOf(req), {
            patientId: id,
            candidateRef: b['candidateRef'],
            locationId: b['locationId'],
            patientPresent: b['patientPresent'],
          });
          return { status: 200, body: r };
        },
      );
    }

    @Get('patients/:patientId')
    @Route({ permission: 'patient.read', resolver: 'patient' })
    async get(
      @Param('patientId') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      const out = await run(req, async (tx) => {
        const p = await d.patients.view(tx, metaOf(req), id);
        if (p === undefined) throw new PatientNotFoundError();
        return { p, banner: (await d.patients.patientBanner(tx, id)) as PatientBanner };
      });
      send(
        res,
        200,
        { patientBanner: out.banner, patient: profileBody(out.p) },
        { ETag: etag(out.p.rowVersion) },
      );
    }

    @Get('patients/:patientId/banner')
    @Route({ permission: 'patient.read', resolver: 'patient' })
    async banner(
      @Param('patientId') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      const b = await run(req, (tx) => d.patients.patientBanner(tx, id));
      if (b === undefined) throw new PatientNotFoundError();
      send(res, 200, { patientBanner: b });
    }

    @Patch('patients/:patientId')
    @Route({ permission: 'patient.update', resolver: 'patient' })
    async patch(
      @Param('patientId') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      const version = ifMatchVersion(req) as number;
      const rec = await run(req, async (tx) => {
        await open(tx, id);
        return d.patients.updateProfile(tx, metaOf(req), id, version, req.body);
      });
      send(res, 200, profileBody(rec), { ETag: etag(rec.rowVersion) });
    }

    @Put('insurance-coverages/:id/eligibility')
    @Route({ permission: 'patient.insurance.verify', resolver: 'coverage' })
    async eligibility(
      @Param('id') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      const version = ifMatchVersion(req) as number;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const c = await run(req, async (tx) => {
        const patientId = await d.records.coveragePatient(tx, id);
        if (patientId === undefined) throw new PatientNotFoundError();
        await open(tx, patientId);
        return d.records.recordEligibility(tx, metaOf(req), id, version, body['status']);
      });
      send(
        res,
        200,
        { status: c.eligibilityStatus, verifiedAt: c.verifiedAt },
        { ETag: etag(c.rowVersion) },
      );
    }

    @Get('patients/:patientId/consents')
    @Route({ permission: 'patient.read', resolver: 'patient' })
    async consents(
      @Param('patientId') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      send(res, 200, itemsOf(await run(req, (tx) => d.records.listConsents(tx, id))));
    }

    @Get('patients/:patientId/care-team')
    @Route({ permission: 'patient.care_team.manage', resolver: 'patient' })
    async careTeam(
      @Param('patientId') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      send(res, 200, itemsOf(await run(req, (tx) => d.records.listCareTeam(tx, id))));
    }

    @Post('patients/:patientId/care-team')
    @Route({ permission: 'patient.care_team.manage', resolver: 'patient' })
    async addCareTeam(
      @Param('patientId') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      await idempotent(
        req,
        res,
        'POST /patients/{patientId}/care-team',
        [id],
        req.body,
        async (tx) => {
          await open(tx, id);
          const m = await d.records.addCareTeamMember(tx, metaOf(req), id, req.body);
          return { status: 201, body: m, location: `/api/v1/patients/${id}/care-team` };
        },
      );
    }

    @Delete('patients/:patientId/care-team/:memberId')
    @Route({ permission: 'patient.care_team.manage', resolver: 'patient' })
    async endCareTeam(
      @Param('patientId') id: string,
      @Param('memberId') memberId: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      await run(req, async (tx) => {
        await open(tx, id);
        await d.records.endCareTeamMember(tx, metaOf(req), id, memberId);
      });
      res.status(204).end();
    }

    @Get('duplicate-flags')
    @Route({ permission: 'patient.match', resolver: 'location-query' })
    async duplicateFlags(@ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      send(
        res,
        200,
        itemsOf(
          await run(req, (tx) =>
            d.records.listDuplicateFlags(tx, {
              locationId: req.query['locationId'],
              status: req.query['status'],
            }),
          ),
        ),
      );
    }
  }

  // ===== admin (29.4): the compliance slice ========================================================================================

  @Controller('api/v1/admin')
  class PatientAdminController {
    @Get('consents')
    @Route({ permission: 'patient.consent.read', resolver: 'none', realm: 'admin_pool' })
    async consents(@ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      const limit = typeof req.query['limit'] === 'string' ? Number(req.query['limit']) : undefined;
      const items = await run(req, (tx) =>
        d.records.sliceConsents(tx, {
          referenceId: req.query['referenceId'],
          ...(limit === undefined ? {} : { limit }),
        }),
      );
      send(res, 200, itemsOf(items));
    }

    @Post('patient-labels')
    @Route({ permission: 'patient.label.read', resolver: 'none', realm: 'admin_pool' })
    async label(@ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      const ctx = requireAuthContext(req);
      const principal = ctx.session.principalId;
      const limit = d.labelLimitPerHour ?? 60;
      const hit = await d.limiter.hit(`patient.label:${principal}`, limit, 3_600_000);
      if (!hit.allowed) throw new PatientRateLimitedError(hit.retryAfterSeconds);
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (!isUuid(b['patientId'])) throw new PatientValidationError(['patientId']);
      const label = await run(req, (tx) =>
        d.patients.identityLabel(tx, metaOf(req), b['patientId'] as string, {
          type: b['referenceType'],
          id: b['referenceId'],
        }),
      );
      send(res, 200, label);
    }
  }

  return [PatientPortalController, PatientStaffController, PatientAdminController];
}
