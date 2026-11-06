// Public surface of the notifications module (ARCHITECTURE 24). Other modules import only from here.
export { NotificationService } from './send.js';
export type { NotificationDeps, SendRequest, SendResult } from './send.js';
export {
  TemplateService,
  evaluateVersion,
  structuralFailures,
  TEMPLATE_CHANNELS,
} from './templates.js';
export type { NewTemplate, RequestContext, TemplateDeps, TemplateView } from './templates.js';
export {
  VARIABLE_ALLOWLIST,
  VARIABLE_TYPES,
  SAMPLE_VALUES,
  isAllowedVariable,
  normaliseValue,
} from './allowlist.js';
export type { DeclaredVariable, ValueOptions, VariableType } from './allowlist.js';
export { findForbidden, FORBIDDEN_RULE_NAMES } from './forbidden.js';
export { renderTemplate, RenderError, CHANNEL_LIMITS } from './render.js';
export type { Channel, RenderInput, Rendered } from './render.js';
export {
  DELIVERY_CHANNELS,
  applyCommunicationPreferences,
  parseRecipientRef,
  quietHoursEnd,
} from './recipient.js';
export type {
  ChannelTarget,
  CommunicationPreference,
  ContactPoints,
  DeliveryChannel,
  QuietHours,
  RecipientContributor,
  RecipientContributors,
  RecipientRef,
  ResolvedRecipient,
  WithheldReason,
} from './recipient.js';
export {
  NOTIFICATIONS_MERGE_TABLES,
  notificationsExportContributor,
  notificationsMergeParticipant,
  registerNotificationsParticipants,
} from './merge.js';
export { NOTIFICATIONS_EVENTS, NOTIFICATIONS_JOBS } from './jobs.js';
export {
  NotificationsError,
  NotificationsNotFoundError,
  NotificationsScopeError,
  NotificationsValidationError,
  RenderCheckFailedError,
} from './errors.js';
export type { RenderFailure } from './errors.js';
