// Merge and export participation of messaging (ARCHITECTURE 22.12, 22.16, 24; SHARED-BOUNDARIES 9.2): `messaging.repointPatient` and
// `messaging.exportPart`. Both run in the caller's transaction (the merge transaction of 25.4, the export job) as `system` in a
// patients-scope job whose `job_patient_ids` include the IDs involved.
//
//   messaging.thread           R open                        K closed
//   messaging.message          K, append-only: counted as kept and never touched (a message keeps the patient it was written under)
//   messaging.task             R open                        K done, cancelled
//   messaging.thread_participant  has no patient column: not a participant table
//
// Conflict rules: 22.16 gives none ("None") for thread and task. No unique constraint spans two patients (the one partial unique index
// on a task is per source event, which has one patient), so re-pointing cannot collide. A closed thread of the merged patient stays on
// the merged ID: its patient-linked messages are shown through the closure of the patient's IDs.
import { defaultRegistries } from '@ehr/kernel';
import type { MergeParticipant, ParticipantRegistries, Tx } from '@ehr/kernel';
import { MessagingScopeError, MessagingValidationError } from './errors.js';
import { isUuid } from './ids.js';

type MergeCounts = Awaited<ReturnType<MergeParticipant['repointPatient']>>[number];
type ConflictRule = MergeParticipant['conflictRules'][number];
type Row = Record<string, unknown>;

interface Spec {
  table: string;
  /** The R states, or null when every row is K. */
  rStates: readonly string[] | null;
  rule: string;
}

const NO_UNIQUE =
  'No unique constraint spans two patients, so re-pointing cannot collide (22.16: None). ';

export const MESSAGING_SPECS: readonly Spec[] = [
  {
    table: 'messaging.thread',
    rStates: ['open'],
    rule: NO_UNIQUE + 'open is R and moves with its patient; closed is K and stays',
  },
  {
    table: 'messaging.message',
    rStates: null,
    rule: "Append-only, all K: counted as kept, never touched. A new message carries its thread's current patient",
  },
  {
    table: 'messaging.task',
    rStates: ['open'],
    rule: NO_UNIQUE + 'open is R and moves with its patient; done and cancelled are K and stay',
  },
];

export const MESSAGING_MERGE_TABLES = MESSAGING_SPECS.map((s) => s.table);
export const MESSAGING_CONFLICT_RULES: readonly ConflictRule[] = MESSAGING_SPECS.map((s) => ({
  table: s.table,
  rule: s.rule,
}));

function mustBeMergeJob(tx: Tx, ids: readonly string[]): void {
  const s = tx.scope;
  if (s.audience !== 'system' || s.jobScope !== 'patients') throw new MessagingScopeError();
  const allowed = new Set((s.jobPatientIds ?? []).map((x) => x.toLowerCase()));
  for (const id of ids) if (!allowed.has(id.toLowerCase())) throw new MessagingScopeError();
}

const count = async (tx: Tx, sql: string, params: unknown[]): Promise<number> =>
  Number((await tx.query(sql, params)).rows[0]?.['n'] ?? 0);

