// The front-door routes of ARCHITECTURE 29.2 and 29.3. Each declares {permission, resolver} (BD-07); by the time a handler runs the
// guard has authenticated, checked CSRF, the realm, the patient scope and the permission at the resource's location, and the
// handler opens the one transaction under the caller's scope, so row-level security is the second line.
//
//   POST /check-ins/{id}/vitals                       clinical.vitals.record        Idem; banner: true   (VitalsService, BE-16)
//   POST /check-ins/{id}/triage                       clinical.triage.record        Idem; If-Match once assessed; banner: true
//   GET  /check-ins/{id}/triage                       clinical.chart.read_previsit  ETag = number of assessments
//   GET  /patients/{id}/questionnaire-responses       clinical.chart.read_previsit  banner: true
//   POST /patients/{id}/referrals, GET …/referrals    clinical.referral.manage      Idem
//   GET/PATCH /referrals/{id}, POST …/send            clinical.referral.manage      PATCH: If-Match; send: Idem
//   GET  /locations/{id}/referral-inbox               clinical.referral.manage      PHI-minimal
//   POST /referrals/{id}/accept | decline             clinical.referral.manage      target location; Idem
//   POST /patients/{id}/follow-ups, GET …/follow-ups  clinical.referral.manage      Idem  (no separate follow-up permission exists)
//   GET  /locations/{id}/follow-ups, PATCH /follow-ups/{id}                          PATCH: If-Match
//   patient realm: GET /appointments/{id}/questionnaire, PUT /questionnaire-responses/{id} (If-Match once it exists),
//                  POST /questionnaire-responses/{id}/submit (Idem; If-Match)
// Additive to the 29.3 table: the GET reads and `GET /appointments/{id}/questionnaire`, which the table's "Questionnaire (template +
// response)" column of `previsit` needs; the scheduling module's own `previsit` route returns the three flags only.
import {
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req as ReqParam,
  Res as ResParam,
} from '@nestjs/common';
import type { Type } from '@nestjs/common';
import type { KernelDb, Tx } from '@ehr/kernel';
import { ApiError } from '../../../platform/errors.js';
import type { Req, Res } from '../../../platform/http.js';
import { Route } from '../../../platform/route.js';
import { requireAuthContext } from '../../identity/index.js';
import type { AuthContext, ResourceResolver } from '../../identity/index.js';
import { ifMatchVersion } from '../../patient/index.js';
import type { BannerService } from '../chart/banner.js';
import { etag, idempotentWrite, metaOf, send } from '../chart/http.js';
import type { VitalsService } from '../chart/vitals.js';
import { FrontdoorNotFoundError } from './errors.js';
import { isUuid } from './ids.js';
import type { FollowUpService } from './followups.js';
import type { CheckInPort } from './ports.js';
import type { QuestionnaireService } from './questionnaire.js';
import type { ReferralService } from './referrals.js';
import type { TriageService } from './triage.js';
import type { PatientBannerView } from '../chart/types.js';

export interface FrontdoorControllerDeps {
  db: KernelDb;
  banner: BannerService;
  vitals: VitalsService;
  checkIns: CheckInPort;
  questionnaires: QuestionnaireService;
  triage: TriageService;
  referrals: ReferralService;
  followUps: FollowUpService;
}

const pathId = (req: Req, segment: string): string | undefined => {
  const m = new RegExp(`/${segment}/([0-9a-f-]{36})(?:/|$)`, 'i').exec(req.path);
  return m?.[1] !== undefined && isUuid(m[1]) ? m[1].toLowerCase() : undefined;
};

