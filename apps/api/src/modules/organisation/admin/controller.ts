// The organisation routes of ARCHITECTURE 29.4 under `staff./api/v1/admin` (realm `admin_pool`). The route table below is the
// contract in packages/contracts/openapi/organisation.yaml: permission per resource, `If-Match` on every PATCH, one 200 response
// shape. EVERY route requires a live elevation grant (BE-23 acceptance): the contract lists the template reads and drafts as not
// elevated, but their permission is `needsElevation` in the catalogue, so the guard demands the grant for them as well. The guard has
// already authenticated the session, checked the permission and the live elevation grant (C1) before a handler runs; the
// handlers repeat none of it. Responses are `no-store`.
import {
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Req as ReqParam,
  Res as ResParam,
} from '@nestjs/common';
import type { Type } from '@nestjs/common';
import type { ScopeSettings } from '@ehr/kernel';
import type { Req, Res } from '../../../platform/http.js';
import { Route } from '../../../platform/route.js';
import type { Meta, One, OrganisationAdminService, Page } from './service.js';

export interface AdminControllerDeps {
  service: OrganisationAdminService;
  /** The caller's transaction scope from the guard's authenticated context (supplied by the composition root: organisation sits below identity). */
  scopeOf: (req: Req) => ScopeSettings;
}

const metaOf = (req: Req): Meta => ({
  requestId: req.requestId ?? null,
  ip: req.ip ?? null,
  userAgent: req.header('user-agent') ?? null,
});

const route = (permission: string) =>
  Route({ permission, resolver: 'none', realm: 'admin_pool', elevation: true });

const LOCATION = 'organisation.location.manage';
const SERVICE = 'organisation.service.manage';
const POLICY = 'organisation.policy.manage';
const TEMPLATE = 'organisation.template.manage';
const FLAG = 'organisation.flag.manage';
const BANNER = 'organisation.banner.manage';
const SETTING = 'organisation.setting.manage';
const STATE = 'organisation.operating_state.manage';
const STAFF_PROFILE = 'identity.staff_profile.manage';

