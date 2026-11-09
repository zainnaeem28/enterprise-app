import { useEffect, useRef, useState } from 'react';
import { AlertDialog, Banner, Button } from '@ehr/ui';
import type { Failure } from './api.js';
import type { Elevation, ElevationRequest } from './elevation.js';
import { adminAuthStrings as s } from './strings.js';
import './admin-auth.css';

const failureText = (f: Failure): string => {
  switch (f.reason) {
    case 'cancelled':
      return s.elevateCancelled;
    case 'unsupported':
      return s.elevateUnsupported;
    case 'unavailable':
      return s.elevateUnavailable;
    case 'rate_limited':
      return s.elevateRateLimited(f.retryAfterSeconds);
    case 'rejected':
      return s.elevateFailed;
  }
};

/**
 * "Confirm with your security key" (UI-UX 3.1, 7.1). Names the action, its target and who must approve, then runs the WebAuthn
 * elevation ceremony. It closes only on success (`onElevated`) or when the administrator cancels; a failure keeps it open with a
 * plain sentence and the same single button. A failure never says which part failed (ARCH 26.1).
 */
export function ElevationDialog({
  request,
  elevation,
  onElevated,
  onCancel,
}: {
  request: ElevationRequest;
  elevation: Elevation;
  onElevated: () => void;
  onCancel: () => void;
}) {
  const [waiting, setWaiting] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const abort = useRef<AbortController | undefined>(undefined);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      abort.current?.abort();
    };
  }, []);

  async function confirm() {
    if (waiting) return;
    setProblem(undefined);
    setWaiting(true);
    const ctl = new AbortController();
    abort.current = ctl;
    const result = await elevation.elevate(ctl.signal);
    if (!live.current) return;
    setWaiting(false);
    if (result.ok) onElevated();
    else setProblem(failureText(result));
  }

  return (
    <AlertDialog
      title={s.elevateTitle}
      initialFocus=".ehr-btn--primary"
      actions={
        <>
          <Button variant="primary" aria-disabled={waiting} onClick={() => void confirm()}>
            {s.confirm}
          </Button>
          <Button onClick={onCancel}>{s.cancel}</Button>
        </>
      }
    >
      <dl className="ehr-elevation__facts">
        <div>
          <dt>{s.actionLabel}</dt>
          <dd>{request.action}</dd>
        </div>
        <div>
          <dt>{s.targetLabel}</dt>
          <dd>{request.target}</dd>
        </div>
        <div>
          <dt>{s.approverLabel}</dt>
          <dd>{request.approver ?? s.noApprover}</dd>
        </div>
      </dl>
      <p role="status" className="ehr-hint">
        {waiting ? s.elevateWaiting : ''}
      </p>
      {problem !== undefined && (
        <Banner tone="danger">
          <p>{problem}</p>
        </Banner>
      )}
    </AlertDialog>
  );
}