/** Resolvers (27.1): the resource's patient and place as the caller's own RLS shows it, `undefined` otherwise (404). */
export function frontdoorResolvers(): Record<string, ResourceResolver> {
  const bySql =
    (segment: string, sql: string, withPatient: boolean): ResourceResolver =>
    async (req, _ctx, tx) => {
      const id = pathId(req, segment);
      if (id === undefined) return undefined;
      const row = (await tx.query(sql, [id])).rows[0] as Record<string, unknown> | undefined;
      if (row === undefined) return undefined;
      return {
        ...(withPatient ? { patientId: String(row['patient_id']) } : {}),
        ...(row['location_id'] !== null && row['location_id'] !== undefined
          ? { locationId: String(row['location_id']) }
          : {}),
      };
    };
  return {
    // /check-ins/{id}/...
    'frontdoor-checkin': bySql(
      'check-ins',
      `SELECT patient_id, location_id FROM scheduling.check_in WHERE id = $1::uuid`,
      true,
    ),
    // /referrals/{id}/...: the referring location, or (an accepted referral, completed by the receiving side) the receiving one
    'frontdoor-referral': bySql(
      'referrals',
      `SELECT patient_id, CASE WHEN status = 'accepted' THEN target_location_id ELSE from_location_id END AS location_id
         FROM clinical.referral WHERE id = $1::uuid`,
      true,
    ),
    // /referrals/{id}/accept|decline: the receiving location, from its own inbox row; no patient (the caller has no relationship yet)
    'frontdoor-referral-target': bySql(
      'referrals',
      `SELECT NULL::uuid AS patient_id, target_location_id AS location_id FROM clinical.referral_inbox WHERE referral_id = $1::uuid`,
      false,
    ),
    // /follow-ups/{id}
    'frontdoor-follow-up': bySql(
      'follow-ups',
      `SELECT patient_id, location_id FROM clinical.follow_up WHERE id = $1::uuid`,
      true,
    ),
    // /locations/{id}/...
    'frontdoor-location': async (req, _ctx, tx) => {
      const id = pathId(req, 'locations');
      if (id === undefined) return undefined;
      const r = await tx.query(`SELECT id FROM organisation.location WHERE id = $1::uuid`, [id]);
      return r.rows.length === 0 ? undefined : { locationId: id };
    },
    // PUT/POST /questionnaire-responses/{id}...: the patient of the response, or (a first save) of the reservation the body names
    'frontdoor-response': async (req, _ctx, tx) => {
      const id = pathId(req, 'questionnaire-responses');
      if (id !== undefined) {
        const r = (
          await tx.query(
            `SELECT patient_id FROM clinical.questionnaire_response WHERE id = $1::uuid`,
            [id],
          )
        ).rows[0] as Record<string, unknown> | undefined;
        if (r !== undefined) return { patientId: String(r['patient_id']) };
      }
      const rid = (req.body as Record<string, unknown> | undefined)?.['reservationId'];
      if (!isUuid(rid) || req.method !== 'PUT') return undefined;
      const r = (
        await tx.query(`SELECT patient_id FROM scheduling.slot_reservation WHERE id = $1::uuid`, [
          rid.toLowerCase(),
        ])
      ).rows[0] as Record<string, unknown> | undefined;
      return r === undefined ? undefined : { patientId: String(r['patient_id']) };
    },
  };
}

