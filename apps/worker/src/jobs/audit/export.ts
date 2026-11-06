// audit.export (key = export ID + chunk). The compliance export, chunked and size limited, and itself audited
// (RA-R1-12, SA-F-11). One run handles one chunk in three short steps so that no object-store call happens inside a
// database transaction (ARCHITECTURE 25): (1) read the job and the next page, (2) put the chunk in the sink,
// (3) record progress and either enqueue the next chunk or finish. Every step is safe to repeat.
import type { KernelDb, Queue } from '@ehr/kernel';
import { ISO_US, systemScope } from './scope.js';

/** Writes encrypted export objects. The S3 implementation is infrastructure (DEVOPS-PLAN) and is injected. */
export interface ExportSink {
  /** Idempotent per (exportId, chunk). */
  putChunk(exportId: string, chunk: number, ndjson: Buffer): Promise<void>;
  /** Seals the object after the last chunk and returns its key. */
  finalize(exportId: string, chunks: number): Promise<{ objectKey: string }>;
}

export interface ExportOptions {
  sink: ExportSink;
  queue: Queue;
  chunkRows?: number;
  /** Ready exports expire after this many hours (default 72). */
  retentionHours?: number;
  defaultMaxRows?: number;
}

export type ExportChunkResult =
  | { status: 'skipped'; reason: 'not_found' | 'finished' | 'already_done' }
  | { status: 'chunk'; chunk: number; rows: number }
  | { status: 'ready'; rowCount: number; objectKey: string }
  | { status: 'failed'; reason: 'too_large' };

interface JobRow {
  status: string;
  filter: Record<string, string>;
  reason: string;
  requestedBy: string;
  rowCount: number;
  chunksDone: number;
  lastAt: string | null;
  lastId: string | null;
}

