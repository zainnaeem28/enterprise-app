import { useMemo, useState } from 'react';
import { ErrorState, LoadingState } from '@ehr/ui';
import type { PatientRuntime } from '../../app/runtime.js';
import { useAccount } from '../profile/lib/hooks.js';
import { Problem } from '../profile/lib/Problem.js';
import { createPrivacyApi } from './api.js';
import { PrivacyPage } from './PrivacyPage.js';
import '../profile/profile.css';

export const PRIVACY_PATH = '/privacy';
export const isPrivacyPath = (path: string): boolean => path.replace(/\/+$/, '') === PRIVACY_PATH;

/** PP-24 My privacy. Mounted by the app for `isPrivacyPath`. */
export function PrivacyRoutes({
  runtime,
  path,
  open,
}: {
  runtime: PatientRuntime;
  path: string;
  /** Opens the short-lived download URL; defaults to a whole-page navigation. */
  open?: (url: string) => void;
}) {
  const api = useMemo(() => createPrivacyApi(runtime), [runtime]);
  const [attempt, setAttempt] = useState(0);
  const { account, failure } = useAccount(runtime, attempt);
  if (!isPrivacyPath(path))
    return <ErrorState kind="not-found" homeHref="/appointments" headingLevel={1} />;
  if (failure !== undefined)
    return <Problem failure={failure} onRetry={() => setAttempt((n) => n + 1)} />;
  if (account === undefined) return <LoadingState label="Loading" lines={3} />;
  return <PrivacyPage api={api} isOwn={account.selfId !== undefined} {...(open ? { open } : {})} />;
}
