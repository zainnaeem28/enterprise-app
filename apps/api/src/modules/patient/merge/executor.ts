// The execute job of the patient merge (ARCHITECTURE 25.4; SHARED-BOUNDARIES 9.2). One transaction under audience `system`,
// `job_scope = patients`, `job_patient_ids` = exactly the two patients and every ID already merged into either (the merger's own
// location scope plays no part, SBR-03):
//
//   lock (lockPatients, then patient.begin_merge: both roots FOR UPDATE, lower ID first) -> coverage check -> participants
//   (patient first, then every registered one: conflict rules, re-pointing, counts, returned residue) -> patient.complete_merge
//   (counts equation, residue, care relationships, merge map, other open requests cancelled, merged state last, staff_scope)
//   -> audit `merge` with the counts -> publish `patient.merged` (IDs only).
//
// Any failure rolls the whole transaction back; a separate transaction then records `failed` with a code, and the composition root's
// `onFailure` raises the operations alert. Transient failures (deadlock, lock timeout, the 60 s bound) are rethrown for the queue's
// retry until the last attempt. The job lives here, in the module, and is wired to the worker's task table at integration.
import { defaultRegistries } from '@ehr/kernel';
import type { KernelDb, MergeParticipant, ParticipantRegistries, Queue, Tx } from '@ehr/kernel';
import { MergeExecutionError } from './errors.js';
import { patientMergeParticipant } from './participants.js';

type MergeCounts = Awaited<ReturnType<MergeParticipant['repointPatient']>>[number];
type Row = Record<string, unknown>;

/**
 * Tables with a patient_id column that no participant re-points, and why. Every other table with a patient_id column must be
 * listed by a registered participant (a table that is K for every row is listed too and reported as kept, 22.16).
 */
export const NOT_PARTICIPANT_TABLES: Readonly<Record<string, string>> = {
  'audit.event': 'append-only audit; exempt from the guard (9.2)',
  'audit.btg_grant': 'audit; exempt from the guard (9.2)',
  'patient.staff_scope': 'derived; complete_merge recomputes it (6.6)',
  'patient.care_relationship':
    "handled by complete_merge (moved to the survivor, the merged patient's own ended)",
  'patient.merge_residue': 'append-only residue of the merge (K for every row)',
  'privacy.incident_patient': 'records history; exempt from the guard (22.14, 22.16)',
};

export interface ExecuteDeps {
  /** A pool of the worker role (app_worker). */
  db: KernelDb;
  orgId: string;
  /** The participant registries the composition root filled at start-up. Default: the process-wide one. */
  registries?: ParticipantRegistries;
  /** Queue on the worker path; `patient.merged` is published through it in the merge transaction. */
  queue?: Queue;
  /** Called once after `failed` has committed (the operations alert). A throwing hook does not change the outcome. */
  onFailure?: (info: {
    requestId: string;
    code: string;
    errorName: string;
    sqlState?: string;
  }) => Promise<void> | void;
  /** Tables with a patient_id that are not participants; defaults to {@link NOT_PARTICIPANT_TABLES}. */
  notParticipants?: Readonly<Record<string, string>>;
}

export interface ExecuteInput {
  requestId: string;
  jobId: string;
  /** 1-based attempt of the queue job and its limit: the last attempt records `failed` instead of rethrowing a transient error. */
  attempt?: number;
  maxAttempts?: number;
}

export type ExecuteResult =
  | { status: 'completed'; counts: Record<string, Omit<MergeCounts, 'table' | 'deleted'>> }
  | { status: 'failed'; code: string }
  | { status: 'skipped'; requestStatus: string };

// Deadlock, serialization failure, lock timeout, statement timeout, and the transaction bound. PostgreSQL 17's transaction_timeout ends
// the SESSION (25P04, FATAL), which the client reports as a lost connection with no SQLSTATE: that is transient too.
const TRANSIENT = new Set(['40P01', '40001', '55P03', '57014', '25P04', '57P01']);
const connectionLost = (e: unknown): boolean =>
  e instanceof Error &&
  sqlState(e) === undefined &&
  /connection terminated|connection closed/i.test(e.message);
