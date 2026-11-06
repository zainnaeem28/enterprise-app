// Task handlers of the notifications module (ARCHITECTURE 33.1). `createNotificationsTasks` returns a task table for the
// worker's `startWorker({ tasks })`; `defineNotificationsJobs` registers the types with the JobRegistry. The inbound receipt
// handler is registered with integration-core (`registerReceiptHandlers`), not as a task of its own.
import type { Task } from 'graphile-worker';
import type { JobRegistry } from '@ehr/kernel';
import { NOTIFICATIONS_JOBS } from './jobs.js';
import { runSendMessage, type SendDeps } from './send-message.js';

export { NOTIFICATIONS_EVENTS, NOTIFICATIONS_JOBS } from './jobs.js';
export { runSendMessage } from './send-message.js';
export type { Attempt, SendDeps, SendOutcome } from './send-message.js';
export { EmailAdapter, ProviderError, PushAdapter, SmsAdapter } from './adapters.js';
export type { ProviderClient, ProviderRequest } from './adapters.js';
export {
  createReceiptHandler,
  parseReceipt,
  recordReceipt,
  registerReceiptHandlers,
} from './receipt.js';
export type { Receipt, ReceiptDeps, ReceiptResult } from './receipt.js';
export { applyCommunicationPreferences, quietHoursEnd } from './recipient.js';
export type {
  CommunicationPreference,
  ContactPoints,
  DeliveryChannel,
  QuietHours,
  RecipientContributor,
  RecipientContributors,
  ResolvedRecipient,
} from './recipient.js';
export { renderTemplate, RenderError } from './render.js';
export { findForbidden } from './forbidden.js';

export function defineNotificationsJobs(registry: JobRegistry): void {
  for (const j of NOTIFICATIONS_JOBS) registry.defineJob(j);
}

export function createNotificationsTasks(deps: SendDeps): Record<string, Task> {
  const run: Task = async (payload, helpers) => {
    await runSendMessage(deps, payload as Record<string, unknown>, {
      number: helpers.job.attempts,
      max: helpers.job.max_attempts,
    });
  };
  return {
    'notifications.send_message': run,
    'notifications.send_staff_message': run,
  };
}