export function createFrontdoorControllers(d: FrontdoorControllerDeps): Type<unknown>[] {
  const run = <T>(req: Req, fn: (tx: Tx, ctx: AuthContext) => Promise<T>): Promise<T> => {
    const ctx = requireAuthContext(req);
    return d.db.withScope(ctx.scope, (tx) => fn(tx, ctx));
  };
  const body = (req: Req): Record<string, unknown> => {
    const b = req.body;
    if (b === null || typeof b !== 'object' || Array.isArray(b))
      throw new ApiError(422, 'kernel.validation_failed');
    return b as Record<string, unknown>;
  };
  const bannerOf = async (
    tx: Tx,
    ctx: AuthContext,
    req: Req,
    patientId: string,
  ): Promise<PatientBannerView> => {
    const b = await d.banner.bannerFor(tx, ctx, metaOf(req), patientId);
    if (b === undefined) throw new FrontdoorNotFoundError();
    return b;
  };
  const idem = (
    req: Req,
    res: Res,
    template: string,
    ids: string[],
    fn: (
      tx: Tx,
      ctx: AuthContext,
    ) => Promise<{
      status: number;
      body: unknown;
      location?: string;
      headers?: Record<string, string>;
    }>,
  ): Promise<void> =>
    idempotentWrite(
      d.db,
      req,
      res,
      template,
      ids.map((x) => x.toLowerCase()),
      (tx) => fn(tx, requireAuthContext(req)),
    );

  @Controller('api/v1')
  class FrontdoorStaffController {
    // --- vitals and triage ------------------------------------------------------------------------------------------
    @Post('check-ins/:id/vitals')
    @Route({ permission: 'clinical.vitals.record', resolver: 'frontdoor-checkin' })
    async vitals(
      @Param('id') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      await idem(req, res, 'POST /check-ins/{id}/vitals', [id], async (tx, ctx) => {
        const ci = await d.checkIns.get(tx, id.toLowerCase());
        if (ci === undefined) throw new FrontdoorNotFoundError();
        const b = body(req);
        const out = await d.vitals.recordVitals(tx, metaOf(req), {
          patientId: ci.patientId,
          checkInId: ci.checkInId,
          vitals: Array.isArray(b['vitals']) ? (b['vitals'] as never[]) : [],
        });
        return {
          status: 201,
          body: { ...out, patientBanner: await bannerOf(tx, ctx, req, ci.patientId) },
        };
      });
    }

    @Post('check-ins/:id/triage')
    @Route({ permission: 'clinical.triage.record', resolver: 'frontdoor-checkin' })
    async recordTriage(
      @Param('id') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      const ifMatch = ifMatchVersion(req, false);
      await idem(req, res, 'POST /check-ins/{id}/triage', [id], async (tx, ctx) => {
        const r = await d.triage.record(tx, metaOf(req), id, body(req), ifMatch);
        return {
          status: 201,
          body: {
            category: r.category,
            redFlag: r.redFlag,
            ...(r.alertId === null ? {} : { alertId: r.alertId }),
            ...(r.advice === undefined ? {} : { advice: r.advice }),
            triage: r.triage,
            patientBanner: await bannerOf(tx, ctx, req, r.triage.patientId),
          },
          headers: { ETag: etag(r.chainLength) },
        };
      });
    }

    @Get('check-ins/:id/triage')
    @Route({ permission: 'clinical.chart.read_previsit', resolver: 'frontdoor-checkin' })
    async currentTriage(
      @Param('id') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      const out = await run(req, async (tx, ctx) => {
        const cur = await d.triage.current(tx, metaOf(req), id);
        return {
          triage: cur.triage,
          chainLength: cur.chainLength,
          ...(cur.triage === null
            ? {}
            : { patientBanner: await bannerOf(tx, ctx, req, cur.triage.patientId) }),
        };
      });
      send(
        res,
        200,
        {
          triage: out.triage,
          ...(out.patientBanner === undefined ? {} : { patientBanner: out.patientBanner }),
        },
        { ETag: etag(out.chainLength) },
      );
    }

    @Get('patients/:patientId/questionnaire-responses')
    @Route({ permission: 'clinical.chart.read_previsit', resolver: 'chart-patient' })
    async responses(
      @Param('patientId') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      const out = await run(req, async (tx, ctx) => ({
        items: await d.questionnaires.listForPatient(tx, ctx, metaOf(req), id),
        patientBanner: await bannerOf(tx, ctx, req, id),
      }));
      send(res, 200, { items: out.items, nextCursor: null, patientBanner: out.patientBanner });
    }

    // --- referrals --------------------------------------------------------------------------------------------------
    @Post('patients/:patientId/referrals')
    @Route({ permission: 'clinical.referral.manage', resolver: 'chart-patient' })
    async createReferral(
      @Param('patientId') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      await idem(req, res, 'POST /patients/{patientId}/referrals', [id], async (tx, ctx) => {
        const r = await d.referrals.create(tx, ctx, metaOf(req), id, body(req));
        return {
          status: 201,
          body: r,
          location: `/api/v1/referrals/${r.id}`,
          headers: { ETag: etag(r.version) },
        };
      });
    }

    @Get('patients/:patientId/referrals')
    @Route({ permission: 'clinical.referral.manage', resolver: 'chart-patient' })
    async listReferrals(
      @Param('patientId') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      send(res, 200, {
        items: await run(req, (tx, ctx) => d.referrals.listForPatient(tx, ctx, metaOf(req), id)),
        nextCursor: null,
      });
    }

    @Get('referrals/:id')
    @Route({ permission: 'clinical.referral.manage', resolver: 'frontdoor-referral' })
    async getReferral(
      @Param('id') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      const r = await run(req, (tx, ctx) => d.referrals.get(tx, ctx, metaOf(req), id));
      send(res, 200, r, { ETag: etag(r.version) });
    }

    @Patch('referrals/:id')
    @Route({ permission: 'clinical.referral.manage', resolver: 'frontdoor-referral' })
    async patchReferral(
      @Param('id') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      const v = ifMatchVersion(req) as number;
      const r = await run(req, (tx, ctx) =>
        d.referrals.update(tx, ctx, metaOf(req), id, v, body(req)),
      );
      send(res, 200, r, { ETag: etag(r.version) });
    }

    @Post('referrals/:id/send')
    @Route({ permission: 'clinical.referral.manage', resolver: 'frontdoor-referral' })
    async sendReferral(
      @Param('id') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      await idem(req, res, 'POST /referrals/{id}/send', [id], async (tx, ctx) => {
        const r = await d.referrals.send(
          tx,
          ctx,
          metaOf(req),
          id,
          req.body === undefined ? {} : body(req),
        );
        return { status: 200, body: r, headers: { ETag: etag(r.version) } };
      });
    }

    @Get('locations/:locationId/referral-inbox')
    @Route({ permission: 'clinical.referral.manage', resolver: 'frontdoor-location' })
    async inbox(
      @Param('locationId') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      send(res, 200, {
        items: await run(req, (tx, ctx) => d.referrals.inbox(tx, ctx, metaOf(req), id)),
        nextCursor: null,
      });
    }

    @Post('referrals/:id/accept')
    @Route({ permission: 'clinical.referral.manage', resolver: 'frontdoor-referral-target' })
    async accept(
      @Param('id') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      await idem(req, res, 'POST /referrals/{id}/accept', [id], async (tx, ctx) => ({
        status: 200,
        body: await d.referrals.accept(tx, ctx, metaOf(req), id),
      }));
    }

    @Post('referrals/:id/decline')
    @Route({ permission: 'clinical.referral.manage', resolver: 'frontdoor-referral-target' })
    async decline(
      @Param('id') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      await idem(req, res, 'POST /referrals/{id}/decline', [id], async (tx, ctx) => ({
        status: 200,
        body: await d.referrals.decline(tx, ctx, metaOf(req), id, body(req)),
      }));
    }

    // --- follow-ups -------------------------------------------------------------------------------------------------
    @Post('patients/:patientId/follow-ups')
    @Route({ permission: 'clinical.referral.manage', resolver: 'chart-patient' })
    async createFollowUp(
      @Param('patientId') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      await idem(req, res, 'POST /patients/{patientId}/follow-ups', [id], async (tx, ctx) => {
        const r = await d.followUps.create(tx, ctx, metaOf(req), id, body(req));
        return {
          status: 201,
          body: r,
          location: `/api/v1/follow-ups/${r.id}`,
          headers: { ETag: etag(r.version) },
        };
      });
    }

    @Get('patients/:patientId/follow-ups')
    @Route({ permission: 'clinical.referral.manage', resolver: 'chart-patient' })
    async listFollowUps(
      @Param('patientId') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      send(res, 200, {
        items: await run(req, (tx, ctx) => d.followUps.listForPatient(tx, ctx, metaOf(req), id)),
        nextCursor: null,
      });
    }

    @Get('locations/:locationId/follow-ups')
    @Route({ permission: 'clinical.referral.manage', resolver: 'frontdoor-location' })
    async listLocationFollowUps(
      @Param('locationId') id: string,
      @Query() q: Record<string, unknown>,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      const status = typeof q['status'] === 'string' ? q['status'] : undefined;
      send(res, 200, {
        items: await run(req, (tx, ctx) =>
          d.followUps.listForLocation(tx, ctx, metaOf(req), id, status),
        ),
        nextCursor: null,
      });
    }

    @Patch('follow-ups/:id')
    @Route({ permission: 'clinical.referral.manage', resolver: 'frontdoor-follow-up' })
    async patchFollowUp(
      @Param('id') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      const v = ifMatchVersion(req) as number;
      const r = await run(req, (tx, ctx) =>
        d.followUps.update(tx, ctx, metaOf(req), id, v, body(req)),
      );
      send(res, 200, r, { ETag: etag(r.version) });
    }
  }

  @Controller('api/v1')
  class FrontdoorPatientController {
    @Get('appointments/:id/questionnaire')
    @Route({ permission: 'patient', resolver: 'reservation' })
    async forVisit(
      @Param('id') id: string,
      @Query() q: Record<string, unknown>,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      const key = typeof q['templateKey'] === 'string' ? q['templateKey'] : undefined;
      const r = await run(req, (tx) => d.questionnaires.forVisit(tx, metaOf(req), id, key));
      send(res, 200, r, r.response === null ? {} : { ETag: etag(r.response.version) });
    }

    @Put('questionnaire-responses/:id')
    @Route({ permission: 'patient', resolver: 'frontdoor-response' })
    async save(@Param('id') id: string, @ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      const v = ifMatchVersion(req, false);
      const r = await run(req, (tx) =>
        d.questionnaires.saveDraft(tx, metaOf(req), id, body(req), v),
      );
      send(res, v === undefined ? 201 : 200, r, { ETag: etag(r.version) });
    }

    @Post('questionnaire-responses/:id/submit')
    @Route({ permission: 'patient', resolver: 'frontdoor-response' })
    async submit(
      @Param('id') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      const v = ifMatchVersion(req) as number;
      await idem(req, res, 'POST /questionnaire-responses/{id}/submit', [id], async (tx) => {
        const r = await d.questionnaires.submit(tx, metaOf(req), id, v);
        return {
          status: 200,
          body: {
            redFlag: r.redFlag,
            ...(r.advice === undefined ? {} : { advice: r.advice }),
            response: r.response,
          },
          headers: { ETag: etag(r.response.version) },
        };
      });
    }
  }

  return [FrontdoorStaffController, FrontdoorPatientController];
}
