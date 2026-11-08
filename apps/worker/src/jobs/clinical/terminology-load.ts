// `clinical.terminology_load` (ARCHITECTURE 22.11, 33.1; ticket BE-16): loads one terminology release (RxNorm, SNOMED CT, ICD-10-CM,
// LOINC) into `clinical.terminology_concept`, as audience `system`, organisation scope. Triggered by an admin or a release, payload
// `{ dataset, version }` (the code system and the release label).
//
// CHUNKED: the source hands out at most CHUNK_SIZE concepts at a time; each chunk is upserted in its OWN transaction (so each stays
// well inside the 60 s bound however large the release is), and a checkpoint row (`kernel.reference_data_version`, dataset
// `clinical.terminology_load.<dataset>`) records the source cursor and the running count in the same transaction. A retry after a
// crash resumes from the last committed chunk; running the whole job twice leaves the same rows (the upsert is idempotent). When the
// source reports the end, the concepts of this system that belong to an OLDER release are marked inactive (in batches, never
// deleted: a saved chart entry keeps its code and display), the completion row `clinical.terminology.<dataset>` is written, and one
// `config_change` audit event records the load.
//
// The real content needs the NLM/UMLS licence account (C-09), which does not exist yet. This job is therefore written against the
// {@link TerminologySource} port; the real adapter (a download from the licensed account) is delivered with the licence. Nothing
// here proves it, and nothing in this repository contains licensed content (the tests load a small synthetic set).
import { createHash, randomUUID } from 'node:crypto';
import type { KernelDb, Logger } from '@ehr/kernel';
import { systemScope } from './scope.js';

export const CHUNK_SIZE = 2000;
export const DEACTIVATE_BATCH = 5000;
export const SYSTEMS = ['rxnorm', 'snomed', 'icd10cm', 'loinc'] as const;
type System = (typeof SYSTEMS)[number];

const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const RELEASE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
/** A cursor is stored with the release in a 100-character column; the source keeps it short. */
const MAX_CURSOR = 40;

export interface SourceConcept {
  code: string;
  display: string;
  active?: boolean;
}
export interface SourceChunk {
  concepts: SourceConcept[];
  /** null at the end of the release. */
  next: string | null;
}
export interface TerminologySource {
  /** At most `limit` concepts of the release, starting after `cursor` (null = the start). Throws when the release is unavailable. */
  read(system: System, release: string, cursor: string | null, limit: number): Promise<SourceChunk>;
}

export class TerminologyLoadError extends Error {
  constructor(
    readonly kind: 'bad_payload' | 'bad_chunk' | 'source_unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'TerminologyLoadError';
  }
}

export interface TerminologyLoadDeps {
  db: KernelDb;
  orgId: string;
  source: TerminologySource;
  log?: Logger;
  jobId?: string;
  chunkSize?: number;
}

export interface TerminologyLoadResult {
  dataset: string;
  version: string;
  loaded: number;
  chunks: number;
  deactivated: number;
  resumed: boolean;
}

const checkpointDataset = (d: string): string => `clinical.terminology_load.${d}`;
const completionDataset = (d: string): string => `clinical.terminology.${d}`;

function parsePayload(payload: unknown): { dataset: System; version: string } {
  const p = (payload ?? {}) as Record<string, unknown>;
  const dataset = p['dataset'];
  const version = p['version'];
  if (typeof dataset !== 'string' || !(SYSTEMS as readonly string[]).includes(dataset))
    throw new TerminologyLoadError('bad_payload', 'dataset is not a known code system');
  if (typeof version !== 'string' || !RELEASE.test(version))
    throw new TerminologyLoadError('bad_payload', 'version is not a release label');
  return { dataset: dataset as System, version };
}

function cleanChunk(chunk: SourceChunk, limit: number): SourceConcept[] {
  if (chunk === null || typeof chunk !== 'object' || !Array.isArray(chunk.concepts))
    throw new TerminologyLoadError('bad_chunk', 'the source returned no concept list');
  if (chunk.concepts.length > limit)
    throw new TerminologyLoadError('bad_chunk', 'the source returned more than the chunk size');
  if (
    chunk.next !== null &&
    (typeof chunk.next !== 'string' || chunk.next.length === 0 || chunk.next.length > MAX_CURSOR)
  )
    throw new TerminologyLoadError('bad_chunk', 'the source cursor is not usable');
  const byCode = new Map<string, SourceConcept>();
  for (const c of chunk.concepts) {
    const display = typeof c?.display === 'string' ? c.display.trim() : '';
    if (
      typeof c?.code !== 'string' ||
      !CODE.test(c.code) ||
      display.length < 1 ||
      display.length > 500
    )
      throw new TerminologyLoadError('bad_chunk', 'a concept has a bad code or display');
    byCode.set(c.code, { code: c.code, display, active: c.active !== false }); // the last of a repeated code wins
  }
  return [...byCode.values()];
}

