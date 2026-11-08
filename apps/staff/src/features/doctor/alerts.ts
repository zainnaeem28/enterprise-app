import { useCallback, useEffect, useRef, useState } from 'react';
import { alertStreamUrl } from '@ehr/app-shell';
import type { DoctorApi } from './api.js';
import type { Failure } from '../preconsult/http.js';
import { newKey } from '../preconsult/http.js';
import type { AckResult, AlertItem, Banner } from './types.js';

/** `connected`; `disconnected` = the browser is retrying (offers "Check for alerts"); `paused` = the stream was refused and will not retry. */
export type StreamState = 'connecting' | 'connected' | 'disconnected' | 'paused';

/** The seam for tests: a minimal `EventSource`. */
export interface StreamLike {
  readonly readyState: number;
  onopen: ((e: Event) => void) | null;
  onerror: ((e: Event) => void) | null;
  addEventListener(type: string, cb: (e: MessageEvent) => void): void;
  close(): void;
}
export type StreamFactory = (url: string) => StreamLike;
export const defaultStream: StreamFactory = (url) => new EventSource(url) as unknown as StreamLike;

export const POLL_MS = 60_000;

export interface AckState {
  alertId: string;
  result: AckResult;
}

/**
 * The alert list, the SSE stream and the passive 60 s `open-ids` poll (UI-UX 7.4, ARCHITECTURE 26.2). Server time comes from the
 * `Date` header of the list response and is moved on by the local time elapsed since, so the countdown never trusts the device
 * clock alone. A refused stream shows the paused bar; a dropped one offers "Check for alerts"; missed alerts come back with the
 * next list read (replay, SBR-10).
 */
export function useAlerts(
  api: DoctorApi,
  clientRelease: string,
  enabled: boolean,
  stream: StreamFactory = defaultStream,
) {
  const [items, setItems] = useState<AlertItem[] | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [streamState, setStreamState] = useState<StreamState>('connecting');
  const [acks, setAcks] = useState<Record<string, AckResult>>({});
  const [gone, setGone] = useState<string[]>([]);
  const [ackFailure, setAckFailure] = useState<Failure | null>(null);
  const clock = useRef<{ server: number; local: number } | null>(null);
  const ackKeys = useRef<Record<string, string>>({});

  const serverNow = useCallback((): number | null => {
    const c = clock.current;
    return c === null ? null : c.server + (Date.now() - c.local);
  }, []);

  const load = useCallback(async () => {
    const r = await api.alerts();
    if (r.ok) {
      setItems(r.data.items);
      setFailure(null);
      if (r.data.serverNow !== null)
        clock.current = { server: r.data.serverNow, local: Date.now() };
    } else setFailure(r);
  }, [api]);

  useEffect(() => {
    if (!enabled) return;
    void load();
  }, [enabled, load]);

  // Passive poll: corrects `escalatesAt`, level and status; a new or vanished open alert triggers a full read.
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => {
      void api.openAlertIds().then((r) => {
        if (!r.ok) return;
        setItems((cur) => {
          if (cur === null) return cur;
          const open = new Map(r.data.map((o) => [o.alertId, o]));
          const shownOpen = cur.filter((a) => a.status === 'open' || a.status === 'escalated');
          if (
            r.data.some((o) => !cur.some((a) => a.alertId === o.alertId)) ||
            shownOpen.some((a) => !open.has(a.alertId))
          ) {
            void load();
            return cur;
          }
          return cur.map((a) => {
            const o = open.get(a.alertId);
            return o === undefined
              ? a
              : {
                  ...a,
                  status: o.status,
                  escalationLevel: o.escalationLevel,
                  escalatesAt: o.escalatesAt,
                };
          });
        });
      });
    }, POLL_MS);
    return () => clearInterval(t);
  }, [enabled, api, load]);

  useEffect(() => {
    if (!enabled) return;
    let es: StreamLike;
    try {
      es = stream(alertStreamUrl(clientRelease));
    } catch {
      setStreamState('paused');
      return;
    }
    es.onopen = () => setStreamState('connected');
    es.onerror = () => setStreamState(es.readyState === 2 ? 'paused' : 'disconnected');
    const refresh = () => void load();
    es.addEventListener('alert', refresh);
    es.addEventListener('alert_closed', refresh);
    es.addEventListener('resync', refresh);
    es.addEventListener('closed', () => setStreamState('disconnected'));
    return () => es.close();
  }, [enabled, clientRelease, stream, load]);

  const acknowledge = useCallback(
    async (alertId: string) => {
      ackKeys.current[alertId] ??= newKey();
      setAckFailure(null);
      const r = await api.acknowledge(alertId, ackKeys.current[alertId] as string);
      if (r.ok) {
        delete ackKeys.current[alertId];
        setAcks((a) => ({ ...a, [alertId]: r.data }));
        return;
      }
      if (r.status !== 0 && r.status < 500) delete ackKeys.current[alertId];
      if (r.code === 'notifications.alert_closed') setGone((g) => [...g, alertId]);
      setAckFailure(r);
    },
    [api],
  );

  return {
    items,
    failure,
    streamState,
    acks,
    gone,
    ackFailure,
    serverNow,
    reload: load,
    acknowledge,
  };
}

/** Patient name and date of birth for alert rows (inside the signed-in app only, UI-UX 7.4): one banner read per patient. */
export function useBannerNames(api: DoctorApi, patientIds: readonly string[]) {
  const [names, setNames] = useState<Record<string, Banner | null>>({});
  const asked = useRef(new Set<string>());
  const key = patientIds.join(',');
  useEffect(() => {
    for (const id of patientIds) {
      if (asked.current.has(id)) continue;
      asked.current.add(id);
      void api.banner(id).then((r) => setNames((n) => ({ ...n, [id]: r.ok ? r.data : null })));
    }
  }, [api, key]);
  return names;
}
