// Queue is the outbox (ADR-020, 21.8). Jobs and domain-event deliveries are inserted through the caller's
// transaction handle, so they commit or roll back with the business change. The queue library is Graphile Worker:
// its SQL function `<schema>.add_job` runs on the caller's connection (21.8 (a)). Payloads carry IDs and scope keys
// only (BD-09): anything else is refused here, before it reaches the database.

import type { Tx } from '../scope/with-scope.js';

export type OnMerged = 'resolve' | 'none';

export interface JobType {
  /** `<module>.<verb_noun>` */
  name: string;
  maxAttempts: number;
  /** Declared for every job type that carries patient IDs (TICKETS 3). */
  onMerged: OnMerged;
  carriesPatientIds: boolean;
  jobScope: 'patients' | 'org';
  /** Class in `queue_api.task_type` (21.8). Default `job`. Only `handler` and `job` may be enqueued by the API tier. */
  jobClass?: JobClass;
  /** May `queue_api.enqueue` accept this type? Default: true for `handler` and `job`, never for the others. */
  apiEnqueue?: boolean;
}

export type JobClass = 'handler' | 'job' | 'system' | 'data_repair';

const JOB_NAME = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const EVENT_NAME = JOB_NAME;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPE_KEY = /^[a-z][a-z0-9_]{0,40}$/;

export class QueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueueError';
  }
}

export class JobRegistry {
  private readonly types = new Map<string, JobType>();
  private readonly handlers = new Map<string, Set<string>>();

  defineJob(t: JobType): void {
    if (!JOB_NAME.test(t.name)) throw new QueueError(`bad job name ${t.name}`);
    if (this.types.has(t.name)) throw new QueueError(`job type ${t.name} already defined`);
    if (!Number.isInteger(t.maxAttempts) || t.maxAttempts < 1 || t.maxAttempts > 25) {
      throw new QueueError(`${t.name}: maxAttempts must be 1..25`);
    }
    if (t.carriesPatientIds && t.onMerged !== 'resolve') {
      throw new QueueError(
        `${t.name}: a job that carries patient IDs must declare on_merged = resolve (22.16)`,
      );
    }
    const jobClass = t.jobClass ?? 'job';
    const apiEnqueue = t.apiEnqueue ?? (jobClass === 'handler' || jobClass === 'job');
    if (apiEnqueue && jobClass !== 'handler' && jobClass !== 'job') {
      throw new QueueError(`${t.name}: class ${jobClass} can never be enqueued by the API tier`);
    }
    this.types.set(t.name, { ...t, jobClass, apiEnqueue });
  }

  /** Every defined type, in a stable order: the source of `queue_api.task_type` (sync-task-types). */
  list(): { name: string; maxAttempts: number; jobClass: JobClass; apiEnqueue: boolean }[] {
    return [...this.types.values()]
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .map((t) => ({
        name: t.name,
        maxAttempts: t.maxAttempts,
        jobClass: t.jobClass as JobClass,
        apiEnqueue: t.apiEnqueue as boolean,
      }));
  }

  get(name: string): JobType {
    const t = this.types.get(name);
    if (t === undefined) throw new QueueError(`unknown job type ${name}`);
    return t;
  }

  /** `kernel.publish` fan-out: one job `<handler module>.on_<event>` per handler registered in code. */
  registerHandler(event: string, handlerModule: string): void {
    if (!EVENT_NAME.test(event)) throw new QueueError(`bad event name ${event}`);
    if (!/^[a-z][a-z0-9_]*$/.test(handlerModule)) throw new QueueError('bad handler module');
    const set = this.handlers.get(event) ?? new Set<string>();
    set.add(handlerModule);
    this.handlers.set(event, set);
  }

  handlersOf(event: string): string[] {
    return [...(this.handlers.get(event) ?? [])].sort();
  }
}

/** IDs and scope keys only. Strings must be UUIDs or snake_case keys; no nested free text. */
export function assertPayloadIsIdsOnly(payload: unknown, path = '$', depth = 0): void {
  if (depth > 3) throw new QueueError(`payload too deep at ${path}`);
  if (payload === null || typeof payload === 'number' || typeof payload === 'boolean') return;
  if (typeof payload === 'string') {
    if (UUID.test(payload) || SCOPE_KEY.test(payload)) return;
    throw new QueueError(`payload value at ${path} is not an ID or scope key (BD-09)`);
  }
  if (Array.isArray(payload)) {
    payload.forEach((v, i) => assertPayloadIsIdsOnly(v, `${path}[${i}]`, depth + 1));
    return;
  }
  if (typeof payload === 'object') {
    for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
      if (!SCOPE_KEY.test(k) && !/^[a-z][A-Za-z0-9]{0,40}$/.test(k))
        throw new QueueError(`bad payload key at ${path}`);
      assertPayloadIsIdsOnly(v, `${path}.${k}`, depth + 1);
    }
    return;
  }
  throw new QueueError(`unsupported payload value at ${path}`);
}

export interface EnqueueOptions {
  runAt?: Date;
  /** Dedupe key, replaces an unstarted job with the same key. */
  jobKey?: string;
  priority?: number;
}

/** `api` enqueues through `queue_api.enqueue` (the API tier has no right in schema `queue`); `worker` calls `queue.add_job`. */
export type QueuePath = 'api' | 'worker';

const JOB_KEY = /^[A-Za-z0-9_:.-]{1,100}$/;

export class Queue {
  constructor(
    private readonly registry: JobRegistry,
    private readonly path: QueuePath = 'api',
    private readonly schema = 'queue',
  ) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new QueueError('bad queue schema');
  }

  /** Insert one job in the caller's transaction. The returned promise settles when the INSERT has run. */
  async enqueue(
    tx: Tx,
    jobName: string,
    payload: Record<string, unknown>,
    opts: EnqueueOptions = {},
  ): Promise<void> {
    const type = this.registry.get(jobName);
    assertPayloadIsIdsOnly(payload);
    if (opts.jobKey !== undefined && !JOB_KEY.test(opts.jobKey))
      throw new QueueError('bad job key');
    const priority = opts.priority ?? 0;
    if (this.path === 'api') {
      if (!type.apiEnqueue) throw new QueueError(`${jobName} cannot be enqueued by the API tier`);
      await tx.query(
        'SELECT queue_api.enqueue($1::text, $2::jsonb, $3::timestamptz, $4::text, $5::smallint)',
        [jobName, JSON.stringify(payload), opts.runAt ?? null, opts.jobKey ?? null, priority],
      );
      return;
    }
    // Same `<task_identifier>:<key>` namespace as the wrapper, so one task type cannot replace another's job.
    await tx.query(
      `SELECT ${this.schema}.add_job($1::text, $2::json, run_at => $3::timestamptz, max_attempts => $4::int, job_key => $5::text, priority => $6::int, job_key_mode => 'replace')`,
      [
        jobName,
        JSON.stringify(payload),
        opts.runAt ?? null,
        type.maxAttempts,
        opts.jobKey === undefined ? null : `${jobName}:${opts.jobKey}`,
        priority,
      ],
    );
  }

  /** `kernel.publish(event, payload)`: fan out at insert, in the same transaction. Returns the job names created. */
  async publish(
    tx: Tx,
    event: string,
    payload: Record<string, unknown>,
    opts: EnqueueOptions = {},
  ): Promise<string[]> {
    const names = this.registry.handlersOf(event).map((m) => `${m}.on_${event.split('.')[1]}`);
    for (const n of names) await this.enqueue(tx, n, payload, opts);
    return names;
  }
}
