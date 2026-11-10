// Shared imports for the QA-03 suites (TC-ID, TC-AZ, TC-SEC, TC-SEC-C7). They run on the QA-05 platform stack (ENV-INT/ci:
// throwaway PostgreSQL 17 with the real migrations and roles, the real built API and worker, fixture IdPs, per-run TLS front).
// Nothing here weakens a control. Fixtures the product has no endpoint for are written as database administrator, never as a way to
// pass a product path.
import { randomUUID } from 'node:crypto';
export * from '../../platform/lib/world.mjs';
export { Client, rawRequest, state as stateOf } from '../../platform/lib/http.mjs';
export * as clinical from '../../platform/lib/clinical.mjs';
export {
  adminClient,
  signInAdmin,
  elevate,
  attest,
  assertWith,
} from '../../platform/lib/admin.mjs';
export {
  GRANTOR,
  ensureGrantors,
  newEnrolmentToken,
  personId as staffPersonId,
} from '../../platform/lib/seed.mjs';
export const rid = randomUUID;
