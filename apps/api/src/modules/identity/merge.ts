// Merge and export participation (ARCHITECTURE 22.16, 24): `identity.repointPatient` for `identity.patient_link` and
// `identity.proxy_grant`, and `identity.exportPart`. Both run in the caller's transaction (the merge transaction of 25.4
// and the export job), as `system` with a patients-scope job whose `job_patient_ids` include the IDs involved.
import { defaultRegistries } from '@ehr/kernel';
import type { ExportContributor, MergeParticipant, ParticipantRegistries, Tx } from '@ehr/kernel';
import { IdentityScopeError, IdentityValidationError } from './errors.js';
import { isUuid } from './ids.js';

// The kernel exports the participant interfaces; the per-table count and rule shapes are derived from them.
type MergeCounts = Awaited<ReturnType<MergeParticipant['repointPatient']>>[number];
type ConflictRule = MergeParticipant['conflictRules'][number];

export const IDENTITY_MERGE_TABLES = ['identity.patient_link', 'identity.proxy_grant'] as const;

export const IDENTITY_CONFLICT_RULES: readonly ConflictRule[] = [
  {
    table: 'identity.patient_link',
    rule: 'PK (principal, patient): if the same principal is linked to both patients, delete the merged-ID link (returned for residue); the survivor link already gives that principal the survivor and, through closure, the merged history',
  },
  {
    table: 'identity.proxy_grant',
    rule: 'UQ open (proxy, patient): keep the most advanced open grant (active > verified > requested; tie -> the survivor\'s); set the other to revoked with revoke_reason merged_duplicate; if the kept grant is the merged patient\'s it is then re-pointed. R: requested, verified, active. K: revoked, expired',
  },
];

const RANK: Record<string, number> = { requested: 1, verified: 2, active: 3 };
type Row = Record<string, unknown>;

function mustBeMergeJob(tx: Tx, ids: readonly string[]): void {
  const s = tx.scope;
  if (s.audience !== 'system' || s.jobScope !== 'patients') throw new IdentityScopeError();
  const allowed = new Set((s.jobPatientIds ?? []).map((x) => x.toLowerCase()));
  for (const id of ids) if (!allowed.has(id.toLowerCase())) throw new IdentityScopeError();
}

async function repointLinks(tx: Tx, mergedId: string, survivorId: string): Promise<MergeCounts> {
  const found = (await tx.query(`SELECT count(*)::int AS n FROM identity.patient_link WHERE patient_id = $1`, [mergedId])).rows[0];
  const total = Number(found?.['n'] ?? 0);
  // Rule: a principal linked to both patients keeps only the survivor link; the merged-ID row is deleted and returned.
  const deleted = (
    await tx.query(
      `DELETE FROM identity.patient_link m USING identity.patient_link s
        WHERE m.patient_id = $1 AND s.patient_id = $2 AND s.principal_id = m.principal_id
        RETURNING m.principal_id, m.patient_id, m.kind, m.linked_at`,
      [mergedId, survivorId],
    )
  ).rows;
  const moved = await tx.query(`UPDATE identity.patient_link SET patient_id = $2 WHERE patient_id = $1`, [mergedId, survivorId]);
  return { table: 'identity.patient_link', found: total, repointed: moved.rowCount ?? 0, resolved: deleted.length, kept: 0, deleted };
}

