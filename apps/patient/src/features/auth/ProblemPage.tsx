import { useEffect, useRef } from 'react';
import { Button } from '@ehr/ui';
import { problemCopy } from './problems.js';
import type { Problem } from './problems.js';

/**
 * One accessible state per documented problem. The heading takes focus so a screen reader announces it, and
 * the reference for support is the request id only (no IdP text, no tokens).
 */
export function ProblemPage({
  problem,
  onRetry,
  onSignIn,
}: {
  problem: Problem;
  onRetry?: () => void;
  onSignIn: () => void;
}) {
  const copy = problemCopy[problem.code];
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), [problem.code]);
  const retry = copy.action === 'retry' && onRetry !== undefined;
  return (
    <section className="ehr-card" aria-labelledby="problem-h" data-problem={problem.code}>
      <h1 id="problem-h" tabIndex={-1} ref={heading}>
        {copy.title}
      </h1>
      <p role="alert">{copy.body}</p>
      {problem.requestId !== undefined && (
        <p>
          Reference for support: <code>{problem.requestId}</code>
        </p>
      )}
      <Button variant="primary" onClick={retry ? onRetry : onSignIn}>
        {retry ? 'Try again' : 'Sign in again'}
      </Button>
    </section>
  );
}
