// The staff alert stream (ARCHITECTURE 32, 5.4; ADR-009). One `StreamHub` per API instance:
//   * `attach` registers a connection, replays missed alerts from the table (32.2 point 2) and starts its session check;
//   * one dedicated LISTEN connection OUTSIDE the query pool receives `staff_alert` and `session_revoked` (32.2 points 4, 5);
//   * a notification is turned into events by re-reading the alert under EACH local target's own scope, so what a stream
//     receives is exactly what its RLS lets it read (nothing is cached, nothing is broadcast on trust);
//   * every 60 s each stream re-reads its own session row and closes when it is revoked or expired: the bound for a lost
//     `session_revoked` notification (32.2 point 5);
//   * limits (32.3): 3 streams per session and 10 per principal (the oldest is closed), a 64 KB write buffer (a client that
//     does not read is DROPPED and replays from the database on reconnect, never buffered), a 15 s ping, `closed` on drain.
// Nothing in an event carries PHI (serialize.ts). An alert is never only in memory: a lost NOTIFY delays an alert, never loses it.
import type { KernelDb, Logger, ScopeSettings } from '@ehr/kernel';
import type { AlertService } from '../alerts/service.js';
import type { AlertView } from '../alerts/types.js';
import { isUuid, uuidv7 } from '../ids.js';
import {
  alertClosedEvent,
  alertEvent,
  CLOSED_EVENT,
  PING_EVENT,
  RESYNC_EVENT,
  RETRY_FRAME,
} from './serialize.js';

export const PING_MS = 15_000;
export const REVALIDATE_MS = 60_000;
export const MAX_STREAMS_PER_SESSION = 3;
export const MAX_STREAMS_PER_PRINCIPAL = 10;
export const WRITE_BUFFER_LIMIT = 64 * 1024;
export const REPLAY_LIMIT = 200;
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 30_000;

/** The members of the HTTP response the hub uses (a Node `ServerResponse` satisfies it). */
export interface StreamResponse {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
  flushHeaders(): void;
  write(chunk: string): boolean;
  end(): unknown;
  destroy?(): unknown;
  on(event: 'close', cb: () => void): unknown;
  readonly writableLength?: number;
  readonly writableEnded?: boolean;
}

/** What the guard knows about the caller: the session, the principal and the scope its requests run under. */
export interface StreamIdentity {
  sessionId: string;
  principalId: string;
  scope: ScopeSettings;
}

export interface ListenClient {
  connect(): Promise<unknown>;
  query(sql: string): Promise<unknown>;
  on(
    event: 'notification',
    cb: (m: { channel: string; payload?: string | undefined }) => void,
  ): unknown;
  on(event: 'error' | 'end', cb: (e?: Error) => void): unknown;
  end(): Promise<void>;
}

export interface HubDeps {
  db: KernelDb;
  alerts: AlertService;
  /** A NEW client on its own connection each call (never a pooled one, never through a transaction-mode pooler). */
  listen: () => ListenClient;
  logger?: Logger;
  pingMs?: number;
  revalidateMs?: number;
  random?: () => number;
}

type CloseReason = 'drain' | 'revoked' | 'expired' | 'evicted' | 'slow_consumer' | 'client';

interface Stream {
  id: number;
  res: StreamResponse;
  who: StreamIdentity;
  lastSeq: number;
  timer: NodeJS.Timeout | undefined;
  done: boolean;
}

interface Payload {
  alertId: string;
  seq: number;
  kind: 'alert' | 'closed';
  targets: string[] | undefined;
}

/** The notification payload is IDs only; anything else is ignored (a malformed one is a bug, never an alert). */
export function parsePayload(raw: string | undefined): Payload | undefined {
  if (raw === undefined || raw.length > 8000) return undefined;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const kind = o['kind'] ?? 'alert';
    if (
      !isUuid(o['alertId']) ||
      !Number.isSafeInteger(o['seq']) ||
      (kind !== 'alert' && kind !== 'closed')
    )
      return undefined;
    const t = o['targets'];
    if (t !== undefined && !(Array.isArray(t) && t.every(isUuid))) return undefined;
    return {
      alertId: o['alertId'] as string,
      seq: o['seq'] as number,
      kind,
      targets: t === undefined ? undefined : (t as string[]).map((x) => x.toLowerCase()),
    };
  } catch {
    return undefined;
  }
}

