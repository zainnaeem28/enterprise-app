// Public surface of the calendar-sync API module (ARCHITECTURE 24, ticket BE-14). Other modules import only from here.
// The sync itself (Google adapter, push/delete of Busy events, incremental and full sync, watch channels, the push handler) is the
// worker's, in apps/worker/src/jobs/calendar-sync. Composition, at start-up:
//   1. define CALENDAR_SYNC_JOBS in the API's and the worker's JobRegistry (and sync queue task types); `registerCalendarSyncHandlers`
//      on the registry used by `Queue.publish`;
//   2. API: new CalendarLinkService({ db, audit, queue, store, oauth, stateKeys }), new GoogleCalendarPush({ db, queue, sealer, keys,
//      orgId }); controllers via createCalendarControllers; resolvers via calendarResolvers();
//   3. worker: createCalendarSyncTasks + CALENDAR_SYNC_CRONTAB, and `registerGooglePushHandler` on the inbound handler registry.
export { CalendarLinkService } from './service.js';
export type { CalendarLinkDeps, CallbackOutcome, LinkStatus, LinkView } from './service.js';
export { GoogleCalendarPush, GOOGLE_CALENDAR_SOURCE, GOOGLE_PUSH_MESSAGE_TYPE } from './push.js';
export type { GooglePushDeps } from './push.js';
export { calendarResolvers, createCalendarControllers } from './controller.js';
export type { CalendarControllerDeps } from './controller.js';
export {
  CALENDAR_SCOPES,
  GOOGLE_AUTH_URL,
  GOOGLE_TOKEN_URL,
  GoogleCalendarOAuth,
  OAuthExchangeError,
} from './oauth.js';
export type { GoogleOAuthOptions, OAuthPort } from './oauth.js';
export { makeState, pkceChallenge, pkceVerifier, verifyState, STATE_LIFETIME_SECONDS } from './state.js';
export {
  CALENDAR_SYNC_CRONTAB,
  CALENDAR_SYNC_EVENTS,
  CALENDAR_SYNC_JOBS,
  registerCalendarSyncHandlers,
} from './jobs.js';
export {
  CalendarLinkNotFoundError,
  CalendarScopeError,
  CalendarSyncError,
  CalendarUnavailableError,
  CalendarValidationError,
} from './errors.js';
export { tokenSecretName } from './ids.js';