const sqlState = (e: unknown): string | undefined =>
  typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'string'
    ? ((e as { code: string }).code as string)
    : undefined;

function failureCode(e: unknown): string {
  if (e instanceof MergeExecutionError) return e.code;
  switch (sqlState(e)) {
    case 'PM009':
      return 'patient.already_merged';
    case 'PM013':
      return 'patient.merge_count_mismatch';
    default:
      return 'patient.merge_failed';
  }
}

/** Every table with a patient_id column must be a participant's or on the not-participant list. */
async function uncoveredTables(
  tx: Tx,
  covered: ReadonlySet<string>,
  notParticipants: Readonly<Record<string, string>>,
): Promise<string[]> {
  const r = await tx.query(
    `SELECT n.nspname || '.' || c.relname AS t
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE a.attname = 'patient_id' AND NOT a.attisdropped AND c.relkind IN ('r', 'p') AND NOT c.relispartition
        AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'migration', 'queue', 'queue_api')
      ORDER BY 1`,
  );
  return (r.rows as Row[])
    .map((x) => String(x['t']))
    .filter((t) => !covered.has(t) && !(t in notParticipants));
}

async function runMerge(
  tx: Tx,
  deps: ExecuteDeps,
  requestId: string,
  jobId: string,
  survivor: string,
  merged: string,
): Promise<ExecuteResult> {
  const registries = deps.registries ?? defaultRegistries;
  const notParticipants = deps.notParticipants ?? NOT_PARTICIPANT_TABLES;

  // 1. Lock (25.2 rule 1, SBR-12): both roots at the start, ascending; then begin_merge takes them FOR UPDATE.
  await tx.lockPatients([survivor, merged], 'no_key_update');
  await tx.callScopeOwner('patient.begin_merge', [requestId], [survivor, merged]);

  // 2. Participants: the patient module's own first, then every registered one. A module that holds patient data and has no
  // participant fails the merge here, before anything is written (22.16, ticket BE-09).
  const participants: MergeParticipant[] = [
    patientMergeParticipant,
    ...registries.mergeParticipants().filter((p) => p.module !== patientMergeParticipant.module),
  ];
  const covered = new Set(participants.flatMap((p) => [...p.tables]));
  const missing = await uncoveredTables(tx, covered, notParticipants);
  if (missing.length > 0)
    throw new MergeExecutionError(
      'patient.merge_participant_missing',
      `no merge participant for ${missing.join(', ')}`,
    );

  const counts: Record<string, Omit<MergeCounts, 'table' | 'deleted'>> = {};
  const residue: { table: string; rule: string; row: unknown }[] = [];
  for (const p of participants) {
    const reports = await p.repointPatient(tx, merged, survivor, requestId);
    const reported = new Set<string>();
    for (const c of reports) {
      if (!p.tables.includes(c.table) || reported.has(c.table))
        throw new MergeExecutionError(
          'patient.merge_count_mismatch',
          `${p.module} reported ${c.table}, which it does not declare or reported twice`,
        );
      reported.add(c.table);
      if (
        c.found !== c.repointed + c.resolved + c.kept ||
        [c.found, c.repointed, c.resolved, c.kept].some((x) => !Number.isInteger(x) || x < 0)
      )
        throw new MergeExecutionError(
          'patient.merge_count_mismatch',
          `${p.module}: counts do not add up for ${c.table}`,
        );
      counts[c.table] = {
        found: c.found,
        repointed: c.repointed,
        resolved: c.resolved,
        kept: c.kept,
      };
      const rule = p.conflictRules.find((r) => r.table === c.table)?.rule ?? 'unspecified';
      for (const row of c.deleted) residue.push({ table: c.table, rule, row });
    }
    for (const t of p.tables)
      if (!reported.has(t))
        throw new MergeExecutionError(
          'patient.merge_count_mismatch',
          `${p.module} did not report ${t}`,
        );
  }

  // 3. Close: counts equation again in the database, residue, relationships, map, other requests, merged state, staff_scope.
  await tx.callScopeOwner(
    'patient.complete_merge',
    [requestId, JSON.stringify(counts), JSON.stringify(residue)],
    [survivor, merged],
  );

  // 4. Record: the audit row with both IDs and the per-table counts, and the outbox event (IDs only).
  await tx.query(
    `INSERT INTO audit.event (event_id, organisation_id, job_id, realm, audience, action, resource_type, resource_id, patient_id, change, outcome)
     VALUES (gen_random_uuid(), kernel.uuid1('app.org_id'), $1, 'worker', 'system', 'merge', 'patient.merge_request', $2, $3, $4::jsonb, 'allowed')`,
    [
      jobId.slice(0, 200),
      requestId,
      survivor,
      JSON.stringify({ survivorId: survivor, mergedId: merged, counts }),
    ],
  );
  await deps.queue?.publish(tx, 'patient.merged', {
    mergeRequestId: requestId,
    survivorId: survivor,
    mergedId: merged,
  });
  return { status: 'completed', counts };
}