export async function runTerminologyLoad(
  deps: TerminologyLoadDeps,
  payload: unknown,
): Promise<TerminologyLoadResult> {
  const { dataset, version } = parsePayload(payload);
  const size = Math.min(deps.chunkSize ?? CHUNK_SIZE, CHUNK_SIZE);
  const scope = systemScope(deps.orgId);

  // Resume point: the last committed chunk of THIS release.
  const cp = (
    await deps.db.withScope(scope, (tx) =>
      tx.query(
        `SELECT version FROM kernel.reference_data_version WHERE organisation_id = $1::uuid AND dataset = $2`,
        [deps.orgId, checkpointDataset(dataset)],
      ),
    )
  ).rows[0] as { version?: unknown } | undefined;
  let cursor: string | null = null;
  let loaded = 0;
  let resumed = false;
  if (cp !== undefined && typeof cp.version === 'string') {
    const m = /^([^|]+)\|(\d+)\|(.*)$/.exec(cp.version);
    // An empty cursor is the checkpoint of a finished load: a new run of the same release starts again (idempotent upserts).
    if (m !== null && m[1] === version && m[3] !== '') {
      loaded = Number(m[2]);
      cursor = m[3] as string;
      resumed = true;
    }
  }

  let chunks = 0;
  for (;;) {
    let chunk: SourceChunk;
    try {
      chunk = await deps.source.read(dataset, version, cursor, size);
    } catch (e) {
      if (e instanceof TerminologyLoadError) throw e;
      throw new TerminologyLoadError(
        'source_unavailable',
        'the terminology source could not be read',
      );
    }
    const concepts = cleanChunk(chunk, size);
    const next = chunk.next;
    loaded += concepts.length;
    chunks += 1;
    await deps.db.withScope(scope, async (tx) => {
      if (concepts.length > 0)
        await tx.query(
          `INSERT INTO clinical.terminology_concept (system, code, organisation_id, display, active, release)
           SELECT $1, u.code, $2::uuid, u.display, u.active, $3
             FROM unnest($4::text[], $5::text[], $6::boolean[]) AS u(code, display, active)
           ON CONFLICT (system, code) DO UPDATE
              SET display = EXCLUDED.display, active = EXCLUDED.active, release = EXCLUDED.release, loaded_at = now()`,
          [
            dataset,
            deps.orgId,
            version,
            concepts.map((c) => c.code),
            concepts.map((c) => c.display),
            concepts.map((c) => c.active === true),
          ],
        );
      // The checkpoint commits with the chunk it describes (or neither does).
      await tx.query(
        `INSERT INTO kernel.reference_data_version (organisation_id, dataset, version, applied_at, checksum, created_by_job)
         VALUES ($1::uuid, $2, $3, now(), $4, NULL)
         ON CONFLICT (organisation_id, dataset) DO UPDATE SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at, checksum = EXCLUDED.checksum`,
        [
          deps.orgId,
          checkpointDataset(dataset),
          next === null ? `${version}|${loaded}|` : `${version}|${loaded}|${next}`,
          createHash('sha256')
            .update(`${dataset}|${version}|${loaded}|${next ?? ''}`)
            .digest(),
        ],
      );
    });
    if (next === null) break;
    cursor = next;
  }

  // The release is complete: concepts of older releases stop being offered (never deleted), then the completion row and the audit.
  let deactivated = 0;
  for (;;) {
    const n = await deps.db.withScope(scope, async (tx) => {
      const r = await tx.query(
        `WITH old AS (
           SELECT code FROM clinical.terminology_concept WHERE system = $1 AND release <> $2 AND active ORDER BY code LIMIT ${DEACTIVATE_BATCH} FOR UPDATE)
         UPDATE clinical.terminology_concept t SET active = false, loaded_at = now() FROM old WHERE t.system = $1 AND t.code = old.code`,
        [dataset, version],
      );
      return r.rowCount ?? 0;
    });
    deactivated += n;
    if (n < DEACTIVATE_BATCH) break;
  }
  await deps.db.withScope(scope, async (tx) => {
    const before = (
      await tx.query(
        `SELECT version FROM kernel.reference_data_version WHERE organisation_id = $1::uuid AND dataset = $2`,
        [deps.orgId, completionDataset(dataset)],
      )
    ).rows[0] as { version?: unknown } | undefined;
    await tx.query(
      `INSERT INTO kernel.reference_data_version (organisation_id, dataset, version, applied_at, checksum, created_by_job)
       VALUES ($1::uuid, $2, $3, now(), $4, NULL)
       ON CONFLICT (organisation_id, dataset) DO UPDATE SET version = EXCLUDED.version, applied_at = EXCLUDED.applied_at, checksum = EXCLUDED.checksum`,
      [
        deps.orgId,
        completionDataset(dataset),
        version,
        createHash('sha256').update(`${dataset}|${version}|${loaded}`).digest(),
      ],
    );
    await tx.query(
      `INSERT INTO audit.event (event_id, organisation_id, job_id, realm, audience, action, resource_type, change, outcome)
       VALUES ($1::uuid, $2::uuid, $3, 'worker', 'system', 'config_change', 'clinical.terminology_concept', $4::jsonb, 'allowed')`,
      [
        randomUUID(),
        deps.orgId,
        deps.jobId ?? 'clinical.terminology_load',
        JSON.stringify({
          dataset,
          versionBefore: typeof before?.version === 'string' ? before.version : null,
          versionAfter: version,
          concepts: loaded,
          deactivated,
        }),
      ],
    );
  });
  deps.log?.info('terminology release loaded', {
    dataset,
    version,
    concepts: loaded,
    chunks,
    deactivated,
  });
  return { dataset: completionDataset(dataset), version, loaded, chunks, deactivated, resumed };
}