/** `Last-Event-ID` -> the replay cursor; a missing or malformed value means "every open alert". */
export function parseLastEventId(h: string | string[] | undefined): number {
  const v = Array.isArray(h) ? h[0] : h;
  if (v === undefined || !/^[0-9]{1,15}$/.test(v)) return 0;
  return Number(v);
}

export class StreamHub {
  private readonly streams = new Set<Stream>();
  private nextId = 1;
  private client: ListenClient | undefined;
  private listening = false;
  private stopped = true;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectDelay = RECONNECT_MIN_MS;
  private pingTimer: NodeJS.Timeout | undefined;
  /** Notifications are applied in arrival order (the `NOTIFY` commit order per instance). */
  private chain: Promise<void> = Promise.resolve();
  private readonly pingMs: number;
  private readonly revalidateMs: number;
  private readonly random: () => number;

  constructor(private readonly d: HubDeps) {
    this.pingMs = d.pingMs ?? PING_MS;
    this.revalidateMs = d.revalidateMs ?? REVALIDATE_MS;
    this.random = d.random ?? Math.random;
  }

  /** Number of open streams (health and tests). */
  count(): number {
    return this.streams.size;
  }

  isListening(): boolean {
    return this.listening;
  }

  // --- lifecycle ---------------------------------------------------------------------------------------------

