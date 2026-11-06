// Merge request, approval and read (ARCHITECTURE 25.4, 29.3; SHARED-BOUNDARIES 9.2, BQ-3). Everything that decides is a database
// function of migration 0803 (they check the caller's scope settings; the API guard has already checked the permission). This class
// validates the body, calls them in the caller's transaction, translates their class-P errors and, on approval, enqueues the
// execute job in the same transaction so the approval and the job commit together or not at all.
import type { Queue, Tx } from '@ehr/kernel';
import { PatientValidationError } from '../errors.js';
import { isUuid } from '../ids.js';
import type { RequestMeta } from '../types.js';
import { EXECUTE_MERGE_JOB } from './jobs.js';
import { translateMergeDbError } from './errors.js';

type Row = Record<string, unknown>;

export type MergeStatus =
  'requested' | 'approved' | 'rejected' | 'executing' | 'completed' | 'failed' | 'cancelled';

export interface MergeRequestView {
  id: string;
  survivorId: string;
  mergedId: string;
  status: MergeStatus;
  reason: string;
  createdAt: string;
  decidedAt: string | null;
  failureCode: string | null;
  /** Per participant table: found, re-pointed, resolved, kept. Present after completion only. */
  counts: Record<string, unknown> | null;
}

const iso = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : null;

function view(r: Row): MergeRequestView {
  return {
    id: String(r['id']),
    survivorId: String(r['survivor_id']),
    mergedId: String(r['merged_id']),
    status: String(r['status']) as MergeStatus,
    reason: String(r['reason']),
    createdAt: iso(r['created_at']) ?? '',
    decidedAt: iso(r['decided_at']),
    failureCode: r['failure_code'] === null ? null : String(r['failure_code']),
    counts: (r['counts'] ?? null) as Record<string, unknown> | null,
  };
}

export interface MergeServiceDeps {
  /** Queue on the API path with `patient.execute_merge` defined in its registry. */
  queue: Queue;
}

export class MergeService {
  constructor(private readonly deps: MergeServiceDeps) {}

  /** `POST /patient-merges` (staff, `patient.merge.request`): both patients visible to the caller and active. */
  async request(
    tx: Tx,
    meta: RequestMeta,
    body: unknown,
  ): Promise<{ id: string; status: 'requested' }> {
    const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const bad: string[] = [];
    if (!isUuid(b['survivorId'])) bad.push('survivorId');
    if (!isUuid(b['mergedId'])) bad.push('mergedId');
    if (
      typeof b['reason'] !== 'string' ||
      b['reason'].trim().length < 1 ||
      b['reason'].trim().length > 500
    )
      bad.push('reason');
    if (
      bad.length === 0 &&
      String(b['survivorId']).toLowerCase() === String(b['mergedId']).toLowerCase()
    )
      bad.push('mergedId');
    if (bad.length > 0) throw new PatientValidationError(bad);
    try {
      const r = await tx.query(
        `SELECT patient.request_merge($1::uuid, $2::uuid, $3::uuid, $4) AS id`,
        [
          meta.requestId,
          String(b['survivorId']).toLowerCase(),
          String(b['mergedId']).toLowerCase(),
          b['reason'],
        ],
      );
      return { id: String((r.rows[0] as Row)['id']), status: 'requested' };
    } catch (e) {
      return translateMergeDbError(e);
    }
  }

  /** `GET /patient-merges/{id}`: undefined when absent. */
  async get(tx: Tx, id: string): Promise<MergeRequestView | undefined> {
    if (!isUuid(id)) return undefined;
    const r = await tx.query(`SELECT * FROM patient.get_merge_request($1::uuid)`, [id]);
    return r.rows[0] === undefined ? undefined : view(r.rows[0] as Row);
  }

  /**
   * `POST /patient-merges/{id}/approve|reject` (staff, `patient.merge.approve`): a second person decides. An approval enqueues
   * `patient.execute_merge` in this transaction (job key = the request ID, so a repeated approval never queues a second job).
   */
  async decide(
    tx: Tx,
    meta: RequestMeta,
    id: string,
    decision: 'approve' | 'reject',
  ): Promise<MergeRequestView> {
    if (!isUuid(id)) throw new PatientValidationError(['id']);
    let row: Row;
    try {
      const r = await tx.query(`SELECT * FROM patient.decide_merge($1::uuid, $2::uuid, $3)`, [
        meta.requestId,
        id,
        decision,
      ]);
      row = r.rows[0] as Row;
    } catch (e) {
      return translateMergeDbError(e);
    }
    if (decision === 'approve')
      await this.deps.queue.enqueue(tx, EXECUTE_MERGE_JOB, { mergeRequestId: id }, { jobKey: id });
    return view(row);
  }
}
