// Public surface of the scheduling availability module (ARCHITECTURE 24, ticket BE-12). Other modules import only from here.
// Composition, at start-up:
//   1. const search = new AvailabilitySearch({ organisation });  const availability = new AvailabilityService({ audit });
//   2. booking core: new SchedulingCoreService({ audit, organisation, availability: search, queue }) (`search` is the AvailabilityPort);
//   3. controllers via createAvailabilityControllers({ db, audit, availability, search }); resolvers via availabilityResolvers().
export { AvailabilitySearch, MAX_SEARCH_DAYS, MAX_SLOTS } from './search.js';
export type { SearchDeps } from './search.js';
export { AvailabilityService } from './service.js';
export type { AvailabilityServiceDeps } from './service.js';
export { availabilityResolvers, createAvailabilityControllers } from './controller.js';
export type { AvailabilityControllerDeps } from './controller.js';
export {
  AvailabilityNotFoundError,
  ConflictsWithAppointmentsError,
  RosterPrincipalIneligibleError,
} from './errors.js';
export type {
  BlockedKind,
  BlockedTimeInput,
  BlockedTimeView,
  ConflictCounts,
  RosterDuty,
  RosterInput,
  RosterView,
  RuleInput,
  RuleMode,
  RuleView,
  SearchInput,
  SearchResult,
  Slot,
  TemplateInput,
  TemplateView,
  Weekday,
} from './types.js';