async function repointProxyGrants(tx: Tx, mergedId: string, survivorId: string): Promise<MergeCounts> {
  const merged = (await tx.query(`SELECT id, proxy_principal_id, status FROM identity.proxy_grant WHERE patient_id = $1 ORDER BY id FOR UPDATE`, [mergedId])).rows;
  const total = merged.length;
  const open = merged.filter((r: Row) => (r['status'] as string) in RANK);
  const kept = total - open.length; // revoked and expired are K: they stay on the merged ID
  let resolved = 0;
  for (const m of open) {
    const s = (
      await tx.query(
        `SELECT id, status FROM identity.proxy_grant WHERE patient_id = $1 AND proxy_principal_id = $2 AND status IN ('requested', 'verified', 'active') FOR UPDATE`,
        [survivorId, m['proxy_principal_id']],
      )
    ).rows[0];
    if (s === undefined) continue;
    // Most advanced wins; a tie goes to the survivor's grant.
    const mergedWins = (RANK[m['status'] as string] ?? 0) > (RANK[s['status'] as string] ?? 0);
    const loser = mergedWins ? (s['id'] as string) : (m['id'] as string);
    await tx.query(`UPDATE identity.proxy_grant SET status = 'revoked', revoked_at = now(), revoke_reason = 'merged_duplicate' WHERE id = $1`, [loser]);
    if (!mergedWins) resolved += 1; // a loser on the merged ID is "resolved" and stays there as K
  }
  const moved = await tx.query(
    `UPDATE identity.proxy_grant SET patient_id = $2 WHERE patient_id = $1 AND status IN ('requested', 'verified', 'active')`,
    [mergedId, survivorId],
  );
  return { table: 'identity.proxy_grant', found: total, repointed: moved.rowCount ?? 0, resolved, kept, deleted: [] };
}

export const identityMergeParticipant: MergeParticipant = {
  module: 'identity',
  tables: IDENTITY_MERGE_TABLES,
  conflictRules: IDENTITY_CONFLICT_RULES,
  async repointPatient(tx: Tx, mergedId: string, survivorId: string, requestId: string): Promise<MergeCounts[]> {
    if (!isUuid(mergedId) || !isUuid(survivorId) || !isUuid(requestId)) throw new IdentityValidationError(['mergedId', 'survivorId', 'requestId']);
    mustBeMergeJob(tx, [mergedId, survivorId]);
    const counts = [await repointLinks(tx, mergedId, survivorId), await repointProxyGrants(tx, mergedId, survivorId)];
    // 22.16 step 4: no R row may be left on the merged ID, and found = re-pointed + resolved + kept.
    const left = (
      await tx.query(
        `SELECT (SELECT count(*) FROM identity.patient_link WHERE patient_id = $1)
              + (SELECT count(*) FROM identity.proxy_grant WHERE patient_id = $1 AND status IN ('requested', 'verified', 'active')) AS n`,
        [mergedId],
      )
    ).rows[0];
    if (Number(left?.['n'] ?? 1) !== 0) throw new Error('identity.repointPatient: an R row is left on the merged patient');
    for (const c of counts) {
      if (c.found !== c.repointed + c.resolved + c.kept) throw new Error(`identity.repointPatient: counts do not add up for ${c.table}`);
    }
    return counts;
  },
};

export const identityExportContributor: ExportContributor = {
  module: 'identity',
  /** What identity holds about the patients: who is linked to them and which proxies exist. No email, no subject, no token. */
  async exportPart(tx: Tx, patientIds: readonly string[], requestId: string): Promise<unknown> {
    if (!isUuid(requestId) || patientIds.length === 0 || patientIds.some((p) => !isUuid(p))) throw new IdentityValidationError(['patientIds', 'requestId']);
    mustBeMergeJob(tx, patientIds);
    const links = await tx.query(
      `SELECT patient_id, principal_id, kind, linked_at FROM identity.patient_link WHERE patient_id = ANY($1::uuid[]) ORDER BY patient_id, principal_id`,
      [patientIds],
    );
    const grants = await tx.query(
      `SELECT id, patient_id, proxy_principal_id, relationship, scope, patient_display_name, status, valid_until, revoked_at, revoke_reason, created_at
         FROM identity.proxy_grant WHERE patient_id = ANY($1::uuid[]) ORDER BY patient_id, created_at, id`,
      [patientIds],
    );
    return { module: 'identity', patientLinks: links.rows, proxyGrants: grants.rows };
  },
};

/** Registers both with the kernel registries (22.16, 24). Called once at start-up; a second call is a RegistryError. */
export function registerIdentityParticipants(registries: ParticipantRegistries = defaultRegistries): void {
  registries.registerMergeParticipant(identityMergeParticipant);
  registries.registerExportContributor(identityExportContributor);
}
