// Integration settings for the admin realm (ARCHITECTURE 29.4 integration rows, 25.9; RA-R1-31, BD-11). Settings are saved with
// `If-Match` and audited with before and after by integration-core; outbound secrets are WRITE-ONLY (the value reaches the secret
// store and nothing else: no response, log, audit row or error carries it); an admin-entered inbound-verification secret needs a
// request and a different approver, and only the worker applies it. Health is read from the connection row the health job keeps;
// "test" asks the injected probe for a fresh check.
import { randomUUID } from 'node:crypto';
import type { KernelDb, ScopeSettings, Tx } from '@ehr/kernel';
import { ApiError } from '../../platform/errors.js';
import type { AuditService } from '../audit/index.js';
import type {
  ConnectionRecord,
  ConnectionService,
  SecretService,
} from '../integration-core/index.js';
import type { Assertion } from '../integration-core/index.js';
import {
  cursorFor,
  etag,
  exactBody,
  ifMatchVersion,
  invalid,
  isUuid,
  notFound,
  parsePage,
  reqString,
  translate,
} from './http.js';
import type { Meta } from './http.js';

export type Row = Record<string, unknown>;

export type Health = 'unknown' | 'ok' | 'degraded' | 'down';
const HEALTH: readonly string[] = ['unknown', 'ok', 'degraded', 'down'];

/**
 * Runs a fresh health check of one connection and stores the result (only the worker may write the health columns, so the
 * composition root implements this through the worker's probe). Without one, "test" answers 503 and changes nothing.
 */
export interface ConnectionTester {
  test(connectionId: string): Promise<{ health: Health; checkedAt: Date }>;
}

export interface IntegrationAdminDeps {
  db: KernelDb;
  audit: Pick<AuditService, 'record'>;
  connections: ConnectionService;
  secrets: SecretService;
  tester?: ConnectionTester;
}

const ASSERTION_KEYS = ['credentialId', 'clientDataJSON', 'authenticatorData', 'signature'];

function assertionOf(v: unknown, path: string): Assertion {
  if (v === null || typeof v !== 'object' || Array.isArray(v))
    throw invalid([{ path, code: 'kernel.required' }]);
  const o = v as Record<string, unknown>;
  const bad = ASSERTION_KEYS.filter(
    (k) => typeof o[k] !== 'string' || !/^[A-Za-z0-9_-]{1,4096}$/.test(o[k] as string),
  );
  const extra = Object.keys(o).filter((k) => !ASSERTION_KEYS.includes(k));
  if (bad.length + extra.length > 0)
    throw invalid(
      [...bad, ...extra].map((k) => ({ path: `${path}/${k}`, code: 'kernel.invalid_format' })),
    );
  return o as unknown as Assertion;
}

/** The connection as the API shows it: settings, health, last test (no credential can be in any of them: table CHECKs). */
function view(c: ConnectionRecord, secrets: Row[]): Row {
  return {
    id: c.id,
    kind: c.kind,
    vendor: c.vendor,
    settings: c.settings,
    enabled: c.enabled,
    health: c.health,
    lastTestAt: c.lastTestAt === null ? null : c.lastTestAt.toISOString(),
    lastTestResult: c.lastTestResult,
    rowVersion: c.rowVersion,
    secrets,
  };
}

export interface Meta2 extends Meta {
  idempotencyKey?: string | undefined;
}

export class IntegrationAdminService {
  constructor(private readonly d: IntegrationAdminDeps) {}

  private run<T>(scope: ScopeSettings, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.d.db.withScope(scope, fn).catch((e: unknown) => {
      throw translate(e);
    });
  }

  /** Names, classes and current version IDs of a connection's secrets: metadata only, never a value. */
  private async secretsOf(tx: Tx, connectionId?: string): Promise<Map<string, Row[]>> {
    const r = await tx.query(
      `SELECT connection_id, name, class, current_version_id, rotated_at
         FROM integration_core.secret_ref WHERE ($1::uuid IS NULL OR connection_id = $1::uuid) ORDER BY name`,
      [connectionId ?? null],
    );
    const m = new Map<string, Row[]>();
    for (const s of r.rows) {
      const k = String(s.connection_id);
      const a = m.get(k) ?? [];
      a.push({
        name: s.name,
        class: s.class,
        currentVersionId: s.current_version_id ?? null,
        rotatedAt: s.rotated_at instanceof Date ? s.rotated_at.toISOString() : null,
      });
      m.set(k, a);
    }
    return m;
  }

  async list(scope: ScopeSettings, q: Record<string, unknown>): Promise<Row> {
    const { limit, offset } = parsePage(q);
    return this.run(scope, async (tx) => {
      const all = await this.d.connections.list(tx);
      const secrets = await this.secretsOf(tx);
      const page = all.slice(offset, offset + limit);
      return {
        items: page.map((c) => view(c, secrets.get(c.id) ?? [])),
        nextCursor: offset + limit < all.length ? cursorFor(offset + limit) : null,
      };
    });
  }

