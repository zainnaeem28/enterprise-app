import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { ErrorState } from '@ehr/ui';

/** Full-page 404 for unknown routes: same words for "missing" and "not yours" (CN-04). */
export function NotFoundPage({ homeHref = '/' }: { homeHref?: string }) {
  return <ErrorState kind="not-found" homeHref={homeHref} headingLevel={1} />;
}

export function ForbiddenPage({
  homeHref = '/',
  helpHref,
}: {
  homeHref?: string;
  helpHref?: string;
}) {
  return (
    <ErrorState
      kind="forbidden"
      homeHref={homeHref}
      {...(helpHref === undefined ? {} : { helpHref })}
      headingLevel={1}
    />
  );
}

export function ServerErrorPage({
  requestId,
  onRetry,
}: {
  requestId?: string;
  onRetry?: () => void;
}) {
  return (
    <ErrorState
      kind="server"
      headingLevel={1}
      {...(requestId === undefined ? {} : { requestId })}
      {...(onRetry === undefined ? {} : { onRetry })}
    />
  );
}

/** Catches render errors so a crash shows "Your work is safe" with Retry, never a blank page or a stack. */
export class ErrorBoundary extends Component<
  { children: ReactNode; onError?: (error: Error, info: ErrorInfo) => void },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.onError?.(error, info);
  }
  override render() {
    return this.state.failed ? (
      <ServerErrorPage onRetry={() => this.setState({ failed: false })} />
    ) : (
      this.props.children
    );
  }
}
