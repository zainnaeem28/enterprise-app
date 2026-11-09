import { useMemo } from 'react';
import {
  DocumentsPanel,
  createDocumentsApi,
} from '../../../../../packages/app-shell/src/documents/index.js';
import type { DocumentPermissions } from '../../../../../packages/app-shell/src/documents/index.js';
import type { ShellRuntime } from '@ehr/app-shell';

/**
 * Staff documents for one patient (J-19, SH-01, SH-02). Permissions come from the session (`documents.read`,
 * `documents.upload`, `documents.classify`) and only decide what is drawn; the server authorizes every call.
 */
export function DocumentsPage({
  runtime,
  patientId,
  permissions,
}: {
  runtime: Pick<ShellRuntime, 'api'>;
  patientId: string;
  permissions: readonly string[];
}) {
  const api = useMemo(() => createDocumentsApi(runtime.api), [runtime.api]);
  const can: DocumentPermissions = {
    read: permissions.includes('documents.read'),
    upload: permissions.includes('documents.upload'),
    classify: permissions.includes('documents.classify'),
  };
  return <DocumentsPanel api={api} patientId={patientId} permissions={can} />;
}
