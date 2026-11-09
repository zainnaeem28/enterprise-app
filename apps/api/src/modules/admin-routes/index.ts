// Public surface of the admin routes (BE-24): audit viewer, export and BTG review; integration settings. The composition root builds
// the services from the kernel database and the audit and integration-core services, then adds `createAdminRoutesControllers(...)`
// to the application's controllers. Users, roles and role-change approval are identity's (BE-05), privacy decisions and incidents
// are privacy's (BE-20) and organisation configuration is BE-23's; they are mounted by the composition root next to these.
export { createAdminRoutesControllers } from './controller.js';
export type { AdminRoutesDeps } from './controller.js';
export { AuditAdminService, DOWNLOAD_TTL_SECONDS } from './audit-routes.js';
export type { AuditAdminDeps, ExportUrlSigner } from './audit-routes.js';
export { IntegrationAdminService } from './integration-routes.js';
export type { ConnectionTester, Health, IntegrationAdminDeps } from './integration-routes.js';
