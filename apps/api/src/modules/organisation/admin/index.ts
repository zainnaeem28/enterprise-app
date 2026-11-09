// Public surface of the organisation admin routes (BE-23). The composition root builds the service from the kernel database,
// the audit service and the organisation service, then adds `createOrganisationAdminController` to the application's controllers.
export { createOrganisationAdminController } from './controller.js';
export type { AdminControllerDeps } from './controller.js';
export { OrganisationAdminService, translate } from './service.js';
export type { AdminDeps, Meta, One, Page } from './service.js';
export { FLAG_RULES } from './flag-rules.js';
export type { FlagRule } from './flag-rules.js';
