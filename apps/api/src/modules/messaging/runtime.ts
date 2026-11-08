// Wiring of the messaging module: one call builds the services and the controllers from explicit dependencies. Nothing here reads the
// environment; the application entry point supplies the pieces.
import type { KernelDb, Queue } from '@ehr/kernel';
import type { Type } from '@nestjs/common';
import type { AuditService } from '../audit/index.js';
import type { Identity } from '../identity/index.js';
import { createMessagingControllers, messagingResolvers } from './controller.js';
import { TaskService } from './tasks.js';
import { ThreadService } from './threads.js';

export interface MessagingDeps {
  db: KernelDb;
  audit: Pick<AuditService, 'record'>;
  identity: Pick<Identity, 'policy'>;
  /** API-path queue: the `messaging.task_created` event. */
  queue: Queue;
}

export interface Messaging {
  threads: ThreadService;
  tasks: TaskService;
  controllers: Type<unknown>[];
}

export function createMessaging(deps: MessagingDeps): Messaging {
  const threads = new ThreadService({ audit: deps.audit });
  const tasks = new TaskService({ audit: deps.audit, queue: deps.queue });
  for (const [name, fn] of Object.entries(messagingResolvers()))
    deps.identity.policy.registerResolver(name, fn);
  const controllers = createMessagingControllers({ db: deps.db, threads, tasks });
  return { threads, tasks, controllers };
}
