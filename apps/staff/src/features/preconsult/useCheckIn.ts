import { useRef, useState } from 'react';
import { useDesk } from './DeskContext.js';
import type { Failure } from './http.js';
import { newKey } from './http.js';
import { preStrings as p } from './strings.js';
import { nameOf } from './format.js';
import type { Arrival } from './types.js';

export interface DeskAction {
  busy: string | null;
  notice: string | null;
  failure: Failure | null;
}

/**
 * Check-in and no-show writes for the arrivals and check-in screens. One idempotency key per visit and step: a retry after a
 * timeout or a server error reuses it (UI-UX 6, idempotent retry), a definite answer (success, 412, 422) drops it.
 */
export function useVisitActions(onChanged: () => void) {
  const { api } = useDesk();
  const keys = useRef(new Map<string, string>());
  const [state, setState] = useState<DeskAction>({ busy: null, notice: null, failure: null });

  const keyFor = (slot: string): string => {
    let k = keys.current.get(slot);
    if (k === undefined) {
      k = newKey();
      keys.current.set(slot, k);
    }
    return k;
  };

  async function checkIn(a: Arrival) {
    if (state.busy !== null) return;
    const slot = `in:${a.reservationId}:${a.version}`;
    setState({ busy: a.reservationId, notice: null, failure: null });
    const r = await api.checkIn(a.reservationId, a.version, keyFor(slot));
    if (r.ok) {
      keys.current.delete(slot);
      setState({
        busy: null,
        notice: r.data.alreadyCheckedIn
          ? p.alreadyCheckedIn(nameOf(a.patientName))
          : p.checkedInNow(nameOf(a.patientName)),
        failure: null,
      });
      onChanged();
      return;
    }
    if (r.status > 0 && r.status < 500 && r.status !== 429) keys.current.delete(slot);
    setState({ busy: null, notice: null, failure: r });
    if (r.status === 412 || r.status === 428) onChanged();
  }

  async function noShow(a: Arrival) {
    if (state.busy !== null) return;
    const slot = `ns:${a.reservationId}:${a.version}`;
    setState({ busy: a.reservationId, notice: null, failure: null });
    const r = await api.noShow(a.reservationId, a.version, keyFor(slot));
    if (r.ok) {
      keys.current.delete(slot);
      setState({ busy: null, notice: p.noShowDone, failure: null });
      onChanged();
      return;
    }
    if (r.status > 0 && r.status < 500 && r.status !== 429) keys.current.delete(slot);
    setState({ busy: null, notice: null, failure: r });
    if (r.status === 412 || r.status === 428) onChanged();
  }

  return { ...state, checkIn, noShow };
}
