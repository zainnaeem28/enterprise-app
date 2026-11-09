// The privileged admin actions of ARCHITECTURE 25.8 and 29.4: principal provisioning, enrolment tokens (two persons), role
// change requests with a different approver (C4), and the kill switch (C6). Every method runs in ONE transaction under the
// caller's own scope; the guard has already checked the permission and the live elevation (C1) before a handler gets here.
// A refusal that must be audited is recorded with `recordDenied` in a new short transaction (the business transaction has
// rolled back), and a state change that must survive its own refusal (an expiry) is RETURNED from the transaction, then
// raised after the commit.
import { createHash, randomBytes } from 'node:crypto';
import type { KernelDb, Queue, ScopeSettings, Tx } from '@ehr/kernel';
import { AuditService } from '../../audit/index.js';
import { IdentityValidationError } from '../errors.js';
import { uuidv7 } from '../ids.js';
import type { AuthContext } from '../types.js';
import {
  AdminConflictError,
  AdminForbiddenError,
  AdminNotFoundError,
  AdminUnprocessableError,
} from './errors.js';
import { normaliseHandle } from './handle.js';
import { setLocal } from './claims.js';
import { intSetting, ENROLMENT_TOKEN_MINUTES, ROLE_REQUEST_HOURS } from './settings.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const ROLE_KEY = /^[a-z][a-z0-9_]{0,60}$/;

export interface Meta {
  requestId: string | null;
  ip: string | null;
  userAgent: string | null;
}

export interface RoleRef {
  roleKey: string;
  locationId?: string;
}

export interface AdminServiceDeps {
  db: KernelDb;
  queue: Queue;
  audit: AuditService;
  orgId: string;
  now?: () => Date;
}

const sortRefs = (r: RoleRef[]): RoleRef[] =>
  [...r].sort((a, b) =>
    a.roleKey === b.roleKey
      ? (a.locationId ?? '').localeCompare(b.locationId ?? '')
      : a.roleKey.localeCompare(b.roleKey),
  );
const sameRef = (a: RoleRef, b: RoleRef): boolean =>
  a.roleKey === b.roleKey && (a.locationId ?? null) === (b.locationId ?? null);

/** Canonical JSON: sorted lists, fixed key order, so the hash does not depend on how the client ordered its body. */
export function requestHashOf(
  subjectPrincipalId: string,
  add: RoleRef[],
  remove: RoleRef[],
  before: RoleRef[],
): Buffer {
  const norm = (l: RoleRef[]): [string, string | null][] =>
    sortRefs(l).map((x) => [x.roleKey, x.locationId ?? null]);
  return createHash('sha256')
    .update(
      JSON.stringify({
        subject: subjectPrincipalId,
        add: norm(add),
        remove: norm(remove),
        before: norm(before),
      }),
    )
    .digest();
}

function parseRefs(v: unknown, field: string): RoleRef[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 20) throw new IdentityValidationError([field]);
  return v.map((x) => {
    if (typeof x !== 'object' || x === null) throw new IdentityValidationError([field]);
    const o = x as Record<string, unknown>;
    if (typeof o['roleKey'] !== 'string' || !ROLE_KEY.test(o['roleKey']))
      throw new IdentityValidationError([field]);
    if (o['locationId'] !== undefined && !isUuid(o['locationId']))
      throw new IdentityValidationError([field]);
    return {
      roleKey: o['roleKey'],
      ...(o['locationId'] === undefined
        ? {}
        : { locationId: (o['locationId'] as string).toLowerCase() }),
    };
  });
}

export interface RoleChangeView {
  id: string;
  status: string;
  subjectPrincipalId: string;
  requesterPersonId: string;
  approverPersonId: string | null;
  add: RoleRef[];
  remove: RoleRef[];
  before: RoleRef[];
  expiresAt: string;
  decidedAt: string | null;
}

export class AdminService {
  constructor(private readonly d: AdminServiceDeps) {}

  private now(): Date {
    return (this.d.now ?? (() => new Date()))();
  }

  // --- principals ---------------------------------------------------------------------------------------------------------