export const messagingMergeParticipant: MergeParticipant = {
  module: 'messaging',
  tables: MESSAGING_MERGE_TABLES,
  conflictRules: MESSAGING_CONFLICT_RULES,
  async repointPatient(tx, mergedId, survivorId, requestId): Promise<MergeCounts[]> {
    if (!isUuid(mergedId) || !isUuid(survivorId) || !isUuid(requestId))
      throw new MessagingValidationError(['mergedId', 'survivorId', 'requestId']);
    mustBeMergeJob(tx, [mergedId, survivorId]);

    // Lock first, in id order: a concurrent close, completion or post waits, so a row is never read in two states (a task completed
    // while it is being counted would be both R and K). The append-only table cannot change; it is read, not locked.
    for (const s of MESSAGING_SPECS.filter((x) => x.rStates !== null))
      await tx.query(
        `SELECT x.id FROM ${s.table} x WHERE x.patient_id = $1::uuid ORDER BY x.id FOR UPDATE`,
        [mergedId],
      );

    const out: MergeCounts[] = [];
    for (const s of MESSAGING_SPECS) {
      const found = await count(
        tx,
        `SELECT count(*)::int AS n FROM ${s.table} WHERE patient_id = $1::uuid`,
        [mergedId],
      );
      let moved = 0;
      if (s.rStates !== null) {
        const u = await tx.query(
          `UPDATE ${s.table} SET patient_id = $2::uuid WHERE patient_id = $1::uuid AND status = ANY($3::text[])`,
          [mergedId, survivorId, [...s.rStates]],
        );
        moved = u.rowCount ?? 0;
      }
      out.push({
        table: s.table,
        found,
        repointed: moved,
        resolved: 0,
        kept: found - moved,
        deleted: [],
      });
    }

    // 22.16 step 4: no R row may be left on the merged ID, and every table's counts add up.
    for (const s of MESSAGING_SPECS) {
      if (s.rStates === null) continue;
      const left = await count(
        tx,
        `SELECT count(*)::int AS n FROM ${s.table} WHERE patient_id = $1::uuid AND status = ANY($2::text[])`,
        [mergedId, [...s.rStates]],
      );
      if (left !== 0)
        throw new Error(
          `messaging.repointPatient: an R row is left on the merged patient (${s.table})`,
        );
    }
    for (const c of out)
      if (c.found !== c.repointed + c.kept + c.resolved)
        throw new Error(`messaging.repointPatient: counts do not add up for ${c.table}`);
    return out;
  },
};

const iso = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v);

/**
 * The patient's messaging data, for their export (the owner's part, 22.12): the threads about them, the messages written under them and
 * the tasks about them. Staff and patient threads alike: this is the record about the patient (access right, RA-R1-14). Patient
 * messaging itself stays flagged off, but threads that exist while it was on are exported. Participants are not exported (they
 * are staff identifiers, not the patient's data).
 */
export async function messagingExportPart(
  tx: Tx,
  patientIds: readonly string[],
): Promise<Record<string, unknown>> {
  if (patientIds.some((p) => !isUuid(p))) throw new MessagingValidationError(['patientIds']);
  const ids = [...patientIds];
  const threads = await tx.query(
    `SELECT id, kind, patient_id, subject, status, created_at FROM messaging.thread WHERE patient_id = ANY($1::uuid[]) ORDER BY created_at, id`,
    [ids],
  );
  const messages = await tx.query(
    `SELECT id, thread_id, patient_id, author_principal_id, body, attachment_document_ids, sent_at FROM messaging.message WHERE patient_id = ANY($1::uuid[]) ORDER BY sent_at, id`,
    [ids],
  );
  const tasks = await tx.query(
    `SELECT id, patient_id, title, detail, status, due_at, source, completed_at, created_at FROM messaging.task WHERE patient_id = ANY($1::uuid[]) ORDER BY created_at, id`,
    [ids],
  );
  return {
    threads: (threads.rows as Row[]).map((x) => ({
      id: x['id'],
      kind: x['kind'],
      patientId: x['patient_id'],
      subject: x['subject'],
      status: x['status'],
      createdAt: iso(x['created_at']),
    })),
    messages: (messages.rows as Row[]).map((x) => ({
      id: x['id'],
      threadId: x['thread_id'],
      patientId: x['patient_id'],
      authorPrincipalId: x['author_principal_id'],
      body: x['body'],
      attachmentDocumentIds: x['attachment_document_ids'],
      sentAt: iso(x['sent_at']),
    })),
    tasks: (tasks.rows as Row[]).map((x) => ({
      id: x['id'],
      patientId: x['patient_id'],
      title: x['title'],
      detail: x['detail'],
      status: x['status'],
      dueAt: iso(x['due_at']),
      source: x['source'],
      completedAt: iso(x['completed_at']),
      createdAt: iso(x['created_at']),
    })),
  };
}

/** Registers the merge participant and the export contributor with the kernel registries at start-up. A second call is a RegistryError. */
export function registerMessagingParticipants(
  registries: ParticipantRegistries = defaultRegistries,
): void {
  registries.registerMergeParticipant(messagingMergeParticipant);
  registries.registerExportContributor({
    module: 'messaging',
    exportPart: (tx, patientIds) => messagingExportPart(tx, patientIds),
  });
}
