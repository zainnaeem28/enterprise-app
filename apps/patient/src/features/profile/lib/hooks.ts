import { useEffect, useMemo, useRef, useState } from 'react';
import type { PatientRuntime } from '../../../app/runtime.js';
import { asRecord, guard, str } from './core.js';
import type { Failure } from './core.js';

/** Browser tab title is the portal and the screen type, never a name or a detail (UX-R4). */
export function usePageTitle(screen: string): void {
  useEffect(() => {
    document.title = `Patient portal - ${screen}`;
  }, [screen]);
}

/** Moves focus to the screen's heading when the screen changes. */
export function useHeadingFocus<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return ref;
}

/** One person the session may act for (`GET /auth/session` -> `patients`). */
export interface Person {
  patientId: string;
  relation: 'self' | 'proxy';
  /** A proxy's linked patient: given name and initial when the session carries it; `undefined` otherwise. */
  displayName: string | undefined;
  /** The proxy's own grant, when the session carries it. Needed to leave; `undefined` when the server does not send it. */
  grantId: string | undefined;
}

export interface Account {
  people: Person[];
  /** The signed-in person's own record (`relation: self`), if the account has one. A proxy-only account has none. */
  selfId: string | undefined;
  /** The signed-in principal, so a screen can tell the patient's own messages from the clinic's. */
  principalId: string | undefined;
}

/** The session's people. Loads the session first so the CSRF token and idle clock are in the shell before any write. */
export function useAccount(runtime: PatientRuntime, attempt = 0) {
  const [account, setAccount] = useState<Account | undefined>();
  const [failure, setFailure] = useState<Failure | undefined>();
  useEffect(() => {
    let live = true;
    setFailure(undefined);
    void (async () => {
      await runtime.loadSession().catch(() => undefined);
      const r = await guard(
        () => runtime.api.GET('/api/v1/auth/session', { params: { header: runtime.api.header } }),
        (d) => {
          const list = asRecord(d)['patients'];
          if (!Array.isArray(list)) return undefined;
          const people = list
            .map(asRecord)
            .filter((p) => typeof p['patientId'] === 'string')
            .map((p): Person => ({
              patientId: p['patientId'] as string,
              relation: p['relation'] === 'proxy' ? 'proxy' : 'self',
              displayName: str(p['displayName']),
              grantId: str(p['grantId']),
            }));
          return { people, principalId: str(asRecord(d)['principalId']) };
        },
      );
      if (!live) return;
      if (!r.ok) return setFailure(r);
      setAccount({
        people: r.data.people,
        selfId: r.data.people.find((p) => p.relation === 'self')?.patientId,
        principalId: r.data.principalId,
      });
    })();
    return () => {
      live = false;
    };
  }, [runtime, attempt]);
  return useMemo(() => ({ account, failure }), [account, failure]);
}