export async function runExportChunk(
  db: KernelDb,
  orgId: string,
  exportId: string,
  chunk: number,
  opts: ExportOptions,
): Promise<ExportChunkResult> {
  const chunkRows = Math.max(1, Math.floor(opts.chunkRows ?? 5000));
  const maxRowsDefault = opts.defaultMaxRows ?? 1_000_000;

  // Step 1 ---------------------------------------------------------------------------------------------------------
  const step1 = await db.withScope(systemScope(orgId), async (tx) => {
    const j = (
      await tx.query(
        `SELECT status, filter, reason, requested_by_person_id, row_count, chunks_done,
                to_char(last_occurred_at AT TIME ZONE 'UTC', ${ISO_US}) AS last_at, last_event_id
           FROM audit.export_job WHERE id = $1::uuid AND organisation_id = $2::uuid FOR UPDATE`,
        [exportId, orgId],
      )
    ).rows[0];
    if (j === undefined) return { kind: 'skip', reason: 'not_found' } as const;
    if (j.status === 'ready' || j.status === 'failed' || j.status === 'expired')
      return { kind: 'skip', reason: 'finished' } as const;
    const chunksDone = Number(j.chunks_done);
    if (chunk < chunksDone) return { kind: 'skip', reason: 'already_done' } as const;
    if (chunk > chunksDone) throw new Error('audit.export chunk out of order');
    const max = (
      await tx.query(
        `SELECT value FROM kernel.setting WHERE key = 'audit_export_max_rows' AND location_id IS NULL`,
      )
    ).rows[0]?.value;
    const maxRows =
      typeof max === 'number' && Number.isInteger(max) && max > 0 ? max : maxRowsDefault;
    const job: JobRow = {
      status: j.status as string,
      filter: j.filter as Record<string, string>,
      reason: j.reason as string,
      requestedBy: j.requested_by_person_id as string,
      rowCount: Number(j.row_count ?? 0),
      chunksDone,
      lastAt: (j.last_at as string | null) ?? null,
      lastId: (j.last_event_id as string | null) ?? null,
    };
    if (job.status === 'queued')
      await tx.query(`UPDATE audit.export_job SET status = 'running' WHERE id = $1::uuid`, [
        exportId,
      ]);
    const room = maxRows - job.rowCount;
    const take = Math.min(chunkRows, room + 1); // one extra row proves the limit was exceeded
    const f = job.filter;
    const params: unknown[] = [orgId, f.from, f.to, take];
    const where = [
      `e.organisation_id = $1::uuid`,
      `e.occurred_at >= $2::timestamptz`,
      `e.occurred_at < $3::timestamptz`,
    ];
    const add = (col: string, v: string | undefined, cast = ''): void => {
      if (v === undefined) return;
      params.push(v);
      where.push(`e.${col} = $${params.length}${cast}`);
    };
    add('actor_person_id', f.actorPersonId, '::uuid');
    add('patient_id', f.patientId, '::uuid');
    add('action', f.action);
    add('resource_type', f.resourceType);
    if (job.lastAt !== null && job.lastId !== null) {
      params.push(job.lastAt.replace('Z', '+00'), job.lastId);
      where.push(
        `(e.occurred_at, e.event_id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
      );
    }
    const rows = (
      await tx.query(
        `SELECT e.event_id, to_char(e.occurred_at AT TIME ZONE 'UTC', ${ISO_US}) AS occurred_at, e.actor_principal_id,
                e.actor_person_id, e.realm, e.audience, e.action, e.resource_type, e.resource_id, e.patient_id,
                e.location_id, e.btg_grant_id, e.reason, host(e.ip) AS ip, e.user_agent, e.change, e.outcome,
                e.denial_reason, e.request_id, e.job_id
           FROM audit.event e WHERE ${where.join(' AND ')}
          ORDER BY e.occurred_at, e.event_id LIMIT $4`,
        params,
      )
    ).rows;
    if (rows.length > room) {
      await tx.query(`UPDATE audit.export_job SET status = 'failed' WHERE id = $1::uuid`, [
        exportId,
      ]);
      return { kind: 'failed' } as const;
    }
    return { kind: 'page', job, rows } as const;
  });
  if (step1.kind === 'skip') return { status: 'skipped', reason: step1.reason };
  if (step1.kind === 'failed') return { status: 'failed', reason: 'too_large' };

  // Step 2: the object store, outside any transaction. -------------------------------------------------------------
  const { job, rows } = step1;
  if (rows.length > 0) {
    const ndjson = Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    await opts.sink.putChunk(exportId, chunk, ndjson);
  }
  const last = rows[rows.length - 1];
  const finished = rows.length < chunkRows;
  let objectKey: string | undefined;
  if (finished)
    objectKey = (await opts.sink.finalize(exportId, job.chunksDone + (rows.length > 0 ? 1 : 0)))
      .objectKey;

  // Step 3 ---------------------------------------------------------------------------------------------------------
  return db.withScope(systemScope(orgId, job.requestedBy), async (tx) => {
    // Guard against an overlapping retry that already advanced or finished this chunk: re-read under a row lock.
    const cur = (
      await tx.query(
        `SELECT status, chunks_done FROM audit.export_job WHERE id = $1::uuid AND organisation_id = $2::uuid FOR UPDATE`,
        [exportId, orgId],
      )
    ).rows[0];
    if (
      cur === undefined ||
      (cur.status !== 'queued' && cur.status !== 'running') ||
      Number(cur.chunks_done) !== job.chunksDone
    )
      return { status: 'skipped', reason: 'already_done' } as const;
    const total = job.rowCount + rows.length;
    const done = job.chunksDone + (rows.length > 0 ? 1 : 0);
    const cursorAt = last === undefined ? job.lastAt : (last.occurred_at as string);
    const cursorId = last === undefined ? job.lastId : (last.event_id as string);
    if (!finished) {
      await tx.query(
        `UPDATE audit.export_job SET row_count = $2, chunks_done = $3, last_occurred_at = $4::timestamptz, last_event_id = $5::uuid
          WHERE id = $1::uuid`,
        [exportId, total, done, cursorAt?.replace('Z', '+00') ?? null, cursorId],
      );
      await opts.queue.enqueue(
        tx,
        'audit.export',
        { exportId, organisationId: orgId, chunk: chunk + 1 },
        { jobKey: `${exportId}:${chunk + 1}` },
      );
      return { status: 'chunk', chunk, rows: rows.length } as const;
    }
    await tx.query(
      `UPDATE audit.export_job
          SET status = 'ready', row_count = $2, chunks_done = $3, object_key = $4,
              expires_at = now() + make_interval(hours => $5::int)
        WHERE id = $1::uuid`,
      [exportId, total, done, objectKey, Math.floor(opts.retentionHours ?? 72)],
    );
    // The export itself is audited (8.1 rule 4): one summary row with the requester as the actor and the reason they
    // gave. It commits with the status change, so a retry (which sees `ready` and stops) cannot add a second row.
    await tx.query(
      `INSERT INTO audit.event (event_id, organisation_id, job_id, actor_person_id, realm, audience, action, resource_type,
                                resource_id, reason, outcome)
       VALUES (gen_random_uuid(), $2, $3, $4, 'worker', 'system', 'export', 'audit.export_job', $1::uuid, $5, 'allowed')`,
      [exportId, orgId, `audit.export:${exportId}`, job.requestedBy, job.reason],
    );
    return { status: 'ready', rowCount: total, objectKey: objectKey as string } as const;
  });
}
