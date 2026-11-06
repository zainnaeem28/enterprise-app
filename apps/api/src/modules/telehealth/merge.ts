// Merge and export participation of telehealth (ARCHITECTURE 22.16, 24, 38.2 item 11; SHARED-BOUNDARIES 9.2). One participant for the
// module's four tables with a patient (the registry takes one per module):
//
//   table                          R (re-pointed)                      K (kept, never written again)   conflict rule
//   telehealth.video_session       scheduled, open                     ended, failed                    none (UQ is the reservation)
//   telehealth.participant         its session is scheduled or open    its session is ended or failed   none (UQ per session and principal)
//   telehealth.join_token          issued                              used, revoked                    none (UQ is per participant, live only)
//   telehealth.location_confirmation  none                             every row (append-only)          none
//
// `join_token` is the ticket's "join-token table" (departure 1 of 1500). Its R state is the token's own status, not its session's: the
// database lets only an `issued` token change (1501), and a token is revoked before its session ends, so "issued" and "session live"
// coincide; the status is the exact set the trigger accepts an update for, which is what TDR-02 (c) asks of an R state.
//
// Every table: found = re-pointed + resolved + kept (SHARED-BOUNDARIES 9.2); no R row may be left on the merged ID (22.16 step 4). The
// order is sessions, participants, tokens: participants and tokens are matched to their session by the session's ID, never by its patient.
import { defaultRegistries } from '@ehr/kernel';
import type { ExportContributor, MergeParticipant, ParticipantRegistries, Tx } from '@ehr/kernel';
import { TelehealthScopeError, TelehealthValidationError } from './errors.js';
import { isUuid } from './ids.js';

type MergeCounts = Awaited<ReturnType<MergeParticipant['repointPatient']>>[number];
type ConflictRule = MergeParticipant['conflictRules'][number];
type Row = Record<string, unknown>;

export const TELEHEALTH_MERGE_TABLES = [
  'telehealth.video_session',
  'telehealth.participant',
  'telehealth.join_token',
  'telehealth.location_confirmation',
] as const;

export const TELEHEALTH_CONFLICT_RULES: readonly ConflictRule[] = [
  {
    table: 'telehealth.video_session',
    rule: 'No unique constraint on the patient (UQ is the reservation). R: scheduled, open. K: ended, failed',
  },
  {
    table: 'telehealth.participant',
    rule: 'No unique constraint on the patient (UQ per session and principal). R: its session is scheduled or open. K: its session is ended or failed',
  },
  {
    table: 'telehealth.join_token',
    rule: 'No unique constraint on the patient (UQ is per participant, live tokens only). R: issued. K: used, revoked',
  },
  {
    table: 'telehealth.location_confirmation',
    rule: 'Append-only: K for every row, kept on the merged ID and never re-pointed',
  },
];

function mustBeMergeJob(tx: Tx, ids: readonly string[]): void {
  const s = tx.scope;
  if (s.audience !== 'system' || s.jobScope !== 'patients') throw new TelehealthScopeError();
  const allowed = new Set((s.jobPatientIds ?? []).map((x) => x.toLowerCase()));
  for (const id of ids) if (!allowed.has(id.toLowerCase())) throw new TelehealthScopeError();
}

const count = async (tx: Tx, sql: string, params: unknown[]): Promise<number> =>
  Number((await tx.query(sql, params)).rows[0]?.['n'] ?? 0);

/**
 * One table with no conflict rule. `isR` is a predicate over the alias `t` (and `o`, an optional second table joined on `joinOn`). The
 * rows are locked first, in ID order, so a concurrent writer waits instead of moving a row between R and K after it was counted.
 */
async function repointSimple(
  tx: Tx,
  table: string,
  isR: string,
  mergedId: string,
  survivorId: string,
  other?: { table: string; joinOn: string },
): Promise<MergeCounts> {
  const from = other === undefined ? '' : `, ${other.table} o`;
  const on = other === undefined ? 'true' : other.joinOn;
  await tx.query(
    `SELECT t.id FROM ${table} t WHERE t.patient_id = $1::uuid ORDER BY t.id FOR UPDATE OF t`,
    [mergedId],
  );
  const found = await count(
    tx,
    `SELECT count(*)::int AS n FROM ${table} t WHERE t.patient_id = $1::uuid`,
    [mergedId],
  );
  const kept = await count(
    tx,
    `SELECT count(*)::int AS n FROM ${table} t${from} WHERE t.patient_id = $1::uuid AND ${on} AND NOT (${isR})`,
    [mergedId],
  );
  const moved = await tx.query(
    `UPDATE ${table} t SET patient_id = $2::uuid ${other === undefined ? '' : `FROM ${other.table} o`}
      WHERE t.patient_id = $1::uuid AND ${on} AND (${isR})`,
    [mergedId, survivorId],
  );
  const left = await count(
    tx,
    `SELECT count(*)::int AS n FROM ${table} t${from} WHERE t.patient_id = $1::uuid AND ${on} AND (${isR})`,
    [mergedId],
  );
  if (left !== 0)
    throw new Error(
      `telehealth.repointPatient: an R row is left on the merged patient in ${table}`,
    );
  const repointed = moved.rowCount ?? 0;
  if (found !== repointed + kept)
    throw new Error(`telehealth.repointPatient: counts do not add up for ${table}`);
  return { table, found, repointed, resolved: 0, kept, deleted: [] };
}