export async function executeMerge(deps: ExecuteDeps, input: ExecuteInput): Promise<ExecuteResult> {
  const orgScope = {
    audience: 'system',
    realm: 'worker',
    orgId: deps.orgId,
    jobScope: 'org',
  } as const;
  const loaded = (
    await deps.db.withScope(orgScope, (tx) =>
      tx.query(
        `SELECT survivor_id, merged_id, status, patient_ids FROM patient.load_merge_job($1::uuid)`,
        [input.requestId],
      ),
    )
  ).rows[0] as Row | undefined;
  if (loaded === undefined)
    throw new MergeExecutionError('kernel.not_found', 'merge request not found');
  const status = String(loaded['status']);
  // A retry after the commit, or a request that was decided otherwise meanwhile: nothing to do, nothing to retry.
  if (status !== 'approved') return { status: 'skipped', requestStatus: status };
  const survivor = String(loaded['survivor_id']);
  const merged = String(loaded['merged_id']);
  const ids = (loaded['patient_ids'] as string[]).map(String);

  try {
    return await deps.db.withScope(
      {
        audience: 'system',
        realm: 'worker',
        orgId: deps.orgId,
        jobScope: 'patients',
        jobPatientIds: ids,
      },
      (tx) => runMerge(tx, deps, input.requestId, input.jobId, survivor, merged),
    );
  } catch (e) {
    const state = sqlState(e);
    const transient = (state !== undefined && TRANSIENT.has(state)) || connectionLost(e);
    if (transient && (input.attempt ?? 1) < (input.maxAttempts ?? 1)) throw e;
    const code = failureCode(e);
    // The session that ran the merge may have been ended by the server (the transaction bound), and a pool can hand that dead
    // connection out once more; the recording is tried again on a fresh one.
    let recorded: boolean;
    for (let tries = 1; ; tries++) {
      try {
        recorded = await deps.db.withScope(orgScope, async (tx) => {
          const r = await tx.query(`SELECT patient.fail_merge($1::uuid, $2) AS ok`, [
            input.requestId,
            code,
          ]);
          return (r.rows[0] as Row | undefined)?.['ok'] === true;
        });
        break;
      } catch (recordErr) {
        if (tries >= 3 || !connectionLost(recordErr)) throw recordErr;
      }
    }
    if (recorded) {
      try {
        await deps.onFailure?.({
          requestId: input.requestId,
          code,
          errorName: e instanceof Error ? e.name : typeof e,
          ...(state === undefined ? {} : { sqlState: state }),
        });
      } catch {
        // The failure is committed; a failing alert hook is the alert path's problem and is surfaced by its own monitoring.
      }
    }
    return { status: 'failed', code };
  }
}
