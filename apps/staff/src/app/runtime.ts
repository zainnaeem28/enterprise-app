import { createShellRuntime } from '@ehr/app-shell';

/** Sign-out and session end reload the page: every in-memory token (CSRF, idle clock) is dropped with it. */
export function createStaffRuntime(
  clientRelease: string,
  assign: (url: string) => void = (u) => window.location.assign(u),
) {
  return createShellRuntime({ clientRelease, afterSignOut: () => assign('/signed-out') });
}
export type StaffRuntime = ReturnType<typeof createStaffRuntime>;