/** A table whose every row is K: counted, never touched. */
async function keptOnly(tx: Tx, table: string, mergedId: string): Promise<MergeCounts> {
  const n = await count(tx, `SELECT count(*)::int AS n FROM ${table} WHERE patient_id = $1::uuid`, [
    mergedId,
  ]);
  return { table, found: n, repointed: 0, resolved: 0, kept: n, deleted: [] };
}

export const telehealthMergeParticipant: MergeParticipant = {
  module: 'telehealth',
  tables: TELEHEALTH_MERGE_TABLES,
  conflictRules: TELEHEALTH_CONFLICT_RULES,
  async repointPatient(tx, mergedId, survivorId, requestId): Promise<MergeCounts[]> {
    if (!isUuid(mergedId) || !isUuid(survivorId) || !isUuid(requestId))
      throw new TelehealthValidationError(['mergedId', 'survivorId', 'requestId']);
    mustBeMergeJob(tx, [mergedId, survivorId]);
    const sessions = await repointSimple(
      tx,
      'telehealth.video_session',
      `t.status IN ('scheduled', 'open')`,
      mergedId,
      survivorId,
    );
    const participants = await repointSimple(
      tx,
      'telehealth.participant',
      `o.status IN ('scheduled', 'open')`,
      mergedId,
      survivorId,
      { table: 'telehealth.video_session', joinOn: 'o.id = t.session_id' },
    );
    const tokens = await repointSimple(
      tx,
      'telehealth.join_token',
      `t.status = 'issued'`,
      mergedId,
      survivorId,
    );
    const confirmations = await keptOnly(tx, 'telehealth.location_confirmation', mergedId);
    return [sessions, participants, tokens, confirmations];
  },
};

const iso = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v);

/**
 * The privacy export part (22.16, 24): identifiers, states, times and the pass/fail device check. No vendor reference, no token (none
 * is stored), no free text.
 */
export const telehealthExportContributor: ExportContributor = {
  module: 'telehealth',
  async exportPart(tx: Tx, patientIds: readonly string[]): Promise<unknown> {
    if (patientIds.some((p) => !isUuid(p))) throw new TelehealthValidationError(['patientIds']);
    const ids = [...patientIds];
    const sessions = await tx.query(
      `SELECT id, reservation_id, patient_id, clinician_principal_id, status, opened_at, ended_at
         FROM telehealth.video_session WHERE patient_id = ANY($1::uuid[]) ORDER BY created_at, id`,
      [ids],
    );
    const participants = await tx.query(
      `SELECT id, session_id, patient_id, role, admission, waiting_since, joined_at, left_at, device_check
         FROM telehealth.participant WHERE patient_id = ANY($1::uuid[]) ORDER BY created_at, id`,
      [ids],
    );
    const confirmations = await tx.query(
      `SELECT id, reservation_id, patient_id, stated_state, confirmed_at, result, override_reason
         FROM telehealth.location_confirmation WHERE patient_id = ANY($1::uuid[]) ORDER BY confirmed_at, id`,
      [ids],
    );
    return {
      videoSessions: (sessions.rows as Row[]).map((x) => ({
        id: x['id'],
        reservationId: x['reservation_id'],
        patientId: x['patient_id'],
        clinicianId: x['clinician_principal_id'],
        status: x['status'],
        openedAt: iso(x['opened_at']),
        endedAt: iso(x['ended_at']),
      })),
      videoParticipants: (participants.rows as Row[]).map((x) => ({
        id: x['id'],
        sessionId: x['session_id'],
        patientId: x['patient_id'],
        role: x['role'],
        admission: x['admission'],
        waitingSince: iso(x['waiting_since']),
        joinedAt: iso(x['joined_at']),
        leftAt: iso(x['left_at']),
        deviceCheck: x['device_check'],
      })),
      locationConfirmations: (confirmations.rows as Row[]).map((x) => ({
        id: x['id'],
        reservationId: x['reservation_id'],
        patientId: x['patient_id'],
        statedState: x['stated_state'],
        confirmedAt: iso(x['confirmed_at']),
        result: x['result'],
        overrideReason: x['override_reason'],
      })),
    };
  },
};

/** Registers the module's whole participation with the kernel registries at start-up. A second call is a RegistryError. */
export function registerTelehealthParticipants(
  registries: ParticipantRegistries = defaultRegistries,
): void {
  registries.registerMergeParticipant(telehealthMergeParticipant);
  registries.registerExportContributor(telehealthExportContributor);
}
