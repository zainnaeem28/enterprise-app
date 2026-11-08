// The encounter and note routes of ARCHITECTURE 29.3. Each declares {permission, resolver} (BD-07); the guard has already authenticated,
// checked CSRF, the realm and the patient scope by the time a handler runs, and the handler opens the one transaction under the
// caller's scope, so row-level security is the second line and the triggers the third.
//
//   POST  /encounters                  clinical.consultation.start  Idem; body {reservationId, emergencyException?}; 409 consents_missing
//   POST  /encounters/{id}/complete    clinical.consultation.start  Idem; If-Match; 409 note_unsigned unless {deferNoteReason}
//   POST  /encounters/{id}/notes       clinical.note.write          Idem; {templateId?} draft from template
//   PATCH /notes/{id}                  clinical.note.write (author) If-Match; {sections}; 409 note_locked
//   POST  /notes/{id}/sign             clinical.note.write          Idem; If-Match; signs (clinical.note.sign) or submits (trainee);
//                                                                   401 auth.reauth_required
//   POST  /notes/{id}/cosign           clinical.note.cosign         Idem; the supervisor named; 403 clinical.cosign_not_supervisor
//   POST  /notes/{id}/addenda          clinical.note.write          Idem; {body}
//
// `sign` is declared with the WRITE permission because a trainee has no `clinical.note.sign` (27.3) and still submits; the service
// decides between signing, submitting and refusing (an assistant). Every response carries the patient banner (x-banner).
import { Controller, Param, Patch, Post, Req as ReqParam, Res as ResParam } from '@nestjs/common';
import type { Type } from '@nestjs/common';
import type { KernelDb, Tx } from '@ehr/kernel';
import { ApiError } from '../../../platform/errors.js';
import type { Req, Res } from '../../../platform/http.js';
import { Route } from '../../../platform/route.js';
import { requireAuthContext } from '../../identity/index.js';
import type { AuthContext, ResourceResolver } from '../../identity/index.js';
import { ifMatchVersion } from '../../patient/index.js';
import type { BannerService } from '../chart/banner.js';
import { NotesNotFoundError } from './errors.js';
import { etag, idempotentWrite, metaOf, send } from '../chart/http.js';
import { isUuid } from '../chart/ids.js';
import type { EncounterService } from './encounters.js';
import type { NoteService } from './notes.js';

export interface NotesControllerDeps {
  db: KernelDb;
  banner: BannerService;
  encounters: EncounterService;
  notes: NoteService;
}

const PATH_ENCOUNTER = /\/encounters\/([0-9a-f-]{36})(?:\/|$)/i;
const PATH_NOTE = /\/notes\/([0-9a-f-]{36})(?:\/|$)/i;

/** Resolvers (27.1): the encounter or note named in the path, or the reservation named in the body, found through the caller's own RLS. */
export function notesResolvers(): Record<string, ResourceResolver> {
  return {
    'reservation-body': async (req, _ctx, tx) => {
      const id = (req.body as Record<string, unknown> | undefined)?.['reservationId'];
      if (!isUuid(id)) return undefined;
      const r = await tx.query(
        `SELECT patient_id, location_id FROM scheduling.slot_reservation WHERE id = $1::uuid`,
        [id.toLowerCase()],
      );
      const row = r.rows[0] as Record<string, unknown> | undefined;
      return row === undefined
        ? undefined
        : { patientId: String(row['patient_id']), locationId: String(row['location_id']) };
    },
    encounter: async (req, _ctx, tx) => {
      const m = PATH_ENCOUNTER.exec(req.path);
      if (m?.[1] === undefined || !isUuid(m[1])) return undefined;
      const r = await tx.query(
        `SELECT patient_id, location_id FROM clinical.encounter WHERE id = $1::uuid`,
        [m[1].toLowerCase()],
      );
      const row = r.rows[0] as Record<string, unknown> | undefined;
      return row === undefined
        ? undefined
        : { patientId: String(row['patient_id']), locationId: String(row['location_id']) };
    },
    note: async (req, _ctx, tx) => {
      const m = PATH_NOTE.exec(req.path);
      if (m?.[1] === undefined || !isUuid(m[1])) return undefined;
      const r = await tx.query(
        `SELECT n.patient_id, e.location_id FROM clinical.note n JOIN clinical.encounter e ON e.id = n.encounter_id WHERE n.id = $1::uuid`,
        [m[1].toLowerCase()],
      );
      const row = r.rows[0] as Record<string, unknown> | undefined;
      return row === undefined
        ? undefined
        : { patientId: String(row['patient_id']), locationId: String(row['location_id']) };
    },
  };
}

