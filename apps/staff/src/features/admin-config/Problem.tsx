import { Banner, Button, EmptyState, LoadingState, RefreshingContent } from '@ehr/ui';
import type { ReactNode } from 'react';
import type { Failure } from '../preconsult/http.js';
import { LoadError } from '../preconsult/Problem.js';
import type { ListState } from './hooks.js';
import { configStrings as s } from './strings.js';

export { LoadError };

/** Text for a refused action, from the registry codes these routes return. Never a value from the request (CN-03). */
export function failureText(f: Failure): string {
  switch (f.code) {
    case 'organisation.neutral_name_required':
      return s.neutralServer;
    case 'clinical.vital_range_overlap':
      return s.overlap;
    case 'kernel.precondition_failed':
    case 'kernel.precondition_required':
      return s.conflict;
  }
  if (f.fields.includes('enabled') && f.code === 'kernel.validation_failed')
    return s.messagingRefused;
  if (
    f.fields.some((p) => p === 'closes' || p === 'opens') &&
    f.code === 'kernel.validation_failed'
  )
    return s.overlap;
  if (f.status === 0) return s.offline;
  if (f.status === 401) return s.sessionEnded;
  if (f.status === 403) return s.forbidden;
  if (f.status === 404) return s.notFound;
  if (f.status === 429) return `Too many tries. Try again in ${f.retryAfterSeconds ?? 5} s.`;
  if (f.status === 412 || f.status === 428) return s.conflict;
  if (f.status === 409) return s.overlap;
  if (f.status === 422 || f.status === 400) return s.checkFields;
  return s.serverError;
}

/** A write that failed: in place, announced, with the reference for support on server errors (UI-UX 6). */
export function ActionError({ failure }: { failure: Failure }) {
  const server = failure.status === 0 || failure.status >= 500;
  return (
    <Banner tone="danger">
      <p>{failureText(failure)}</p>
      {server && failure.requestId !== undefined && (
        <p>
          {s.reference}: <code>{failure.requestId}</code>
        </p>
      )}
    </Banner>
  );
}

/** The states of a list read around its content: loading, locked until the key is used, failed, refreshing. */
export function ListShell({
  state,
  items,
  reload,
  more,
  children,
}: {
  state: ListState;
  items: unknown[] | undefined;
  reload: () => void;
  more: () => void;
  children: ReactNode;
}) {
  return (
    <>
      {state.kind === 'loading' && items === undefined && (
        <LoadingState label={s.loading} lines={3} />
      )}
      {state.kind === 'locked' && (
        <EmptyState
          message={`${s.lockedTitle}. ${s.lockedBody}`}
          action={
            <Button variant="primary" onClick={reload}>
              {s.lockedAction}
            </Button>
          }
        />
      )}
      {state.kind === 'failed' && <LoadError failure={state.failure} onRetry={reload} />}
      {items !== undefined && (
        <RefreshingContent refreshing={state.kind === 'loading'}>
          {children}
          {state.kind === 'ok' && state.next !== null && (
            <Button onClick={more}>{s.loadMore}</Button>
          )}
        </RefreshingContent>
      )}
    </>
  );
}
