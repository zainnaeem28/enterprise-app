import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { Failure } from '../preconsult/http.js';
import { failureOf } from '../preconsult/http.js';
import { useElevation } from '../admin-auth/index.js';
import type { ElevationRequest } from '../admin-auth/index.js';
import type { Answer, ConfigApi } from './api.js';
import { parsePage, parseRow } from './types.js';
import type { Page, Row } from './types.js';

export const ConfigContext = createContext<{ api: ConfigApi } | undefined>(undefined);
export function useConfig() {
  const v = useContext(ConfigContext);
  if (v === undefined) throw new Error('admin configuration screens need a ConfigContext');
  return v;
}

export type Result<T> = { ok: true; data: T } | Failure;

/**
 * Runs one call inside the elevation ceremony and reduces its answer. Resolves `undefined` when the administrator cancelled the
 * security-key dialog: the screen keeps what was typed and nothing was sent.
 */
export function usePrivileged() {
  const { callPrivileged } = useElevation();
  return useCallback(
    async <T,>(
      request: ElevationRequest,
      call: () => Promise<Answer>,
      read: (data: unknown) => T | undefined,
    ): Promise<Result<T> | undefined> => {
      const answer = await callPrivileged(request, call);
      if (answer === undefined) return undefined;
      if (answer.offline === true)
        return { ok: false, status: 0, code: 'kernel.unavailable', fields: [] };
      if (!answer.response.ok) return failureOf(answer.response, answer.error);
      const data = read(answer.data);
      return data === undefined
        ? { ok: false, status: answer.response.status, code: 'kernel.unavailable', fields: [] }
        : { ok: true, data };
    },
    [callPrivileged],
  );
}

export type ListState =
  | { kind: 'loading'; previous?: Row[] }
  | { kind: 'locked' }
  | { kind: 'failed'; failure: Failure }
  | { kind: 'ok'; items: Row[]; next: string | null };

/** A list read (loading → ok | failed | locked), keeping old rows while a refresh runs (UI-UX 6). */
export function useRows(
  path: string | undefined,
  action: string,
  query: Record<string, string> = {},
) {
  const { api } = useConfig();
  const run = usePrivileged();
  const [state, setState] = useState<ListState>({ kind: 'loading' });
  const queryKey = JSON.stringify(query);

  const fetchPage = useCallback(
    (cursor?: string) =>
      path === undefined
        ? Promise.resolve({ ok: true, data: { items: [], nextCursor: null } } as Result<Page>)
        : run<Page>(
            { action, target: 'Organisation settings', approver: null },
            () => api.list(path, JSON.parse(queryKey) as Record<string, string>, cursor),
            parsePage,
          ),
    [api, run, path, action, queryKey],
  );
  const reload = useCallback(async () => {
    setState((s) => ({ kind: 'loading', ...(s.kind === 'ok' ? { previous: s.items } : {}) }));
    const out = await fetchPage();
    setState(
      out === undefined
        ? { kind: 'locked' }
        : out.ok
          ? { kind: 'ok', items: out.data.items, next: out.data.nextCursor }
          : { kind: 'failed', failure: out },
    );
  }, [fetchPage]);
  useEffect(() => {
    void reload();
  }, [reload]);
  const more = useCallback(async () => {
    if (state.kind !== 'ok' || state.next === null) return;
    const out = await fetchPage(state.next);
    if (out === undefined) return;
    setState(
      out.ok
        ? { kind: 'ok', items: [...state.items, ...out.data.items], next: out.data.nextCursor }
        : { kind: 'failed', failure: out },
    );
  }, [fetchPage, state]);
  const items =
    state.kind === 'ok' ? state.items : state.kind === 'loading' ? state.previous : undefined;
  return { state, items, reload, more };
}

export { parseRow };
