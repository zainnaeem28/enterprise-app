// The patient's download of a finished export (ARCHITECTURE 29.2; SHARED-BOUNDARIES 6.7 step 3): `POST /privacy-requests/{id}/export/download-url`.
// A 60-second URL for the one encrypted package, audited as `export`. Only the patient the package belongs to (own record, never a proxy)
// can ask; another patient's request is 404 (RLS, TC-PR-04); a package that is not `ready` or `released` (still assembling, failed,
// expired) is 409 privacy.export_not_ready. The first download makes it `released`. Compliance has no such route (6.7).
import type { Tx } from '@ehr/kernel';
import type { AuditService } from '../audit/index.js';
import {
  ExportNotReadyError,
  PrivacyNotFoundError,
  PrivacyScopeError,
  translateDbError,
} from './errors.js';
import { isUuid } from './ids.js';
import type { PackageStorePort } from './ports.js';
import type { DownloadUrl, RequestMeta } from './types.js';

type Row = Record<string, unknown>;

export const DOWNLOAD_URL_SECONDS = 60;

export interface PackageDeps {
  audit: Pick<AuditService, 'record'>;
  store: PackageStorePort;
  now?: () => Date;
}

export class PackageService {
  constructor(private readonly deps: PackageDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  async downloadUrl(tx: Tx, meta: RequestMeta, requestId: string): Promise<DownloadUrl> {
    if (tx.scope.audience !== 'patient') throw new PrivacyScopeError();
    if (!isUuid(requestId)) throw new PrivacyNotFoundError();
    // The request is the patient's own (RLS); a package that is not ready is invisible to the patient, so absence means "not ready".
    const req = (
      await tx.query(`SELECT patient_id, kind FROM privacy.request WHERE id = $1::uuid`, [
        requestId,
      ])
    ).rows[0] as Row | undefined;
    if (req === undefined) throw new PrivacyNotFoundError();
    const first = (
      await tx.query(
        `SELECT id, patient_id, status FROM privacy.export_package WHERE request_id = $1::uuid AND status IN ('ready', 'released')
          ORDER BY created_at DESC, id DESC LIMIT 1`,
        [requestId],
      )
    ).rows[0] as Row | undefined;
    if (first === undefined) throw new ExportNotReadyError();
    try {
      // Only the first download writes (ready -> released): it locks the patient root first (25.2) and the package row. A package that is
      // already released is only read (the patient's UPDATE policy reaches `ready` rows alone, so FOR UPDATE would not see it).
      const releasing = first['status'] === 'ready';
      if (releasing) await tx.lockPatients([String(first['patient_id'])], 'key_share');
      const p = (
        await tx.query(
          `SELECT id, patient_id, status, object_key, expires_at FROM privacy.export_package WHERE id = $1::uuid${releasing ? ' FOR UPDATE' : ''}`,
          [first['id']],
        )
      ).rows[0] as Row | undefined;
      if (
        p === undefined ||
        !['ready', 'released'].includes(String(p['status'])) ||
        typeof p['object_key'] !== 'string' ||
        !(p['expires_at'] instanceof Date) ||
        p['expires_at'].getTime() <= this.now().getTime()
      )
        throw new ExportNotReadyError();
      if (releasing && p['status'] === 'ready')
        await tx.query(
          `UPDATE privacy.export_package SET status = 'released', released_at = $2::timestamptz WHERE id = $1::uuid`,
          [p['id'], this.now().toISOString()],
        );
      const url = await this.deps.store.presignGet(
        p['object_key'],
        DOWNLOAD_URL_SECONDS,
        this.now(),
      );
      await this.deps.audit.record(tx, {
        requestId: meta.requestId,
        action: 'export',
        resourceType: 'privacy.export_package',
        resourceId: String(p['id']),
        patientId: String(p['patient_id']),
        reason: 'patient_download',
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
      });
      return { url: url.url, expiresAt: url.expiresAt.toISOString() };
    } catch (e) {
      translateDbError(e);
    }
  }
}
