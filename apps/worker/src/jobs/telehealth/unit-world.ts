// Shared fake world of the telehealth job unit tests (not a test file): the in-memory video vendor stub behind the real adapter, and a
// recording fake of the worker port, queue and scope.
import { createLogger, type KernelDb, type Queue, type Tx } from '@ehr/kernel';
import { FakeVideoTransport } from './fake-transport.js';
import type { TelehealthJobDeps, TelehealthWorkerPort, VisitOverReason } from './ports.js';
import { VideoAdapter } from './video-adapter.js';

const RID = '0192abcd-1234-7abc-8def-0123456789a1';
const PID = '0192abcd-1234-7abc-8def-0123456789a2';
const SID = '0192abcd-1234-7abc-8def-0123456789a3';
const SURVIVOR = '0192abcd-1234-7abc-8def-0123456789a4';
const NEW_RID = '0192abcd-1234-7abc-8def-0123456789a5';

export interface WorldOpts {
  /** the patient whose scope holds the session (default: the payload patient) */
  owner?: string;
  session?: 'ended' | 'live';
  /** the reservation is in this patient's scope (visit-over handlers) */
  reservationOwner?: string;
  endResult?: 'ended' | 'failed' | 'already' | 'none';
  newReservation?: 'created' | 'skipped' | 'gone';
  auditFindsRow?: boolean;
}

export function world(opts: WorldOpts = {}) {
  const transport = new FakeVideoTransport();
  const adapter = new VideoAdapter(transport);
  transport.meetings.set(SID, { meetingId: 'mtg-1', ended: false, recording: false });
  const owner = opts.owner ?? PID;
  const state = {
    scopes: [] as string[][],
    audits: [] as { scope: string; sid: string; jobId: string | null | undefined }[],
    visitOver: [] as { scope: string; rid: string; reason: VisitOverReason }[],
    jobs: new Map<string, { name: string; payload: unknown; runAt?: Date }>(),
    ensured: [] as string[],
  };
  let current = '';
  const telehealth: TelehealthWorkerPort = {
    ensureSession: (_tx, _m, rid) => {
      state.ensured.push(rid);
      const k = opts.newReservation ?? 'created';
      return Promise.resolve(
        k === 'created'
          ? {
              outcome: 'created' as const,
              sessionId: SID,
              startsAt: '2026-12-01T10:00:00Z',
              hasMeeting: false,
            }
          : { outcome: k },
      );
    },
    recordMeeting: () => Promise.resolve(true),
    staleSessions: () => Promise.resolve([]),
    endStale: () => Promise.resolve({ status: 'already', vendor: null, meetingId: null }),
    meetingToClose: (_tx, sid) =>
      Promise.resolve(
        sid === SID && current === owner && opts.session !== 'live'
          ? { vendor: 'sandboxvendor', meetingId: 'mtg-1' }
          : null,
      ),
    recordMeetingClosed: (_tx, meta, sid) => {
      if (opts.auditFindsRow === false) return Promise.resolve(false);
      state.audits.push({ scope: current, sid, jobId: meta.jobId });
      return Promise.resolve(true);
    },
    endForVisitOver: (_tx, _m, rid, reason) => {
      state.visitOver.push({ scope: current, rid, reason });
      if (current !== (opts.reservationOwner ?? PID)) return Promise.resolve({ status: 'gone' });
      const r = opts.endResult ?? 'ended';
      return Promise.resolve(
        r === 'ended' || r === 'failed'
          ? {
              status: r,
              sessionId: SID,
              vendor: r === 'ended' ? 'sandboxvendor' : null,
              meetingId: r === 'ended' ? 'mtg-1' : null,
            }
          : { status: r },
      );
    },
  };
  const queue = {
    enqueue: (
      _tx: Tx,
      name: string,
      payload: unknown,
      o: { runAt?: Date; jobKey?: string } = {},
    ) => {
      state.jobs.set(`${name}:${o.jobKey}`, {
        name,
        payload,
        ...(o.runAt ? { runAt: o.runAt } : {}),
      });
      return Promise.resolve();
    },
  } as unknown as Queue;
  const db = {
    withScope: (s: { jobPatientIds?: string[] }, fn: (tx: Tx) => unknown) => {
      current = (s.jobPatientIds ?? [])[0] as string;
      state.scopes.push(s.jobPatientIds ?? []);
      return fn({} as Tx);
    },
  } as unknown as KernelDb;
  const deps: TelehealthJobDeps = {
    db,
    orgId: '0192abcd-1234-7abc-8def-0123456789a0',
    queue,
    telehealth,
    log: createLogger({ sink: () => undefined }),
    now: () => new Date('2026-12-01T09:00:00Z'),
    survivorOf: (p) => Promise.resolve(p === PID && owner !== PID ? SURVIVOR : undefined),
    vendor: {
      callVendor: (_k, operation, args, corr) =>
        adapter.call({
          operation: operation as never,
          args: args ?? {},
          connection: { id: 'c', kind: 'video', vendor: 'sandboxvendor', settings: {} },
          credentials: { get: () => Promise.resolve('x') },
          idempotencyToken: corr?.idempotencyToken ?? 't',
          signal: new AbortController().signal,
        } as never),
    },
  };
  return { transport, state, deps };
}

export const ids = { RID, PID, SID, SURVIVOR, NEW_RID };
