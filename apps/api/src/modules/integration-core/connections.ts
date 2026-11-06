// Connection settings (ARCHITECTURE 22.3, 24 `connectionSettings(kind)`). Non-secret settings, health and the last test
// result; secrets are only referenced (secret-service.ts). Writes are admin-realm only (T-CONF(admin)); the route guard
// additionally requires an active elevation grant (25.8).
import type { Tx } from '@ehr/kernel';
import { AuditService, type RequestMeta } from '../audit/index.js';
import {
  IntegrationNotFoundError,
  IntegrationScopeError,
  IntegrationValidationError,
} from './errors.js';
import { uuidv7 } from './ids.js';
import { CONNECTION_KINDS, hasSecretLikeKey } from './kinds.js';

export interface ConnectionRecord {
  id: string;
  kind: string;
  vendor: string;
  settings: Record<string, unknown>;
  enabled: boolean;
  health: 'unknown' | 'ok' | 'degraded' | 'down';
  lastTestAt: Date | null;
  /** Never holds a credential (table CHECK). */
  lastTestResult: Record<string, unknown> | null;
  rowVersion: number;
}

export interface ConnectionInput {
  kind: string;
  vendor: string;
  settings?: Record<string, unknown>;
  enabled?: boolean;
}

const COLUMNS =
  'id, kind, vendor, settings, enabled, health, last_test_at, last_test_result, row_version';

function toRecord(r: Record<string, unknown>): ConnectionRecord {
  return {
    id: String(r.id),
    kind: String(r.kind),
    vendor: String(r.vendor),
    settings: r.settings as Record<string, unknown>,
    enabled: r.enabled === true,
    health: r.health as ConnectionRecord['health'],
    lastTestAt: (r.last_test_at as Date | null) ?? null,
    lastTestResult: (r.last_test_result as Record<string, unknown> | null) ?? null,
    rowVersion: Number(r.row_version),
  };
}

export const isAdminScope = (s: Readonly<Tx['scope']>): boolean =>
  s.audience === 'staff' &&
  s.realm === 'admin_pool' &&
  s.orgId !== undefined &&
  s.personId !== undefined;

export class ConnectionService {
  constructor(private readonly audit: AuditService) {}

  /** `connectionSettings(kind)`: readable by the admin realm and by jobs (T-CONF(admin), T-SYS). */
  async connectionSettings(tx: Tx, kind: string): Promise<ConnectionRecord | undefined> {
    const r = await tx.query(`SELECT ${COLUMNS} FROM integration_core.connection WHERE kind = $1`, [
      kind,
    ]);
    return r.rows[0] === undefined ? undefined : toRecord(r.rows[0]);
  }

  async list(tx: Tx): Promise<ConnectionRecord[]> {
    const r = await tx.query(`SELECT ${COLUMNS} FROM integration_core.connection ORDER BY kind`);
    return r.rows.map(toRecord);
  }

  /**
   * Create or update the one connection of a kind. Settings must not carry a credential: a key that looks like one is a
   * 422 (the table CHECK is the second wall). Audited as `config_change` with before and after (settings hold no secret).
   */
  async upsert(tx: Tx, meta: RequestMeta, input: ConnectionInput): Promise<ConnectionRecord> {
    if (!isAdminScope(tx.scope)) throw new IntegrationScopeError();
    const problems: string[] = [];
    if (!(CONNECTION_KINDS as readonly string[]).includes(input.kind)) problems.push('kind');
    if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(input.vendor)) problems.push('vendor');
    const settings = input.settings ?? {};
    if (typeof settings !== 'object' || Array.isArray(settings) || settings === null)
      problems.push('settings');
    else if (hasSecretLikeKey(settings) || JSON.stringify(settings).length > 16_384)
      problems.push('settings');
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') problems.push('enabled');
    if (problems.length > 0) throw new IntegrationValidationError(problems);

    const existing = (
      await tx.query(
        `SELECT ${COLUMNS} FROM integration_core.connection WHERE kind = $1 FOR UPDATE`,
        [input.kind],
      )
    ).rows[0];
    let row: Record<string, unknown>;
    if (existing === undefined) {
      row = (
        await tx.query(
          `INSERT INTO integration_core.connection (id, organisation_id, kind, vendor, settings, enabled, created_by)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6, $7::uuid)
           RETURNING ${COLUMNS}`,
          [
            uuidv7(),
            tx.scope.orgId,
            input.kind,
            input.vendor,
            JSON.stringify(settings),
            input.enabled ?? false,
            tx.scope.principalId ?? null,
          ],
        )
      ).rows[0] as Record<string, unknown>;
    } else {
      row = (
        await tx.query(
          `UPDATE integration_core.connection SET vendor = $2, settings = $3::jsonb, enabled = $4 WHERE id = $1::uuid
           RETURNING ${COLUMNS}`,
          [existing.id, input.vendor, JSON.stringify(settings), input.enabled ?? existing.enabled],
        )
      ).rows[0] as Record<string, unknown>;
    }
    const after = toRecord(row);
    await this.audit.record(tx, {
      requestId: meta.requestId,
      action: 'config_change',
      resourceType: 'integration_core.connection',
      resourceId: after.id,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      change: {
        before:
          existing === undefined
            ? null
            : { vendor: existing.vendor, settings: existing.settings, enabled: existing.enabled },
        after: { vendor: after.vendor, settings: after.settings, enabled: after.enabled },
      },
    });
    return after;
  }

  async get(tx: Tx, id: string): Promise<ConnectionRecord> {
    const r = await tx.query(
      `SELECT ${COLUMNS} FROM integration_core.connection WHERE id = $1::uuid`,
      [id],
    );
    if (r.rows[0] === undefined) throw new IntegrationNotFoundError();
    return toRecord(r.rows[0]);
  }
}