export function createNotesControllers(d: NotesControllerDeps): Type<unknown>[] {
  const body = (req: Req, optional = false): Record<string, unknown> => {
    const b = req.body;
    if (b === undefined || b === null) {
      if (optional) return {};
      throw new ApiError(422, 'kernel.validation_failed');
    }
    if (typeof b !== 'object' || Array.isArray(b))
      throw new ApiError(422, 'kernel.validation_failed');
    return b as Record<string, unknown>;
  };
  const banner = async (
    tx: Tx,
    ctx: AuthContext,
    req: Req,
    patientId: string,
  ): Promise<unknown> => {
    const b = await d.banner.bannerFor(tx, ctx, metaOf(req), patientId);
    if (b === undefined) throw new NotesNotFoundError();
    return b;
  };

  @Controller('api/v1')
  class EncounterController {
    @Post('encounters')
    @Route({ permission: 'clinical.consultation.start', resolver: 'reservation-body' })
    async start(@ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      await idempotentWrite(d.db, req, res, 'POST /encounters', [], async (tx) => {
        const ctx = requireAuthContext(req);
        const out = await d.encounters.start(tx, ctx, metaOf(req), {
          reservationId: body(req)['reservationId'],
          emergencyException: body(req)['emergencyException'],
        });
        return {
          status: 201,
          body: {
            ...out.encounter,
            consentExceptionId: out.consentExceptionId,
            patientBanner: await banner(tx, ctx, req, out.encounter.patientId),
          },
          location: `/api/v1/encounters/${out.encounter.id}`,
          headers: { ETag: etag(out.encounter.version) },
        };
      });
    }

    @Post('encounters/:id/complete')
    @Route({ permission: 'clinical.consultation.start', resolver: 'encounter' })
    async complete(
      @Param('id') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      const version = ifMatchVersion(req) as number;
      await idempotentWrite(
        d.db,
        req,
        res,
        'POST /encounters/{id}/complete',
        [id.toLowerCase()],
        async (tx) => {
          const ctx = requireAuthContext(req);
          const e = await d.encounters.complete(tx, metaOf(req), id, version, {
            deferNoteReason: body(req, true)['deferNoteReason'],
          });
          return {
            status: 200,
            body: { ...e, patientBanner: await banner(tx, ctx, req, e.patientId) },
            headers: { ETag: etag(e.version) },
          };
        },
      );
    }

    @Post('encounters/:id/notes')
    @Route({ permission: 'clinical.note.write', resolver: 'encounter' })
    async createNote(
      @Param('id') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      await idempotentWrite(
        d.db,
        req,
        res,
        'POST /encounters/{id}/notes',
        [id.toLowerCase()],
        async (tx) => {
          const ctx = requireAuthContext(req);
          const n = await d.notes.create(tx, ctx, metaOf(req), id, {
            templateId: body(req, true)['templateId'],
          });
          return {
            status: 201,
            body: { ...n, patientBanner: await banner(tx, ctx, req, n.patientId) },
            location: `/api/v1/notes/${n.id}`,
            headers: { ETag: etag(n.version) },
          };
        },
      );
    }
  }

  @Controller('api/v1')
  class NoteController {
    @Patch('notes/:id')
    @Route({ permission: 'clinical.note.write', resolver: 'note' })
    async save(@Param('id') id: string, @ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      const version = ifMatchVersion(req) as number;
      const ctx = requireAuthContext(req);
      const out = await d.db.withScope(ctx.scope, async (tx) => {
        const n = await d.notes.save(tx, ctx, metaOf(req), id, version, {
          sections: body(req)['sections'],
        });
        return { ...n, patientBanner: await banner(tx, ctx, req, n.patientId) };
      });
      send(res, 200, out, { ETag: etag(out.version) });
    }

    @Post('notes/:id/sign')
    @Route({ permission: 'clinical.note.write', resolver: 'note' })
    async sign(@Param('id') id: string, @ReqParam() req: Req, @ResParam() res: Res): Promise<void> {
      const version = ifMatchVersion(req) as number;
      await idempotentWrite(
        d.db,
        req,
        res,
        'POST /notes/{id}/sign',
        [id.toLowerCase()],
        async (tx) => {
          const ctx = requireAuthContext(req);
          const n = await d.notes.sign(tx, ctx, metaOf(req), id, version);
          return {
            status: 200,
            body: { ...n, patientBanner: await banner(tx, ctx, req, n.patientId) },
            headers: { ETag: etag(n.version) },
          };
        },
      );
    }

    @Post('notes/:id/cosign')
    @Route({ permission: 'clinical.note.cosign', resolver: 'note' })
    async cosign(
      @Param('id') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      await idempotentWrite(
        d.db,
        req,
        res,
        'POST /notes/{id}/cosign',
        [id.toLowerCase()],
        async (tx) => {
          const ctx = requireAuthContext(req);
          const n = await d.notes.cosign(tx, ctx, metaOf(req), id);
          return {
            status: 200,
            body: { ...n, patientBanner: await banner(tx, ctx, req, n.patientId) },
            headers: { ETag: etag(n.version) },
          };
        },
      );
    }

    @Post('notes/:id/addenda')
    @Route({ permission: 'clinical.note.write', resolver: 'note' })
    async addendum(
      @Param('id') id: string,
      @ReqParam() req: Req,
      @ResParam() res: Res,
    ): Promise<void> {
      await idempotentWrite(
        d.db,
        req,
        res,
        'POST /notes/{id}/addenda',
        [id.toLowerCase()],
        async (tx) => {
          const ctx = requireAuthContext(req);
          const a = await d.notes.addAddendum(tx, ctx, metaOf(req), id, {
            body: body(req)['body'],
          });
          return {
            status: 201,
            body: { ...a, patientBanner: await banner(tx, ctx, req, a.patientId) },
          };
        },
      );
    }
  }

  return [EncounterController, NoteController];
}
