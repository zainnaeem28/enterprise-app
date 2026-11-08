// The shared documents module (FE-06) is not exported from the `@ehr/app-shell` entry point, and that file is outside this ticket's
// paths, so it is imported by path, as the staff app does. Replace with the package import once the entry point exports it.
export {
  createDocumentsApi,
  newTransfer,
  runTransfer,
  xhrPutObject,
  ALLOWED_CONTENT_TYPES,
} from '../../../../../packages/app-shell/src/documents/index.js';
export type {
  DocumentRecord,
  DocumentStatus,
  PutObject,
  Transfer,
} from '../../../../../packages/app-shell/src/documents/index.js';
