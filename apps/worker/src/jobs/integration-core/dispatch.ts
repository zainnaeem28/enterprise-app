// Inbound dispatch (ARCHITECTURE 25.7, SHARED-BOUNDARIES 3.2 rule 6). Owning modules register a handler for each
// (source, message type); the worker job `integration_core.dispatch_inbound` reads the stored message and runs it. A type
// with no handler ends in status `no_handler` (the dead-letter view). A failing handler leaves the message `failed` and
// the job fails, so the queue retries with back-off (8 attempts, 33.1). Handlers must be idempotent by event ID (33.2) and
// treat the payload as untrusted input (SEC-01 DF-3).
import type { KernelDb, Logger, Queue, Tx } from '@ehr/kernel';
import type { PayloadOpener } from './secrets.js';
import { systemScope, isUuid } from './scope.js';

export interface InboundMessage {
  id: string;
  source: string;
  eventId: string;
  messageType: string;
  receivedAt: Date;
  /** The decrypted vendor body. Do not log it. */
  body: Buffer;
}

export interface HandlerContext {
  db: KernelDb;
  orgId: string;
  queue: Queue;
  log: Logger;
}

export type InboundHandlerFn = (msg: InboundMessage, ctx: HandlerContext) => Promise<void>;

export class InboundHandlerRegistry {
  private readonly handlers = new Map<string, { name: string; fn: InboundHandlerFn }>();

  /** `registerInboundHandler(source, type, handler)` (ARCHITECTURE 24). One handler per pair; a second one is refused. */
  register(source: string, messageType: string, name: string, fn: InboundHandlerFn): void {
    if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(source)) throw new Error('bad source');
    if (!/^[a-z][a-z0-9_.]{0,99}$/.test(messageType)) throw new Error('bad message type');
    if (!/^[a-z][a-z0-9_.]{0,99}$/.test(name)) throw new Error('bad handler name');
    const key = `${source}\u0000${messageType}`;
    if (this.handlers.has(key))
      throw new Error(`inbound handler for ${source}/${messageType} already registered`);
    this.handlers.set(key, { name, fn });
  }

  resolve(source: string, messageType: string): { name: string; fn: InboundHandlerFn } | undefined {
    return this.handlers.get(`${source}\u0000${messageType}`);
  }
}

export const inboundContext = (source: string, eventId: string): string =>
  `inbound:${source}\n${eventId}`;

/** `readInbound(messageId)` (ARCHITECTURE 24): the stored message, decrypted. Undefined when it does not exist or is not visible. */
export async function readInbound(
  tx: Tx,
  opener: PayloadOpener,
  messageId: string,
): Promise<InboundMessage | undefined> {
  if (!isUuid(messageId)) return undefined;
  const r = await tx.query(
    `SELECT id, source, event_id, message_type, received_at, payload FROM integration_core.inbound_message WHERE id = $1::uuid`,
    [messageId],
  );
  const row = r.rows[0];
  if (row === undefined) return undefined;
  const source = String(row.source);
  const eventId = String(row.event_id);
  return {
    id: String(row.id),
    source,
    eventId,
    messageType: String(row.message_type),
    receivedAt: row.received_at as Date,
    body: await opener.open(row.payload as Buffer, inboundContext(source, eventId)),
  };
}

export interface DispatchDeps {
  db: KernelDb;
  orgId: string;
  queue: Queue;
  log: Logger;
  registry: InboundHandlerRegistry;
  opener: PayloadOpener;
}

export type DispatchResult = 'handled' | 'no_handler' | 'skipped';

export async function runDispatch(deps: DispatchDeps, messageId: string): Promise<DispatchResult> {
  if (!isUuid(messageId)) throw new Error('integration_core.dispatch_inbound: bad payload');
  const scope = systemScope(deps.orgId);
  // Claim: read the routing columns only (the payload stays encrypted until a handler exists), and count the attempt.
  const head = await deps.db.withScope(scope, async (tx) => {
    const r = await tx.query(
      `SELECT source, message_type, status FROM integration_core.inbound_message WHERE id = $1::uuid FOR UPDATE`,
      [messageId],
    );
    const row = r.rows[0];
    if (row === undefined) return undefined;
    const status = String(row.status);
    if (status === 'handled' || status === 'no_handler') return { skip: true as const };
    const handler = deps.registry.resolve(String(row.source), String(row.message_type));
    await tx.query(
      `UPDATE integration_core.inbound_message
          SET status = $2, handler = $3, attempts = attempts + 1, error_class = NULL
        WHERE id = $1::uuid`,
      [messageId, handler === undefined ? 'no_handler' : 'dispatched', handler?.name ?? null],
    );
    return { skip: false as const, handler };
  });
  if (head === undefined) throw new Error('integration_core.dispatch_inbound: message not found');
  if (head.skip) return 'skipped';
  if (head.handler === undefined) return 'no_handler';

  const handler = head.handler;
  try {
    const msg = await deps.db.withScope(scope, (tx) => readInbound(tx, deps.opener, messageId));
    if (msg === undefined) throw new Error('message vanished');
    await handler.fn(msg, { db: deps.db, orgId: deps.orgId, queue: deps.queue, log: deps.log });
  } catch (err) {
    const cls =
      err instanceof Error && /^[A-Za-z]{1,40}$/.test(err.name)
        ? err.name.toLowerCase()
        : 'handler_error';
    await deps.db.withScope(scope, (tx) =>
      tx
        .query(
          `UPDATE integration_core.inbound_message SET status = 'failed', error_class = $2 WHERE id = $1::uuid`,
          [messageId, cls.slice(0, 63)],
        )
        .then(() => undefined),
    );
    throw err; // the queue retries; the handler is idempotent by event ID
  }
  await deps.db.withScope(scope, (tx) =>
    tx
      .query(
        `UPDATE integration_core.inbound_message SET status = 'handled', handled_at = now(), error_class = NULL WHERE id = $1::uuid`,
        [messageId],
      )
      .then(() => undefined),
  );
  return 'handled';
}
