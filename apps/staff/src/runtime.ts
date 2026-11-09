import { ReleaseStore, createApiClient } from '@ehr/app-shell';

/** One release store and one typed API client per page; a refused call opens the blocking dialog. */
export function createRuntime(clientRelease: string) {
  const releases = new ReleaseStore({ clientRelease });
  const api = createApiClient({
    clientRelease,
    onReleaseRefused: ({ requestId }) => releases.refuse(requestId),
  });
  return { clientRelease, releases, api };
}
export type Runtime = ReturnType<typeof createRuntime>;