  /** `PATCH /admin/integrations/{id}` †: `{vendor?, settings?, enabled?}`, compare-and-set on `If-Match`. */
  async patch(
    scope: ScopeSettings,
    id: string,
    body: unknown,
    ifMatch: string | undefined,
    meta: Meta,
  ): Promise<{ body: Row; etag: string }> {
    if (!isUuid(id)) throw notFound();
    const o = exactBody(body, ['vendor', 'settings', 'enabled']);
    if (Object.keys(o).length === 0) throw invalid([{ path: '/', code: 'kernel.required' }]);
    if (o['enabled'] !== undefined && typeof o['enabled'] !== 'boolean')
      throw invalid([{ path: '/enabled', code: 'kernel.invalid_type' }]);
    if (o['vendor'] !== undefined && typeof o['vendor'] !== 'string')
      throw invalid([{ path: '/vendor', code: 'kernel.invalid_type' }]);
    if (
      o['settings'] !== undefined &&
      (o['settings'] === null || typeof o['settings'] !== 'object' || Array.isArray(o['settings']))
    )
      throw invalid([{ path: '/settings', code: 'kernel.invalid_type' }]);
    const version = ifMatchVersion(ifMatch);
    const rec = await this.run(scope, async (tx) => {
      const locked = (
        await tx.query(
          `SELECT kind, vendor, settings, enabled, row_version FROM integration_core.connection WHERE id = $1::uuid FOR UPDATE`,
          [id],
        )
      ).rows[0];
      if (locked === undefined) throw notFound();
      if (Number(locked.row_version) !== version)
        throw new ApiError(412, 'kernel.precondition_failed');
      return this.d.connections.upsert(tx, meta, {
        kind: String(locked.kind),
        vendor: (o['vendor'] as string | undefined) ?? String(locked.vendor),
        settings:
          (o['settings'] as Record<string, unknown> | undefined) ??
          (locked.settings as Record<string, unknown>),
        enabled: (o['enabled'] as boolean | undefined) ?? locked.enabled === true,
      });
    });
    const secrets = await this.run(scope, (tx) => this.secretsOf(tx, rec.id));
    return { body: view(rec, secrets.get(rec.id) ?? []), etag: etag(rec.rowVersion) };
  }

  /** `PUT /admin/integrations/{id}/secrets/{name}` †: write-only. Answers `{versionId}` and nothing derived from the value. */
  async putSecret(
    scope: ScopeSettings,
    id: string,
    name: string,
    body: unknown,
    meta: Meta2,
  ): Promise<Row> {
    if (!isUuid(id)) throw notFound();
    const o = exactBody(body, ['value']);
    const value = o['value'];
    if (typeof value !== 'string')
      throw invalid([
        {
          path: '/value',
          code: o['value'] === undefined ? 'kernel.required' : 'kernel.invalid_type',
        },
      ]);
    const key = meta.idempotencyKey ?? randomUUID();
    if (!isUuid(key)) throw invalid([{ path: '/Idempotency-Key', code: 'kernel.invalid_format' }]);
    return this.run(scope, (tx) =>
      this.d.secrets.writeOutbound(tx, meta, {
        connectionId: id,
        name,
        value,
        idempotencyKey: key,
      }),
    );
  }

  /** `POST /admin/integrations/{id}/inbound-secret-requests` †: step 1 of the dual-control flow (25.9). */
  async requestInbound(scope: ScopeSettings, id: string, body: unknown, meta: Meta): Promise<Row> {
    if (!isUuid(id)) throw notFound();
    const o = exactBody(body, ['name', 'value', 'requesterAssertion']);
    const name = reqString(o, 'name', 64);
    const value = o['value'];
    if (typeof value !== 'string')
      throw invalid([
        { path: '/value', code: value === undefined ? 'kernel.required' : 'kernel.invalid_type' },
      ]);
    const requesterAssertion = assertionOf(o['requesterAssertion'], '/requesterAssertion');
    const r = await this.run(scope, (tx) =>
      this.d.secrets.requestInboundSecret(tx, meta, {
        connectionId: id,
        name,
        value,
        requesterAssertion,
      }),
    );
    return {
      requestId: r.requestId,
      expiresAt: r.expiresAt.toISOString(),
      fingerprintHint: r.fingerprintHint,
    };
  }

  /** `POST …/inbound-secret-requests/{requestId}/approve` †: a different elevated admin. The worker still re-checks the evidence. */
  async approveInbound(
    scope: ScopeSettings,
    id: string,
    requestId: string,
    body: unknown,
    meta: Meta,
  ): Promise<Row> {
    if (!isUuid(id) || !isUuid(requestId)) throw notFound();
    const o = exactBody(body, ['approverAssertion']);
    const approverAssertion = assertionOf(o['approverAssertion'], '/approverAssertion');
    return this.run(scope, async (tx) => {
      const own = (
        await tx.query(
          `SELECT 1 FROM integration_core.secret_change_request WHERE id = $1::uuid AND connection_id = $2::uuid`,
          [requestId, id],
        )
      ).rows[0];
      if (own === undefined) throw notFound();
      const r = await this.d.secrets.decide(tx, meta, {
        requestId,
        decision: 'approve',
        approverAssertion,
      });
      return { requestId, status: r.status };
    });
  }

  /** `POST /admin/integrations/{id}/test` †: `{health, checkedAt}`; the check is audited. */
  async test(scope: ScopeSettings, id: string, body: unknown, meta: Meta): Promise<Row> {
    if (!isUuid(id)) throw notFound();
    exactBody(body ?? {}, []);
    const tester = this.d.tester;
    await this.run(scope, async (tx) => {
      await this.d.connections.get(tx, id); // 404 when not visible
    });
    if (tester === undefined) throw new ApiError(503, 'kernel.unavailable', true);
    let result: { health: Health; checkedAt: Date };
    try {
      result = await tester.test(id);
    } catch {
      throw new ApiError(503, 'kernel.unavailable', true);
    }
    if (!HEALTH.includes(result.health)) throw new ApiError(503, 'kernel.unavailable', true);
    await this.run(scope, (tx) =>
      this.d.audit.record(tx, {
        requestId: meta.requestId,
        action: 'config_change',
        resourceType: 'integration_core.connection',
        resourceId: id,
        ip: meta.ip,
        userAgent: meta.userAgent,
        change: { event: 'connection_test', health: result.health },
      }),
    );
    return { health: result.health, checkedAt: result.checkedAt.toISOString() };
  }
}