export function createOrganisationAdminController(d: AdminControllerDeps): Type<unknown> {
  const s = d.service;
  const page = (res: Res, p: Page): Page => {
    res.setHeader('Cache-Control', 'no-store');
    return p;
  };
  const one = (res: Res, o: One): Record<string, unknown> => {
    res.setHeader('Cache-Control', 'no-store');
    if (o.etag !== null) res.setHeader('ETag', o.etag);
    return o.body;
  };
  const q = (req: Req): Record<string, unknown> => req.query;
  const ifMatch = (req: Req): string | undefined => req.header('if-match');

  @Controller('api/v1/admin')
  class OrganisationAdminController {
    // --- locations, rooms, opening hours, holidays (organisation.location.manage) --------------------------------------

    @Get('locations')
    @route(LOCATION)
    async listLocations(@ReqParam() req: Req, @ResParam({ passthrough: true }) res: Res) {
      return page(res, await s.listLocations(d.scopeOf(req), q(req)));
    }
    @Post('locations')
    @HttpCode(200)
    @route(LOCATION)
    async createLocation(@ReqParam() req: Req, @ResParam({ passthrough: true }) res: Res) {
      return one(res, await s.createLocation(d.scopeOf(req), req.body, metaOf(req)));
    }
    @Patch('locations')
    @HttpCode(200)
    @route(LOCATION)
    async patchLocation(@ReqParam() req: Req, @ResParam({ passthrough: true }) res: Res) {
      return one(res, await s.patchLocation(d.scopeOf(req), req.body, ifMatch(req), metaOf(req)));
    }

    @Get('rooms')
    @route(LOCATION)
    async listRooms(@ReqParam() req: Req, @ResParam({ passthrough: true }) res: Res) {
      return page(res, await s.listRooms(d.scopeOf(req), q(req)));
    }
    @Post('rooms')
    @HttpCode(200)
    @route(LOCATION)
    async createRoom(@ReqParam() req: Req, @ResParam({ passthrough: true }) res: Res) {
      return one(res, await s.createRoom(d.scopeOf(req), req.body, metaOf(req)));
    }
    @Patch('rooms')
    @HttpCode(200)
    @route(LOCATION)
    async patchRoom(@ReqParam() req: Req, @ResParam({ passthrough: true }) res: Res) {
      return one(res, await s.patchRoom(d.scopeOf(req), req.body, ifMatch(req), metaOf(req)));
    }

    @Get('opening-hours')
    @route(LOCATION)
    async listOpeningHours(@ReqParam() req: Req, @ResParam({ passthrough: true }) res: Res) {
      return page(res, await s.listOpeningHours(d.scopeOf(req), q(req)));
    }
    @Post('opening-hours')
    @HttpCode(200)
    @route(LOCATION)
    async createOpeningHours(@ReqParam() req: Req, @ResParam({ passthrough: true }) res: Res) {
      return one(res, await s.createOpeningHours(d.scopeOf(req), req.body, metaOf(req)));
    }
    @Patch('opening-hours')
    @HttpCode(200)
    @route(LOCATION)
    async patchOpeningHours(@ReqParam() req: Req, @ResParam({ passthrough: true }) res: Res) {
      return one(
        res,
        await s.patchOpeningHours(d.scopeOf(req), req.body, ifMatch(req), metaOf(req)),
      );
    }

    @Get('holidays')
    @route(LOCATION)
    async listHolidays(@ReqParam() req: Req, @ResParam({ passthrough: true }) res: Res) {
      return page(res, await s.listHolidays(d.scopeOf(req), q(req)));
    }
    @Post('holidays')
    @HttpCode(200)
    @route(LOCATION)
    async createHoliday(@ReqParam() req: Req, @ResParam({ passthrough: true }) res: Res) {
      return one(res, await s.createHoliday(d.scopeOf(req), req.body, metaOf(req)));
    }
    @Patch('holidays')
    @HttpCode(200)
    @route(LOCATION)
    async patchHoliday(@ReqParam() req: Req, @ResParam({ passthrough: true }) res: Res) {
      return one(res, await s.patchHoliday(d.scopeOf(req), req.body, ifMatch(req), metaOf(req)));
    }

    // --- services and booking policies -------------------------------------------------------------------------------------------

    @Get('services')
    @route(SERVICE)
    async listServices(@ReqParam() req: Req, @ResParam({ passthrough: true }) res: Res) {
      return page(res, await s.listServices(d.scopeOf(req), q(req)));
    }
    @Post('services')
    @HttpCode(200)
    @route(SERVICE)
    async createService(@ReqParam() req: Req, @ResParam({ passthrough: true }) res: Res) {
      return one(res, await s.createService(d.scopeOf(req), req.body, metaOf(req)));
    }
    @Patch('services')
    @HttpCode(200)
    @route(SERVICE)
    async patchService(@ReqParam() req: Req, @ResParam({ passthrough: true }) res: Res) {
      return one(res, await s.patchService(d.scopeOf(req), req.body, ifMatch(req), metaOf(req)));
    }

    @Get('booking-policies')
    @route(POLICY)
    async listPolicies(@ReqParam() req: Req, @ResParam({ passthrough: true }) res: Res) {
      return page(res, await s.listPolicies(d.scopeOf(req), q(req)));
    }
    @Post('booking-policies')
    @HttpCode(200)
    @route(POLICY)
    async createPolicy(@ReqParam() req: Req, @ResParam({ passthrough: true }) res: Res) {
      return one(res, await s.createPolicy(d.scopeOf(req), req.body, metaOf(req)));
    }
    @Patch('booking-policies')
    @HttpCode(200)
    @route(POLICY)
    async patchPolicy(@ReqParam() req: Req, @ResParam({ passthrough: true }) res: Res) {
      return one(res, await s.patchPolicy(d.scopeOf(req), req.body, ifMatch(req), metaOf(req)));
    }

    // --- templates ------------------------------------------------------------

    @Get('consent-templates')
    @route(TEMPLATE)
    async listConsent(@ReqParam() req: Req, @ResParam({ passthrough: true }) res: Res) {
      return page(res, await s.listConsentTemplates(d.scopeOf(req), q(req)));
    }
    @Post('consent-templates')
    @HttpCode(200)
    @route(TEMPLATE)
    async createConsent(@ReqParam() req: Req, @ResParam({ passthrough: true }) res: Res) {
      return one(res, await s.createConsentTemplate(d.scopeOf(req), req.body, metaOf(req)));
    }
    @Post('consent-templates/:id/publish')
    @HttpCode(200)
    @route(TEMPLATE)
    async publishConsent(
      @ReqParam() req: Req,
      @ResParam({ passthrough: true }) res: Res,
      @Param('id') id: string,
    ) {
      return one(res, await s.publishConsentTemplate(d.scopeOf(req), id, req.body, metaOf(req)));
    }

    @Get('questionnaire-templates')
    @route(TEMPLATE)
    async listQuestionnaire(@ReqParam() req: Req, @ResParam({ passthrough: true }) res: Res) {
      return page(res, await s.listQuestionnaireTemplates(d.scopeOf(req), q(req)));
    }
    @Post('questionnaire-templates')
    @HttpCode(200)
    @route(TEMPLATE)
    async createQuestionnaire(@ReqParam() req: Req, @ResParam({ passthrough: true }) res: Res) {
      return one(res, await s.createQuestionnaireTemplate(d.scopeOf(req), req.body, metaOf(req)));
    }
    @Post('questionnaire-templates/:id/publish')
    @HttpCode(200)
    @route(TEMPLATE)
    async publishQuestionnaire(
      @ReqParam() req: Req,
      @ResParam({ passthrough: true }) res: Res,
      @Param('id') id: string,
    ) {
      return one(
        res,
        await s.publishQuestionnaireTemplate(d.scopeOf(req), id, req.body, metaOf(req)),
      );
    }

    // --- flags, banners, settings, operating states --------------------------------------------------------------------------------

    @Get('feature-flags')
    @route(FLAG)
    async listFlags(@ReqParam() req: Req, @ResParam({ passthrough: true }) res: Res) {
      return page(res, await s.listFeatureFlags(d.scopeOf(req), q(req)));
    }
    @Put('feature-flags')
    @HttpCode(200)
    @route(FLAG)
    async putFlag(@ReqParam() req: Req, @ResParam({ passthrough: true }) res: Res) {
      return one(res, await s.putFeatureFlag(d.scopeOf(req), req.body, metaOf(req)));
    }

    @Get('banners')
    @route(BANNER)
    async listBanners(@ReqParam() req: Req, @ResParam({ passthrough: true }) res: Res) {
      return page(res, await s.listBanners(d.scopeOf(req), q(req)));
    }
    @Put('banners')
    @HttpCode(200)
    @route(BANNER)
    async putBanner(@ReqParam() req: Req, @ResParam({ passthrough: true }) res: Res) {
      return one(res, await s.putBanner(d.scopeOf(req), req.body, metaOf(req)));
    }

    @Get('settings')
    @route(SETTING)
    async listSettings(@ReqParam() req: Req, @ResParam({ passthrough: true }) res: Res) {
      return page(res, await s.listSettings(d.scopeOf(req), q(req)));
    }
    @Put('settings')
    @HttpCode(200)
    @route(SETTING)
    async putSetting(@ReqParam() req: Req, @ResParam({ passthrough: true }) res: Res) {
      return one(res, await s.putSetting(d.scopeOf(req), req.body, metaOf(req)));
    }

    @Get('operating-states')
    @route(STATE)
    async listStates(@ReqParam() req: Req, @ResParam({ passthrough: true }) res: Res) {
      return page(res, await s.listOperatingStates(d.scopeOf(req), q(req)));
    }
    @Put('operating-states')
    @HttpCode(200)
    @route(STATE)
    async putState(@ReqParam() req: Req, @ResParam({ passthrough: true }) res: Res) {
      return one(res, await s.putOperatingState(d.scopeOf(req), req.body, metaOf(req)));
    }

    // --- clinician licensed states (identity.staff_profile.manage; ruling C item 4) --------------------------------------
    @Get('staff-profiles/:principalId')
    @route(STAFF_PROFILE)
    async getLicensed(
      @ReqParam() req: Req,
      @ResParam({ passthrough: true }) res: Res,
      @Param('principalId') principalId: string,
    ) {
      return one(res, await s.getLicensedStates(d.scopeOf(req), principalId));
    }
    @Put('staff-profiles/:principalId')
    @HttpCode(200)
    @route(STAFF_PROFILE)
    async putLicensed(
      @ReqParam() req: Req,
      @ResParam({ passthrough: true }) res: Res,
      @Param('principalId') principalId: string,
    ) {
      return one(
        res,
        await s.putLicensedStates(d.scopeOf(req), principalId, req.body, metaOf(req)),
      );
    }
  }
  return OrganisationAdminController;
}