  /** POST /admin/principals: an `admin_pool` principal (no credential) or the pre-registration of a `google` principal by email. */
  async createPrincipal(
    ctx: AuthContext,
    input: unknown,
    meta: Meta,
  ): Promise<{ principalId: string; realm: string }> {
    const o = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
    const displayName = typeof o['displayName'] === 'string' ? o['displayName'].trim() : '';
    if (displayName.length < 1 || displayName.length > 200)
      throw new IdentityValidationError(['displayName']);
    const realm = o['realm'];
    let handle: string | undefined;
    let email: string | undefined;
    if (realm === 'admin_pool') {
      handle = normaliseHandle(o['handle']);
      if (handle === undefined) throw new IdentityValidationError(['handle']);
    } else if (realm === 'google') {
      const e = typeof o['email'] === 'string' ? o['email'].trim().toLowerCase() : '';
      if (!/^[^@\s]{1,64}@[^@\s]{1,255}$/.test(e) || e.length > 320)
        throw new IdentityValidationError(['email']);
      email = e;
    } else throw new IdentityValidationError(['realm']);

    const now = this.now();
    const personId = uuidv7();
    const principalId = uuidv7();
    try {
      await this.d.db.withScope(ctx.scope, async (tx) => {
        await tx.query(
          `INSERT INTO identity.person (id, organisation_id, display_name, status, created_by) VALUES ($1, $2, $3, 'active', $4)`,
          [personId, this.d.orgId, displayName, ctx.session.principalId],
        );
        await tx.query(
          `INSERT INTO identity.principal (id, organisation_id, person_id, realm, subject, email, status, preregistered_at, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8)`,
          [
            principalId,
            this.d.orgId,
            personId,
            realm,
            handle ?? null,
            email ?? null,
            realm === 'google' ? now : null,
            ctx.session.principalId,
          ],
        );
        await this.d.audit.record(tx, {
          requestId: meta.requestId,
          action: 'create',
          resourceType: 'identity.principal',
          resourceId: principalId,
          ip: meta.ip,
          userAgent: meta.userAgent,
          change: { realm: realm as string },
        });
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new IdentityValidationError(['handle']); // duplicate: registered kernel.validation_failed (BE05-R1-F03)
      throw e;
    }
    return { principalId, realm: realm as string };
  }

  /** GET /admin/principals?realm&q&limit&cursor: metadata only (C5), keyset-paged on (created_at, id). */
  async listPrincipals(
    ctx: AuthContext,
    realm: unknown,
    q: unknown,
    limit?: unknown,
    cursor?: unknown,
  ): Promise<{ items: Record<string, unknown>[]; nextCursor: string | null }> {
    const realmFilter =
      typeof realm === 'string' && ['admin_pool', 'google'].includes(realm) ? realm : null;
    const prefix = typeof q === 'string' ? q.trim().toLowerCase().slice(0, 64) : '';
    let size = 50;
    if (limit !== undefined) {
      const n = typeof limit === 'string' && /^\d{1,4}$/.test(limit) ? Number(limit) : NaN;
      if (!(n >= 1 && n <= 100)) throw new IdentityValidationError(['limit']);
      size = n;
    }
    let after: { at: string; id: string } | null = null;
    if (cursor !== undefined && cursor !== '') {
      try {
        const c = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8')) as {
          at?: unknown;
          id?: unknown;
        };
        if (typeof c.at !== 'string' || Number.isNaN(Date.parse(c.at)) || !isUuid(c.id))
          throw new Error('bad cursor');
        after = { at: c.at, id: c.id as string };
      } catch {
        throw new IdentityValidationError(['cursor']);
      }
    }
    return this.d.db.withScope(
      ctx.scope,
      async (tx) => {
        const r = await tx.query(
          `SELECT p.id, p.realm, p.subject, p.email, p.status, pe.display_name, p.created_at,
                  to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_key
             FROM identity.principal p JOIN identity.person pe ON pe.id = p.person_id
            WHERE p.realm IN ('admin_pool', 'google') AND ($1::text IS NULL OR p.realm = $1)
              AND ($2 = '' OR lower(coalesce(p.subject, '')) LIKE $2 || '%' OR lower(coalesce(p.email, '')) LIKE $2 || '%')
              AND ($3::timestamptz IS NULL OR (p.created_at, p.id) > ($3::timestamptz, $4::uuid))
            ORDER BY p.created_at, p.id LIMIT $5`,
          [
            realmFilter,
            prefix.replace(/[%_\\]/g, ''),
            after?.at ?? null,
            after?.id ?? null,
            size + 1,
          ],
        );
        const page = r.rows.slice(0, size);
        const last = page[page.length - 1];
        const nextCursor =
          r.rows.length > size && last !== undefined
            ? Buffer.from(
                JSON.stringify({ at: last['created_key'], id: last['id'] }),
                'utf8',
              ).toString('base64url')
            : null;
        return {
          items: page.map((x) => ({
            principalId: x['id'],
            realm: x['realm'],
            ...(x['realm'] === 'admin_pool' ? { handle: x['subject'] } : { email: x['email'] }),
            status: x['status'],
            displayName: x['display_name'],
          })),
          nextCursor,
        };
      },
      { idempotent: true },
    );
  }

  /** GET /admin/roles: the catalogue with permissions. */
  async listRoles(ctx: AuthContext): Promise<Record<string, unknown>[]> {
    return this.d.db.withScope(
      ctx.scope,
      async (tx) => {
        const r = await tx.query(
          `SELECT r.key, r.realm, r.privileged, r.location_bound, r.description,
                  coalesce(array_agg(rp.permission_key ORDER BY rp.permission_key) FILTER (WHERE rp.permission_key IS NOT NULL), '{}') AS permissions
             FROM identity.role r LEFT JOIN identity.role_permission rp ON rp.role_id = r.id
            GROUP BY r.id ORDER BY r.key`,
        );
        return r.rows.map((x) => ({
          key: x['key'],
          realm: x['realm'],
          privileged: x['privileged'],
          locationBound: x['location_bound'],
          description: x['description'],
          permissions: x['permissions'],
        }));
      },
      { idempotent: true },
    );
  }

  // --- enrolment tokens (26.3: request + approve, different persons) ------------------------------------------------------

  /** POST /admin/enrolment-tokens {principalId} */
  async requestEnrolmentToken(
    ctx: AuthContext,
    input: unknown,
    meta: Meta,
  ): Promise<{ id: string; expiresAt: Date }> {
    const principalId = (input as { principalId?: unknown } | null)?.principalId;
    if (!isUuid(principalId)) throw new IdentityValidationError(['principalId']);
    const now = this.now();
    const id = uuidv7();
    return this.d.db.withScope(ctx.scope, async (tx) => {
      const p = (
        await tx.query(`SELECT realm, status FROM identity.principal WHERE id = $1`, [principalId])
      ).rows[0];
      if (p === undefined) throw new AdminNotFoundError();
      if (p['realm'] !== 'admin_pool' || p['status'] !== 'active')
        throw new IdentityValidationError(['principalId']);
      const minutes = await intSetting(
        tx,
        ENROLMENT_TOKEN_MINUTES.key,
        ENROLMENT_TOKEN_MINUTES.dflt,
        ENROLMENT_TOKEN_MINUTES.min,
        ENROLMENT_TOKEN_MINUTES.max,
      );
      const expiresAt = new Date(now.getTime() + minutes * 60_000);
      await tx.query(
        `INSERT INTO identity.enrolment_token (id, organisation_id, principal_id, requested_by_person_id, expires_at, status, created_by)
         VALUES ($1, $2, $3, $4, $5, 'requested', $6)`,
        [id, this.d.orgId, principalId, ctx.session.personId, expiresAt, ctx.session.principalId],
      );
      await this.d.audit.record(tx, {
        requestId: meta.requestId,
        action: 'create',
        resourceType: 'identity.enrolment_token',
        resourceId: id,
        ip: meta.ip,
        userAgent: meta.userAgent,
        change: { principalId },
      });
      await this.d.queue.enqueue(
        tx,
        'identity.admin_event',
        { kind: 'enrolment_token_requested', principalId },
        { jobKey: `enrolment_token_requested:${id}` },
      );
      return { id, expiresAt };
    });
  }

  /** POST /admin/enrolment-tokens/{id}/approve: a different person; the token is returned ONCE and only its hash is stored. */
  async approveEnrolmentToken(
    ctx: AuthContext,
    id: string,
    meta: Meta,
  ): Promise<{ token: string; expiresAt: Date }> {
    if (!isUuid(id)) throw new AdminNotFoundError();
    const now = this.now();
    type R =
      | { token: string; expiresAt: Date }
      | { refuse: 'identity.self_approval' | 'identity.approver_is_subject' }
      | { conflict: 'identity.request_expired' | 'identity.request_expired' };
    const out: R = await this.d.db.withScope(ctx.scope, async (tx): Promise<R> => {
      const t = (
        await tx.query(
          `SELECT t.status, t.expires_at, t.requested_by_person_id, t.principal_id, p.person_id AS subject_person
             FROM identity.enrolment_token t JOIN identity.principal p ON p.id = t.principal_id
            WHERE t.id = $1 FOR UPDATE OF t`,
          [id],
        )
      ).rows[0];
      if (t === undefined) throw new AdminNotFoundError();
      if (t['requested_by_person_id'] === ctx.session.personId)
        return { refuse: 'identity.self_approval' as const };
      if (t['subject_person'] === ctx.session.personId)
        return { refuse: 'identity.approver_is_subject' as const };
      if (t['status'] !== 'requested') return { conflict: 'identity.request_expired' as const };
      if ((t['expires_at'] as Date).getTime() <= now.getTime()) {
        await tx.query(`UPDATE identity.enrolment_token SET status = 'expired' WHERE id = $1`, [
          id,
        ]);
        return { conflict: 'identity.request_expired' as const };
      }
      const minutes = await intSetting(
        tx,
        ENROLMENT_TOKEN_MINUTES.key,
        ENROLMENT_TOKEN_MINUTES.dflt,
        ENROLMENT_TOKEN_MINUTES.min,
        ENROLMENT_TOKEN_MINUTES.max,
      );
      const expiresAt = new Date(now.getTime() + minutes * 60_000);
      const token = randomBytes(32).toString('base64url'); // 256 random bits
      await tx.query(
        `UPDATE identity.enrolment_token SET token_hash = $2, approved_by_person_id = $3, expires_at = $4, status = 'approved'
          WHERE id = $1`,
        [id, createHash('sha256').update(token).digest(), ctx.session.personId, expiresAt],
      );
      await this.d.audit.record(tx, {
        requestId: meta.requestId,
        action: 'update',
        resourceType: 'identity.enrolment_token',
        resourceId: id,
        ip: meta.ip,
        userAgent: meta.userAgent,
        change: { status: 'approved' },
      });
      await this.d.queue.enqueue(
        tx,
        'identity.admin_event',
        { kind: 'enrolment_token_approved', principalId: t['principal_id'] as string },
        { jobKey: `enrolment_token_approved:${id}` },
      );
      return { token, expiresAt };
    });
    if ('refuse' in out) {
      await this.denied(ctx, 'identity.enrolment_token', id, meta);
      throw new AdminForbiddenError(out.refuse);
    }
    if ('conflict' in out) throw new AdminConflictError(out.conflict);
    return out;
  }

  // --- role changes (C4) ---------------------------------------------------------------------------------------------------

  /** POST /admin/role-change-requests {subjectPrincipalId, add, remove} */
  async requestRoleChange(ctx: AuthContext, input: unknown, meta: Meta): Promise<RoleChangeView> {
    const o = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
    if (!isUuid(o['subjectPrincipalId'])) throw new IdentityValidationError(['subjectPrincipalId']);
    const subjectId = (o['subjectPrincipalId'] as string).toLowerCase();
    const add = parseRefs(o['add'], 'add');
    const remove = parseRefs(o['remove'], 'remove');
    if (add.length + remove.length === 0) throw new IdentityValidationError(['add', 'remove']);
    const now = this.now();
    const id = uuidv7();
    return this.d.db.withScope(ctx.scope, async (tx) => {
      const subject = (
        await tx.query(`SELECT realm, subject, status FROM identity.principal WHERE id = $1`, [
          subjectId,
        ])
      ).rows[0];
      if (subject === undefined) throw new AdminNotFoundError();
      const roles = await this.rolesByKey(
        tx,
        [...add, ...remove].map((x) => x.roleKey),
      );
      for (const ref of [...add, ...remove]) {
        const r = roles.get(ref.roleKey);
        if (r === undefined) throw new IdentityValidationError(['roleKey']);
        if (r.privileged && subject['realm'] !== 'admin_pool')
          throw new AdminUnprocessableError('identity.privileged_role_in_staff_realm');
        if (r.realm !== subject['realm'])
          throw new AdminUnprocessableError('identity.role_realm_mismatch');
        if (r.locationBound !== (ref.locationId !== undefined))
          throw new IdentityValidationError(['locationId']);
      }
      // SEC01-F-08: a principal that has not signed in yet (no subject) can hold no role.
      if (add.length > 0 && subject['subject'] === null)
        throw new IdentityValidationError(['principalId']);
      if (add.length > 0 && subject['status'] !== 'active')
        throw new IdentityValidationError(['principalId']);
      const before = await this.currentRoles(tx, subjectId);
      for (const x of remove)
        if (!before.some((b) => sameRef(b, x))) throw new IdentityValidationError(['remove']);
      const hours = await intSetting(
        tx,
        ROLE_REQUEST_HOURS.key,
        ROLE_REQUEST_HOURS.dflt,
        ROLE_REQUEST_HOURS.min,
        ROLE_REQUEST_HOURS.max,
      );
      const expiresAt = new Date(now.getTime() + hours * 3_600_000);
      await tx.query(
        `INSERT INTO identity.role_change_request (id, organisation_id, requester_person_id, subject_principal_id, change, before, request_hash, status, expires_at, created_by)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, 'requested', $8, $9)`,
        [
          id,
          this.d.orgId,
          ctx.session.personId,
          subjectId,
          JSON.stringify({ add: sortRefs(add), remove: sortRefs(remove) }),
          JSON.stringify(sortRefs(before)),
          requestHashOf(subjectId, add, remove, before),
          expiresAt,
          ctx.session.principalId,
        ],
      );
      await this.d.audit.record(tx, {
        requestId: meta.requestId,
        action: 'role_change_request',
        resourceType: 'identity.role_change_request',
        resourceId: id,
        ip: meta.ip,
        userAgent: meta.userAgent,
        change: {
          subjectPrincipalId: subjectId,
          add: sortRefs(add),
          remove: sortRefs(remove),
          before: sortRefs(before),
        },
      });
      await this.d.queue.enqueue(
        tx,
        'identity.admin_event',
        { kind: 'role_change_requested', principalId: subjectId },
        { jobKey: `role_change_requested:${id}` },
      );
      return {
        id,
        status: 'requested',
        subjectPrincipalId: subjectId,
        requesterPersonId: ctx.session.personId,
        approverPersonId: null,
        add: sortRefs(add),
        remove: sortRefs(remove),
        before: sortRefs(before),
        expiresAt: expiresAt.toISOString(),
        decidedAt: null,
      };
    });
  }

  /** POST /admin/role-change-requests/{id}/approve | reject | cancel */
  async decideRoleChange(
    ctx: AuthContext,
    id: string,
    decision: 'approve' | 'reject' | 'cancel',
    meta: Meta,
  ): Promise<RoleChangeView> {
    if (!isUuid(id)) throw new AdminNotFoundError();
    const now = this.now();
    type R =
      | { view: RoleChangeView }
      | { refuse: 'identity.self_approval' | 'identity.approver_is_subject' | 'auth.forbidden' }
      | { conflict: 'identity.request_expired' | 'identity.request_expired' };
    const out: R = await this.d.db.withScope(ctx.scope, async (tx): Promise<R> => {
      const row = (
        await tx.query(
          `SELECT r.id, r.status, r.requester_person_id, r.subject_principal_id, r.change, r.before, r.expires_at,
                  sp.person_id AS subject_person
             FROM identity.role_change_request r JOIN identity.principal sp ON sp.id = r.subject_principal_id
            WHERE r.id = $1 FOR UPDATE OF r`,
          [id],
        )
      ).rows[0];
      if (row === undefined) throw new AdminNotFoundError();
      const requesterPersonId = row['requester_person_id'] as string;
      const subjectId = row['subject_principal_id'] as string;
      const add = (row['change'] as { add: RoleRef[] }).add;
      const remove = (row['change'] as { remove: RoleRef[] }).remove;
      const before = row['before'] as RoleRef[];
      const base = {
        id,
        subjectPrincipalId: subjectId,
        requesterPersonId,
        add,
        remove,
        before,
        expiresAt: (row['expires_at'] as Date).toISOString(),
      };
      if (decision === 'cancel') {
        if (requesterPersonId !== ctx.session.personId) return { refuse: 'auth.forbidden' };
      } else {
        if (requesterPersonId === ctx.session.personId) return { refuse: 'identity.self_approval' };
        if (row['subject_person'] === ctx.session.personId)
          return { refuse: 'identity.approver_is_subject' };
      }
      if (row['status'] !== 'requested') return { conflict: 'identity.request_expired' };
      if ((row['expires_at'] as Date).getTime() <= now.getTime()) {
        await tx.query(`UPDATE identity.role_change_request SET status = 'expired' WHERE id = $1`, [
          id,
        ]);
        await this.d.audit.record(tx, {
          requestId: meta.requestId,
          action: 'role_change_decision',
          resourceType: 'identity.role_change_request',
          resourceId: id,
          ip: meta.ip,
          userAgent: meta.userAgent,
          change: { decision: 'expired', subjectPrincipalId: subjectId },
        });
        return { conflict: 'identity.request_expired' };
      }

      if (decision === 'cancel') {
        await tx.query(
          `UPDATE identity.role_change_request SET status = 'cancelled' WHERE id = $1`,
          [id],
        );
        await this.d.audit.record(tx, {
          requestId: meta.requestId,
          action: 'role_change_decision',
          resourceType: 'identity.role_change_request',
          resourceId: id,
          ip: meta.ip,
          userAgent: meta.userAgent,
          change: { decision: 'cancelled', subjectPrincipalId: subjectId },
        });
        return { view: { ...base, status: 'cancelled', approverPersonId: null, decidedAt: null } };
      }

      await tx.query(
        `UPDATE identity.role_change_request SET status = $2, approver_person_id = $3, decided_at = $4 WHERE id = $1`,
        [id, decision === 'approve' ? 'approved' : 'rejected', ctx.session.personId, now],
      );
      let after = before;
      if (decision === 'approve') {
        // BE05-R1-F05: re-validate at apply time. The subject may have been disabled (kill switch) or a location removed
        // since the request was made. Throwing rolls the whole transaction back: the request stays pending and can be rejected.
        if (add.length > 0) {
          const st = (
            await tx.query(`SELECT status FROM identity.principal WHERE id = $1`, [subjectId])
          ).rows[0];
          if (st === undefined || st['status'] !== 'active')
            throw new IdentityValidationError(['principalId']);
          const locs = [
            ...new Set(add.flatMap((x) => (x.locationId === undefined ? [] : [x.locationId]))),
          ];
          if (locs.length > 0) {
            const found = await tx.query(
              `SELECT id FROM organisation.location WHERE id = ANY($1::uuid[])`,
              [locs],
            );
            if (found.rows.length !== locs.length)
              throw new IdentityValidationError(['locationId']);
          }
        }
        after = await this.applyChange(tx, ctx, id, subjectId, add, remove, now);
        await tx.query(`UPDATE identity.role_change_request SET status = 'applied' WHERE id = $1`, [
          id,
        ]);
        if (remove.length > 0)
          await this.revokeSessionsAndGrants(tx, subjectId, 'role_change', now);
      }
      await this.d.audit.record(tx, {
        requestId: meta.requestId,
        action: 'role_change_decision',
        resourceType: 'identity.role_change_request',
        resourceId: id,
        ip: meta.ip,
        userAgent: meta.userAgent,
        change: {
          decision: decision === 'approve' ? 'applied' : 'rejected',
          subjectPrincipalId: subjectId,
          requesterPersonId,
          approverPersonId: ctx.session.personId,
          before,
          after,
        },
      });
      await this.d.queue.enqueue(
        tx,
        'identity.admin_event',
        { kind: 'role_change_decided', principalId: subjectId },
        { jobKey: `role_change_decided:${id}` },
      );
      return {
        view: {
          ...base,
          status: decision === 'approve' ? 'applied' : 'rejected',
          approverPersonId: ctx.session.personId,
          decidedAt: now.toISOString(),
        },
      };
    });
    if ('refuse' in out) {
      await this.denied(ctx, 'identity.role_change_request', id, meta);
      throw new AdminForbiddenError(out.refuse);
    }
    if ('conflict' in out) throw new AdminConflictError(out.conflict);
    return out.view;
  }

  /** GET /admin/role-change-requests/{id} */
  async getRoleChange(ctx: AuthContext, id: string): Promise<RoleChangeView> {
    if (!isUuid(id)) throw new AdminNotFoundError();
    return this.d.db.withScope(
      ctx.scope,
      async (tx) => {
        const r = (await tx.query(`SELECT * FROM identity.role_change_request WHERE id = $1`, [id]))
          .rows[0];
        if (r === undefined) throw new AdminNotFoundError();
        const ch = r['change'] as { add: RoleRef[]; remove: RoleRef[] };
        return {
          id,
          status: r['status'] as string,
          subjectPrincipalId: r['subject_principal_id'] as string,
          requesterPersonId: r['requester_person_id'] as string,
          approverPersonId: (r['approver_person_id'] as string | null) ?? null,
          add: ch.add,
          remove: ch.remove,
          before: r['before'] as RoleRef[],
          expiresAt: (r['expires_at'] as Date).toISOString(),
          decidedAt: r['decided_at'] === null ? null : (r['decided_at'] as Date).toISOString(),
        };
      },
      { idempotent: true },
    );
  }

  private async rolesByKey(
    tx: Tx,
    keys: string[],
  ): Promise<
    Map<string, { id: string; realm: string; privileged: boolean; locationBound: boolean }>
  > {
    const r = await tx.query(
      `SELECT id, key, realm, privileged, location_bound FROM identity.role WHERE key = ANY($1::text[])`,
      [[...new Set(keys)]],
    );
    return new Map(
      r.rows.map((x) => [
        x['key'] as string,
        {
          id: x['id'] as string,
          realm: x['realm'] as string,
          privileged: x['privileged'] === true,
          locationBound: x['location_bound'] === true,
        },
      ]),
    );
  }

  private async currentRoles(tx: Tx, principalId: string): Promise<RoleRef[]> {
    const r = await tx.query(
      `SELECT ro.key, ra.location_id FROM identity.role_assignment ra JOIN identity.role ro ON ro.id = ra.role_id
        WHERE ra.principal_id = $1 AND ra.revoked_at IS NULL`,
      [principalId],
    );
    return sortRefs(
      r.rows.map((x) => ({
        roleKey: x['key'] as string,
        ...(x['location_id'] === null ? {} : { locationId: x['location_id'] as string }),
      })),
    );
  }

  /** Revokes then grants, inside the transaction that holds the approved request. Returns the role set after the change. */
  private async applyChange(
    tx: Tx,
    ctx: AuthContext,
    requestId: string,
    subjectId: string,
    add: RoleRef[],
    remove: RoleRef[],
    now: Date,
  ): Promise<RoleRef[]> {
    const roles = await this.rolesByKey(
      tx,
      [...add, ...remove].map((x) => x.roleKey),
    );
    for (const x of remove) {
      const role = roles.get(x.roleKey);
      if (role === undefined) continue;
      await tx.query(
        `UPDATE identity.role_assignment SET revoked_at = $4
          WHERE principal_id = $1 AND role_id = $2 AND location_id IS NOT DISTINCT FROM $3 AND revoked_at IS NULL`,
        [subjectId, role.id, x.locationId ?? null, now],
      );
    }
    for (const x of add) {
      const role = roles.get(x.roleKey);
      if (role === undefined) continue;
      const have = await tx.query(
        `SELECT 1 FROM identity.role_assignment
          WHERE principal_id = $1 AND role_id = $2 AND location_id IS NOT DISTINCT FROM $3 AND revoked_at IS NULL`,
        [subjectId, role.id, x.locationId ?? null],
      );
      if (have.rows.length > 0) continue;
      await tx.query(
        `INSERT INTO identity.role_assignment (id, organisation_id, role_id, principal_id, location_id, granted_via_request_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          uuidv7(),
          this.d.orgId,
          role.id,
          subjectId,
          x.locationId ?? null,
          requestId,
          ctx.session.principalId,
        ],
      );
    }
    return this.currentRoles(tx, subjectId);
  }

  // --- kill switch (C6) -----------------------------------------------------------------------------------------------------

  /** POST /admin/principals/{id}/kill-switch {reason}: one transaction; every session and elevation of the target ends at once. */
  async killSwitch(
    ctx: AuthContext,
    principalId: string,
    input: unknown,
    meta: Meta,
  ): Promise<{ sessionsRevoked: number; grantsRevoked: number; credentialsRevoked: number }> {
    if (!isUuid(principalId)) throw new AdminNotFoundError();
    const reason = (input as { reason?: unknown } | null)?.reason;
    if (typeof reason !== 'string' || reason.trim().length < 3 || reason.length > 500)
      throw new IdentityValidationError(['reason']);
    const now = this.now();
    return this.d.db.withScope(ctx.scope, async (tx) => {
      await setLocal(tx, 'app.revoke_principal_id', principalId.toLowerCase());
      const p = (
        await tx.query(`SELECT id, realm FROM identity.principal WHERE id = $1`, [principalId])
      ).rows[0];
      if (p === undefined) throw new AdminNotFoundError();
      const counts = await this.revokeSessionsAndGrants(tx, principalId, 'kill_switch', now);
      const creds = await tx.query(
        `UPDATE identity.admin_credential SET revoked_at = $2, revoke_reason = 'kill_switch'
          WHERE principal_id = $1 AND revoked_at IS NULL`,
        [principalId, now],
      );
      await tx.query(
        `UPDATE identity.principal SET status = 'disabled', disabled_reason = $2 WHERE id = $1`,
        [principalId, reason.trim().slice(0, 200)],
      );
      await this.d.audit.record(tx, {
        requestId: meta.requestId,
        action: 'kill_switch',
        resourceType: 'identity.principal',
        resourceId: principalId,
        reason: reason.trim(),
        ip: meta.ip,
        userAgent: meta.userAgent,
        change: {
          sessionsRevoked: counts.sessions,
          grantsRevoked: counts.grants,
          // not "credentials": the audit envelope refuses keys that look like secrets (BD-11), and these are counts
          securityKeysRevoked: creds.rowCount ?? 0,
        },
      });
      // 32.2 point 5: every API instance closes the principal's streams as soon as this commits; the 60 s revalidation is the backstop.
      await tx.query(`SELECT pg_notify('session_revoked', $1)`, [principalId.toLowerCase()]);
      await this.d.queue.publish(
        tx,
        'identity.kill_switch_used',
        { principalId: principalId.toLowerCase(), actorPrincipalId: ctx.session.principalId },
        { jobKey: `kill_switch_used:${principalId}:${now.getTime()}` },
      );
      return {
        sessionsRevoked: counts.sessions,
        grantsRevoked: counts.grants,
        credentialsRevoked: creds.rowCount ?? 0,
      };
    });
  }

  /** The target's live sessions and elevation grants, through the T-REVOKE policies (`app.revoke_principal_id` is set here). */
  private async revokeSessionsAndGrants(
    tx: Tx,
    principalId: string,
    reason: 'kill_switch' | 'role_change',
    now: Date,
  ): Promise<{ sessions: number; grants: number }> {
    await setLocal(tx, 'app.revoke_principal_id', principalId.toLowerCase());
    const grants = await tx.query(
      `UPDATE identity.elevation_grant SET revoked_at = $2, revoke_reason = $3
        WHERE revoked_at IS NULL AND session_id IN (SELECT id FROM identity.session WHERE principal_id = $1)`,
      [principalId, now, reason],
    );
    const sessions = await tx.query(
      `UPDATE identity.session SET revoked_at = $2, revoke_reason = $3 WHERE principal_id = $1 AND revoked_at IS NULL`,
      [principalId, now, reason],
    );
    return { sessions: sessions.rowCount ?? 0, grants: grants.rowCount ?? 0 };
  }

  /** The denial of 27.1 / 8.1 rule 2, written after the business transaction rolled back. Never throws. */
  private async denied(
    ctx: AuthContext,
    resourceType: string,
    resourceId: string,
    meta: Meta,
  ): Promise<void> {
    await this.d.audit.recordDenied(this.d.db, ctx.scope as ScopeSettings, {
      requestId: meta.requestId,
      resourceType,
      resourceId,
      denialReason: 'forbidden',
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }
}
