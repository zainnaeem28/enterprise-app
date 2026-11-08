// Export assembly: the body of the worker job `privacy.assemble_export` (ARCHITECTURE 33.1; SHARED-BOUNDARIES 6.7 step 2; TICKETS BE-20).
// It consumes the participant registry of the kernel (ARCHITECTURE 22.16, 24) and holds NO per-module code: what a module contributes is
// whatever its registered `ExportContributor.exportPart` returns.
//
//   1. claim      the package row and its request, in a short transaction under an organisation-wide system scope. A package that is not
//                 `assembling`, or a request that is not `in_progress`, ends the job (a finished package is kept).
//   2. coverage   every module that holds patient data must have a contributor (the schemas that own a table with a `patient_id` column,
//                 less the two the owner covers itself: `audit` through `disclosuresFor`, `privacy` through its own part). A module
//                 with data and no contributor FAILS the job before anything is read (`privacy.contributor_missing`); the package is
//                 `failed` and compliance sees it. This is the same rule the merge executor applies to its participants.
//   3. chunks     each contributor's part is produced in ITS OWN short transaction under a patients-scope system scope whose IDs are the
//                 patient's and every ID merged into it (the closure); progress and one audit event per part are written in a second
//                 short transaction. The accounting of disclosures (`audit.disclosuresFor`) comes last, one page per transaction, so it
//                 includes the events of the parts above.
//   4. package    the parts are put together into one gzip'd JSON document and written to the package store under a random key; then
//                 (one transaction) the package is `ready` with its expiry, the request is `fulfilled`, an audit event is written and
//                 `privacy.export_ready` is published (the patient's notice is notifications' handler: no PHI in it, TC-PR-02).
// A merge that moves the package to another patient while it is being assembled restarts the assembly for the new closure (at most
// three times). A transient error is rethrown for the queue's retry; a failure that no retry changes marks the package `failed`.
import { createHash, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { defaultRegistries } from '@ehr/kernel';
import type {
  ExportContributor,
  KernelDb,
  Logger,
  ParticipantRegistries,
  Queue,
  Tx,
} from '@ehr/kernel';
import type { AuditService } from '../audit/index.js';
import { ExportAssemblyError } from './errors.js';
import { isUuid } from './ids.js';
import type { PackageWriterPort } from './ports.js';
import { DEFAULT_EXPORT_EXPIRY_DAYS } from './requests.js';
import { privacyExportPart } from './merge.js';
import { patientsScope, systemScope } from './scope.js';

type Row = Record<string, unknown>;

/** Schemas whose tables hold patient data but are not export contributors: the owner covers them itself. */
export const OWNER_COVERED: Readonly<Record<string, string>> = {
  audit: 'accounting of disclosures: audit.disclosuresFor',
  privacy: "the patient's privacy requests: the owner's own part",
};

const CATALOG_SQL = `
  SELECT DISTINCT n.nspname AS module
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE a.attname = 'patient_id' AND NOT a.attisdropped AND c.relkind IN ('r', 'p') AND NOT c.relispartition
     AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'migration', 'queue', 'queue_api')
   ORDER BY 1`;

export interface AssembleDeps {
  /** A pool of the worker role (app_worker). */
  db: KernelDb;
  orgId: string;
  audit: Pick<AuditService, 'record' | 'disclosuresFor'>;
  /** The package store with write access (worker side). */
  writer: PackageWriterPort;
  /** `patient.closure(id)`: the patient and every ID merged into it, run in the transaction handed in. */
  closureOf: (tx: Tx, patientId: string) => Promise<string[]>;
  /** The participant registries the composition root filled at start-up. Default: the process-wide one. */
  registries?: ParticipantRegistries;
  /**
   * Contributors of modules BELOW `privacy`, which are called downwards through their published function and listed explicitly
   * (SHARED-BOUNDARIES 3.2 rule 6): `patient.exportPart` when it exists. They count for the coverage check like a registered one.
   */
  downward?: readonly ExportContributor[];
  /** Schemas that hold patient data and are not contributors; defaults to {@link OWNER_COVERED}. */
  ownerCovered?: Readonly<Record<string, string>>;
  /** Worker-path queue for `privacy.export_ready`. */
  queue?: Queue;
  /** Called once after `failed` has committed (the operations alert). A throwing hook does not change the outcome. */
  onFailure?: (info: { packageId: string; code: string }) => Promise<void> | void;
  log?: Logger;
  /** Largest package accepted, in bytes (default 256 MiB). */
  maxBytes?: number;
  /** Days a ready package stays available (default {@link DEFAULT_EXPORT_EXPIRY_DAYS}). */
  expiryDays?: number;
  now?: () => Date;
}

export interface AssembleInput {
  packageId: string;
  jobId: string;
  /** 1-based attempt of the queue job and its limit: the last attempt records `failed` instead of rethrowing a transient error. */
  attempt?: number;
  maxAttempts?: number;
}

export type AssembleResult =
  | { status: 'ready'; parts: Record<string, { items: number; bytes: number }>; sizeBytes: number }
  | { status: 'failed'; code: string }
  | { status: 'skipped'; reason: string };

const countItems = (part: unknown): number => {
  if (Array.isArray(part)) return part.length;
  if (part !== null && typeof part === 'object') {
    let n = 0;
    for (const v of Object.values(part as Row)) n += Array.isArray(v) ? v.length : 1;
    return n;
  }
  return part === null || part === undefined ? 0 : 1;
};

const TRANSIENT = new Set(['40P01', '40001', '55P03', '57014', '25P04', '57P01']);
const sqlState = (e: unknown): string | undefined =>
  typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'string'
    ? (e as { code: string }).code
    : undefined;
const transient = (e: unknown): boolean =>
  (sqlState(e) !== undefined && TRANSIENT.has(sqlState(e) as string)) ||
  (e instanceof Error &&
    sqlState(e) === undefined &&
    /connection terminated|connection closed/i.test(e.message));

/** The modules (schemas) that hold patient data and need a contributor, from the catalog. */
export async function patientDataModules(
  tx: Tx,
  ownerCovered: Readonly<Record<string, string>> = OWNER_COVERED,
): Promise<string[]> {
  const r = await tx.query(CATALOG_SQL);
  return (r.rows as Row[]).map((x) => String(x['module'])).filter((m) => !(m in ownerCovered));
}

export async function assembleExport(
  deps: AssembleDeps,
  input: AssembleInput,
): Promise<AssembleResult> {
  if (!isUuid(input.packageId))
    throw new ExportAssemblyError('privacy.bad_payload', 'bad package id');
  const packageId = input.packageId.toLowerCase();
  const now = deps.now ?? ((): Date => new Date());
  try {
    for (let round = 1; ; round++) {
      const out = await attempt(deps, input, packageId, now);
      if (out !== 'moved') return out;
      if (round >= 3)
        throw new ExportAssemblyError('privacy.patient_moved', 'the patient was merged repeatedly');
    }
  } catch (e) {
    if (e instanceof ExportAssemblyError) return fail(deps, packageId, input.jobId, e.code);
    const last = input.attempt !== undefined && input.attempt >= (input.maxAttempts ?? 1);
    if (transient(e) && !last) throw e;
    deps.log?.error('export assembly failed', {
      errorName: e instanceof Error ? e.name : typeof e,
      sqlstate: sqlState(e),
    });
    return fail(deps, packageId, input.jobId, 'privacy.assembly_failed');
  }
}

async function fail(
  deps: AssembleDeps,
  packageId: string,
  jobId: string,
  code: string,
): Promise<AssembleResult> {
  // The failure is recorded in its own transaction after the work's has rolled back. A package that is no longer assembling is left.
  const done = await deps.db.withScope(systemScope(deps.orgId), async (tx) => {
    const p = (
      await tx.query(
        `SELECT id, patient_id, status FROM privacy.export_package WHERE id = $1::uuid`,
        [packageId],
      )
    ).rows[0] as Row | undefined;
    if (p === undefined || p['status'] !== 'assembling') return false;
    await tx.lockPatients([String(p['patient_id'])], 'key_share');
    await tx.query(
      `UPDATE privacy.export_package SET status = 'failed', failure_code = $2 WHERE id = $1::uuid AND status = 'assembling'`,
      [packageId, code],
    );
    await deps.audit.record(tx, {
      jobId: jobId.slice(0, 200),
      action: 'update',
      resourceType: 'privacy.export_package',
      resourceId: packageId,
      patientId: String(p['patient_id']),
      change: { status: 'failed', code },
    });
    return true;
  });
  if (done && deps.onFailure !== undefined) {
    try {
      await deps.onFailure({ packageId, code });
    } catch {
      // an alert hook that throws changes nothing
    }
  }
  return done ? { status: 'failed', code } : { status: 'skipped', reason: 'not_assembling' };
}

async function attempt(
  deps: AssembleDeps,
  input: AssembleInput,
  packageId: string,
  now: () => Date,
): Promise<AssembleResult | 'moved'> {
  const registries = deps.registries ?? defaultRegistries;
  const ownerCovered = deps.ownerCovered ?? OWNER_COVERED;

  // 1. claim -------------------------------------------------------------------------------------------------------------------
  const claim = await deps.db.withScope(systemScope(deps.orgId), async (tx) => {
    const r = (
      await tx.query(
        `SELECT p.status AS package_status, p.patient_id, p.request_id, r.status AS request_status, r.kind
           FROM privacy.export_package p JOIN privacy.request r ON r.id = p.request_id WHERE p.id = $1::uuid`,
        [packageId],
      )
    ).rows[0] as Row | undefined;
    if (r === undefined) return { kind: 'skip' as const, reason: 'gone' };
    if (r['package_status'] !== 'assembling' || r['request_status'] !== 'in_progress')
      return { kind: 'skip' as const, reason: 'not_assembling' };
    const patientId = String(r['patient_id']);
    return {
      kind: 'go' as const,
      patientId,
      requestId: String(r['request_id']),
      ids: await deps.closureOf(tx, patientId),
      required: await patientDataModules(tx, ownerCovered),
    };
  });
  if (claim.kind === 'skip') return { status: 'skipped', reason: claim.reason };
  const { patientId, requestId, required } = claim;
  const ids = [...new Set([patientId, ...claim.ids])].sort();

  // 2. coverage ----------------------------------------------------------------------------------------------------------------
  const downward = deps.downward ?? [];
  const contributors: ExportContributor[] = [...registries.exportContributors()];
  for (const d of downward) {
    if (contributors.some((c) => c.module === d.module))
      throw new ExportAssemblyError(
        'privacy.contributor_duplicate',
        `${d.module} is both registered and called downwards`,
      );
    contributors.push(d);
  }
  // The owner's own part (the patient's privacy requests) is produced the same way, in its own transaction.
  contributors.push({
    module: 'privacy',
    exportPart: (tx, patientIds) => privacyExportPart(tx, patientIds),
  });
  contributors.sort((a, b) => (a.module < b.module ? -1 : a.module > b.module ? 1 : 0));
  const have = new Set(contributors.map((c) => c.module));
  const missing = required.filter((m) => !have.has(m));
  if (missing.length > 0)
    throw new ExportAssemblyError(
      'privacy.contributor_missing',
      `no export contributor for ${missing.join(', ')}`,
    );

  // 3. chunks ------------------------------------------------------------------------------------------------------------------
  const scope = patientsScope(deps.orgId, ids);
  const parts: Record<string, unknown> = {};
  const counts: Record<string, { items: number; bytes: number }> = {};
  const hashes: Record<string, string> = {};
  let total = 0;
  const maxBytes = deps.maxBytes ?? 256 * 1024 * 1024;
  /** Where the package is now, when the job's own scope no longer reaches it: a merge moved it, or it is no longer assembling. */
  const whereIs = (): Promise<'moved' | 'gone'> =>
    deps.db.withScope(systemScope(deps.orgId), async (tx) => {
      const r = (
        await tx.query(
          `SELECT patient_id, status FROM privacy.export_package WHERE id = $1::uuid`,
          [packageId],
        )
      ).rows[0] as Row | undefined;
      return r !== undefined &&
        r['status'] === 'assembling' &&
        String(r['patient_id']) !== patientId
        ? 'moved'
        : 'gone';
    });
  const progress = async (module: string, why: string): Promise<'ok' | 'moved' | 'gone'> => {
    const wrote = await deps.db.withScope(scope, async (tx) => {
      await tx.lockPatients([patientId], 'key_share');
      const u = await tx.query(
        `UPDATE privacy.export_package SET part_counts = $2::jsonb WHERE id = $1::uuid AND status = 'assembling'`,
        [packageId, JSON.stringify(counts)],
      );
      if ((u.rowCount ?? 0) === 0) return false;
      await deps.audit.record(tx, {
        jobId: input.jobId.slice(0, 200),
        action: 'export',
        resourceType: 'privacy.export_package',
        resourceId: packageId,
        patientId,
        reason: why,
        change: { module, items: counts[module]?.items ?? 0, bytes: counts[module]?.bytes ?? 0 },
      });
      return true;
    });
    return wrote ? 'ok' : whereIs();
  };
  const stopped = async (
    r: 'ok' | 'moved' | 'gone',
  ): Promise<AssembleResult | 'moved' | undefined> =>
    r === 'ok'
      ? undefined
      : r === 'moved'
        ? 'moved'
        : { status: 'skipped', reason: 'not_assembling' };
  for (const c of contributors) {
    const part = await deps.db.withScope(scope, (tx) => c.exportPart(tx, ids, requestId));
    const json = JSON.stringify(part ?? null);
    const bytes = Buffer.byteLength(json);
    total += bytes;
    if (total > maxBytes)
      throw new ExportAssemblyError('privacy.export_too_large', 'package over the limit');
    parts[c.module] = part ?? null;
    counts[c.module] = { items: countItems(part), bytes };
    hashes[c.module] = createHash('sha256').update(json).digest('hex');
    const s = await stopped(await progress(c.module, 'assemble_part'));
    if (s !== undefined) return s;
  }
  // The accounting of disclosures: last, one page per transaction.
  const events: unknown[] = [];
  let after: { occurredAt: string; eventId: string } | undefined;
  for (;;) {
    const page = await deps.db.withScope(scope, (tx) =>
      deps.audit.disclosuresFor(tx, ids, {
        limit: 1000,
        ...(after === undefined ? {} : { after }),
      }),
    );
    events.push(...page.events);
    if (page.next === null) break;
    after = page.next;
  }
  const disclosures = { events };
  const dj = JSON.stringify(disclosures);
  total += Buffer.byteLength(dj);
  if (total > maxBytes)
    throw new ExportAssemblyError('privacy.export_too_large', 'package over the limit');
  counts['audit'] = { items: events.length, bytes: Buffer.byteLength(dj) };
  hashes['audit'] = createHash('sha256').update(dj).digest('hex');
  const sa = await stopped(await progress('audit', 'assemble_disclosures'));
  if (sa !== undefined) return sa;

  // 4. package -----------------------------------------------------------------------------------------------------------------
  const generatedAt = now();
  const bundle = JSON.stringify({
    manifest: {
      format: 'ehr-privacy-export/1',
      requestId,
      packageId,
      generatedAt: generatedAt.toISOString(),
      patientIds: ids,
      parts: Object.fromEntries(
        Object.entries(counts).map(([m, c]) => [m, { ...c, sha256: hashes[m] }]),
      ),
    },
    parts,
    accountingOfDisclosures: disclosures,
  });
  const body = gzipSync(Buffer.from(bundle, 'utf8'));
  const key = `p/${randomBytes(16).toString('hex')}`;
  await deps.writer.put(key, body, 'application/gzip');
  const expires = new Date(
    generatedAt.getTime() + (deps.expiryDays ?? DEFAULT_EXPORT_EXPIRY_DAYS) * 86_400_000,
  );
  try {
    const moved = await deps.db.withScope(scope, async (tx) => {
      await tx.lockPatients([patientId], 'key_share');
      const cur = (
        await tx.query(
          `SELECT patient_id, status FROM privacy.export_package WHERE id = $1::uuid FOR UPDATE`,
          [packageId],
        )
      ).rows[0] as Row | undefined;
      if (cur === undefined || cur['status'] !== 'assembling') return 'gone' as const;
      await tx.query(
        `UPDATE privacy.export_package SET status = 'ready', object_key = $2, size_bytes = $3, expires_at = $4::timestamptz, part_counts = $5::jsonb
          WHERE id = $1::uuid`,
        [packageId, key, body.length, expires.toISOString(), JSON.stringify(counts)],
      );
      await tx.query(
        `UPDATE privacy.request SET status = 'fulfilled' WHERE id = $1::uuid AND status = 'in_progress'`,
        [requestId],
      );
      await deps.audit.record(tx, {
        jobId: input.jobId.slice(0, 200),
        action: 'create',
        resourceType: 'privacy.export_package',
        resourceId: packageId,
        patientId,
        change: { status: 'ready', parts: Object.keys(counts).length },
      });
      if (deps.queue !== undefined)
        await deps.queue.publish(tx, 'privacy.export_ready', { requestId, patientId });
      return 'ok' as const;
    });
    if (moved === 'gone') {
      // Not reachable under the old scope any more: a merge moved the package, or it is no longer assembling.
      await deps.writer.remove(key);
      return (await whereIs()) === 'moved'
        ? 'moved'
        : { status: 'skipped', reason: 'not_assembling' };
    }
  } catch (e) {
    await deps.writer.remove(key).catch(() => undefined); // an object nothing points to is not left behind
    throw e;
  }
  return { status: 'ready', parts: counts, sizeBytes: body.length };
}