  /** Starts the LISTEN connection and the ping. Safe to call once; a failing connect is retried with back-off. */
  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.pingTimer = setInterval(() => this.ping(), this.pingMs);
    this.pingTimer.unref();
    await this.connectListen();
  }

  /** Stops listening and closes every stream with a final `event: closed` (a draining instance, 32.3). */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pingTimer !== undefined) clearInterval(this.pingTimer);
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.pingTimer = this.reconnectTimer = undefined;
    this.drain();
    const c = this.client;
    this.client = undefined;
    this.listening = false;
    if (c !== undefined) await c.end().catch(() => undefined);
  }

  drain(): void {
    for (const s of [...this.streams]) this.close(s, 'drain');
  }

  private async connectListen(): Promise<void> {
    if (this.stopped) return;
    const c = this.d.listen();
    this.client = c;
    const lost = (): void => {
      if (this.client !== c) return;
      this.client = undefined;
      this.listening = false;
      c.end().catch(() => undefined);
      this.scheduleReconnect();
    };
    c.on('error', lost);
    c.on('end', lost);
    c.on('notification', (m) => this.onNotification(m.channel, m.payload));
    try {
      await c.connect();
      await c.query('LISTEN staff_alert');
      await c.query('LISTEN session_revoked');
    } catch {
      lost();
      return;
    }
    this.listening = true;
    this.reconnectDelay = RECONNECT_MIN_MS;
    // Whatever was committed while the connection was down is repaired from the table (32.2 point 6).
    this.enqueue(() => this.catchUpAll());
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== undefined) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connectListen();
    }, delay);
    this.reconnectTimer.unref();
  }

  // --- attach ------------------------------------------------------------------------------------------------

  /**
   * Opens a stream for an authenticated caller. The release check, the session and the permission were done by the middleware and
   * the guard before this runs. `lastEventId` is the `Last-Event-ID` header (the browser sets it on reconnect).
   */
  async attach(
    res: StreamResponse,
    who: StreamIdentity,
    lastEventId: string | string[] | undefined,
  ): Promise<void> {
    const stream: Stream = {
      id: this.nextId++,
      res,
      who,
      lastSeq: parseLastEventId(lastEventId),
      timer: undefined,
      done: false,
    };
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    this.write(stream, RETRY_FRAME);
    this.streams.add(stream);
    res.on('close', () => this.close(stream, 'client'));
    this.enforceLimits(stream);
    this.scheduleRevalidation(stream, this.random() * this.revalidateMs);
    // Registered before the replay, so an alert committed meanwhile reaches the stream through the live path.
    await this.replay(stream);
  }

  private enforceLimits(fresh: Stream): void {
    const mine = [...this.streams].filter((s) => s.who.principalId === fresh.who.principalId);
    const session = mine.filter((s) => s.who.sessionId === fresh.who.sessionId);
    const evict = new Set<Stream>();
    for (const s of session.slice(0, Math.max(0, session.length - MAX_STREAMS_PER_SESSION)))
      evict.add(s);
    const rest = mine.filter((s) => !evict.has(s));
    for (const s of rest.slice(0, Math.max(0, rest.length - MAX_STREAMS_PER_PRINCIPAL)))
      evict.add(s);
    for (const s of evict) this.close(s, 'evicted'); // `mine` is in insertion order: the oldest go first
  }

  private async replay(stream: Stream): Promise<void> {
    try {
      const views = await this.d.db.withScope(stream.who.scope, (tx) =>
        this.d.alerts.replay(tx, stream.lastSeq, REPLAY_LIMIT),
      );
      if (stream.done) return;
      if (views.length > REPLAY_LIMIT) {
        // 32.1: too many to replay. The client calls the passive open-ids route, then fetches details on demand.
        this.write(stream, RESYNC_EVENT);
        return;
      }
      for (const v of views) this.sendAlert(stream, v);
    } catch (err) {
      // The alerts are in the table; the client's reconnect and its 60 s open-ids poll repair this (32.2 point 6).
      this.d.logger?.warn('alert stream replay failed', { errorName: errName(err) });
    }
  }

  // --- notifications -----------------------------------------------------------------------------------------

  private onNotification(channel: string, raw: string | undefined): void {
    if (channel === 'session_revoked') {
      const principal = raw?.trim().toLowerCase();
      if (principal !== undefined && isUuid(principal))
        for (const s of [...this.streams])
          if (s.who.principalId === principal) this.close(s, 'revoked');
      return;
    }
    if (channel !== 'staff_alert') return;
    const p = parsePayload(raw);
    if (p === undefined) return;
    this.enqueue(() => this.deliver(p));
  }

  private enqueue(fn: () => Promise<void>): void {
    this.chain = this.chain.then(fn).catch((err: unknown) => {
      this.d.logger?.warn('alert stream delivery failed', { errorName: errName(err) });
    });
  }

  /** Test hook: resolves when every queued notification has been applied. */
  async idle(): Promise<void> {
    await this.chain;
  }

  private byPrincipal(only?: readonly string[]): Map<string, Stream[]> {
    const m = new Map<string, Stream[]>();
    for (const s of this.streams) {
      if (only !== undefined && !only.includes(s.who.principalId)) continue;
      const l = m.get(s.who.principalId) ?? [];
      l.push(s);
      m.set(s.who.principalId, l);
    }
    return m;
  }

  /** One read per local principal, under that principal's scope: it sees the alert only if it is a target (and in scope). */
  private async deliver(p: Payload): Promise<void> {
    for (const [, group] of this.byPrincipal(p.targets)) {
      const first = group[0] as Stream;
      let view: AlertView | undefined;
      try {
        view = await this.d.db.withScope(first.who.scope, (tx) =>
          this.d.alerts.view(tx, p.alertId),
        );
      } catch (err) {
        this.d.logger?.warn('alert stream read failed', { errorName: errName(err) });
        continue;
      }
      if (view === undefined) continue;
      if (p.kind === 'closed' || (view.status !== 'open' && view.status !== 'escalated')) {
        for (const s of group) this.write(s, alertClosedEvent(view.alertId, view.seq));
        continue;
      }
      for (const s of group) this.sendAlert(s, view);
      void this.markDelivered(first.who.scope, view);
    }
  }

  private sendAlert(s: Stream, v: AlertView): void {
    if (this.write(s, alertEvent(v)) && v.seq > s.lastSeq) s.lastSeq = v.seq;
  }

  /** Records one `delivered` event per principal and alert (the trail of 5.4). Best effort: it never blocks or fails a delivery. */
  private async markDelivered(scope: ScopeSettings, v: AlertView): Promise<void> {
    try {
      await this.d.db.withScope(scope, (tx) =>
        tx.query(
          `INSERT INTO notifications.staff_alert_event (id, organisation_id, alert_id, patient_id, kind, principal_id, created_by)
           SELECT $1, $2, $3, $4, 'delivered', $5, $5
            WHERE NOT EXISTS (SELECT 1 FROM notifications.staff_alert_event e
                               WHERE e.alert_id = $3 AND e.kind = 'delivered' AND e.principal_id = $5)`,
          [uuidv7(), scope.orgId, v.alertId, v.patientId, scope.principalId],
        ),
      );
    } catch (err) {
      this.d.logger?.warn('alert delivered event failed', { errorName: errName(err) });
    }
  }

  /** After a LISTEN outage: replay for every stream from its own last event (the same query as a reconnect). */
  private async catchUpAll(): Promise<void> {
    for (const s of [...this.streams]) if (!s.done) await this.replay(s);
  }

  // --- session revalidation (32.2 point 5) -------------------------------------------------------------------

  private scheduleRevalidation(s: Stream, delayMs: number): void {
    s.timer = setTimeout(() => {
      void this.revalidate(s).finally(() => {
        if (!s.done) this.scheduleRevalidation(s, this.revalidateMs);
      });
    }, delayMs);
    s.timer.unref();
  }

  /**
   * One short read per stream under the stream's own settings: the session row by `id` through T-PRINCIPAL (no batched read
   * across principals, so no `anonymous` policy). The stream is passive: it never extends the session.
   */
  private async revalidate(s: Stream): Promise<void> {
    if (s.done) return;
    try {
      const r = await this.d.db.withScope(s.who.scope, (tx) =>
        tx.query(
          `SELECT revoked_at IS NOT NULL AS revoked, idle_expires_at <= now() AS idle_expired,
                  absolute_expires_at <= now() AS absolute_expired
             FROM identity.session WHERE id = $1`,
          [s.who.sessionId],
        ),
      );
      const row = r.rows[0] as Record<string, unknown> | undefined;
      if (row === undefined || row['revoked'] === true) this.close(s, 'revoked');
      else if (row['idle_expired'] === true || row['absolute_expired'] === true)
        this.close(s, 'expired');
    } catch (err) {
      // The database being unreachable is not a revocation; the next round decides.
      this.d.logger?.warn('alert stream session check failed', { errorName: errName(err) });
    }
  }

  /** Test hook: run the session check of every stream now. */
  async revalidateAll(): Promise<void> {
    for (const s of [...this.streams]) await this.revalidate(s);
  }

  // --- writing and closing -----------------------------------------------------------------------------------

  private ping(): void {
    for (const s of [...this.streams]) this.write(s, PING_EVENT);
  }

  /** Writes one frame. A client whose buffer is full is dropped, not buffered (32.3). Returns whether it was written. */
  private write(s: Stream, frame: string): boolean {
    if (s.done || s.res.writableEnded === true) return false;
    if ((s.res.writableLength ?? 0) + frame.length > WRITE_BUFFER_LIMIT) {
      this.close(s, 'slow_consumer');
      return false;
    }
    try {
      s.res.write(frame);
      return true;
    } catch {
      this.close(s, 'client');
      return false;
    }
  }

  private close(s: Stream, reason: CloseReason): void {
    if (s.done) return;
    s.done = true;
    this.streams.delete(s);
    if (s.timer !== undefined) clearTimeout(s.timer);
    try {
      if (reason === 'slow_consumer') {
        // Nothing more is written to a client that is not reading: the connection is destroyed and it replays on reconnect.
        if (s.res.destroy !== undefined) s.res.destroy();
        else s.res.end();
      } else if (reason !== 'client' && s.res.writableEnded !== true) {
        s.res.write(CLOSED_EVENT);
        s.res.end();
      }
    } catch {
      // the socket is already gone
    }
  }
}

const errName = (e: unknown): string => (e instanceof Error ? e.name : typeof e);
