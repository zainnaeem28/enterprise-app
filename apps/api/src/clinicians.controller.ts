// `GET /api/v1/clinicians?serviceId=&locationId=`: the patient-readable clinician list the booking UI calls for the doctor step. Same
// rule as the anonymous `/public/v1/clinicians` (listed, active clinicians with an unended availability template, eligible for the
// service, the service offered at the location), but under the caller's own scope, after the guard authenticated a patient
// (`patient` capability, no resource). Anything unknown is absent, not an error, so the route is no oracle.
import { Controller, Get, Req as ReqParam, Res as ResParam } from '@nestjs/common';
import type { Type } from '@nestjs/common';
import type { KernelDb, ScopeSettings, Tx } from '@ehr/kernel';
import { ApiError } from './platform/errors.js';
import type { Req, Res } from './platform/http.js';
import { Route } from './platform/route.js';

export interface PatientCliniciansDeps {
  db: KernelDb;
  organisation: {
    directoryServices(tx: Tx, filter?: { locationId?: string }): Promise<{ id: string }[]>;
    directoryServiceClinicians(tx: Tx, serviceId: string): Promise<string[]>;
  };
  scheduling: {
    directoryClinicianLocations(
      tx: Tx,
      locationId?: string | null,
    ): Promise<{ clinicianId: string; locationId: string }[]>;
  };
  scopeOf: (req: Req) => ScopeSettings;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidParam(req: Req, name: string): string | undefined {
  const v = req.query[name];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !UUID.test(v))
    throw new ApiError(400, 'kernel.validation_failed', false, {
      errors: [{ path: `/${name}`, code: 'kernel.invalid_format' }],
    });
  return v.toLowerCase();
}

export function createPatientCliniciansControllers(d: PatientCliniciansDeps): Type<unknown>[] {
  @Controller('api/v1')
  class PatientCliniciansController {
    @Get('clinicians')
    @Route({ permission: 'patient', resolver: 'none' })
    async clinicians(@ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      for (const k of Object.keys(req.query))
        if (k !== 'serviceId' && k !== 'locationId')
          throw new ApiError(400, 'kernel.validation_failed', false, {
            errors: [{ path: `/${k}`, code: 'kernel.unknown_field' }],
          });
      const serviceId = uuidParam(req, 'serviceId');
      const locationId = uuidParam(req, 'locationId');
      const items = await d.db.withScope(
        d.scopeOf(req),
        async (tx) => {
          await tx.query('SET LOCAL transaction_read_only = on');
          if (serviceId !== undefined && locationId !== undefined) {
            const offered = await d.organisation.directoryServices(tx, { locationId });
            if (!offered.some((s) => s.id === serviceId)) return [];
          }
          const eligible =
            serviceId === undefined
              ? null
              : new Set(await d.organisation.directoryServiceClinicians(tx, serviceId));
          if (eligible !== null && eligible.size === 0) return [];
          const bookable = new Set(
            (await d.scheduling.directoryClinicianLocations(tx, locationId ?? null)).map(
              (p) => p.clinicianId,
            ),
          );
          if (bookable.size === 0) return [];
          const listed = await tx.query(
            `SELECT principal_id, display_name FROM identity.public_clinician ORDER BY display_name, principal_id`,
          );
          const out: { clinicianId: string; displayName: string }[] = [];
          for (const r of listed.rows) {
            const id = String(r['principal_id']);
            if (!bookable.has(id) || (eligible !== null && !eligible.has(id))) continue;
            out.push({ clinicianId: id, displayName: String(r['display_name']) });
          }
          return out;
        },
        { idempotent: true },
      );
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ items, nextCursor: null });
    }
  }
  return [PatientCliniciansController];
}
