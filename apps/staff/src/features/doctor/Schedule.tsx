import { useMemo, useState } from 'react';
import {
  Banner,
  EmptyState,
  LoadingState,
  PermissionNote,
  ScheduleDay,
  SelectField,
} from '@ehr/ui';
import type { ScheduleEvent } from '@ehr/ui';
import { useDoctor } from './DoctorContext.js';
import { LoadError } from './Problem.js';
import { useLoad } from '../preconsult/useLoad.js';
import { docStrings as d } from './strings.js';
import { timeOf } from './format.js';
import { workspace } from './workspace.js';

/** DR-01: the doctor's own visits at a location today, from `GET /clinicians/{id}/schedule` (own reservations only). */
export function Schedule({ locationIds }: { locationIds: readonly string[] }) {
  const { api, can, principalId, navigate } = useDoctor();
  const [chosen, setChosen] = useState<string | null>(null);
  const locationId = chosen !== null && locationIds.includes(chosen) ? chosen : locationIds[0];
  const readable = can('scheduling.booking.own_schedule') && locationId !== undefined;
  const { state, reload } = useLoad(
    () => api.schedule(principalId, locationId as string),
    [locationId],
    readable,
  );

  const mine = useMemo(
    () =>
      state.kind === 'ready'
        ? [...state.data].sort((a, b) => a.startsAt.localeCompare(b.startsAt))
        : [],
    [state],
  );

  const events: ScheduleEvent[] = mine.map((v) => ({
    id: v.reservationId,
    start: timeOf(v.startsAt),
    end: timeOf(v.endsAt),
    title: `${v.patientName ?? d.patientFallback}${v.mrn === null ? '' : ` (${v.mrn})`}`,
    status: ` · ${v.mode === 'video' ? d.videoVisit : d.inPerson} · ${d.statusLabel(v.status)}`,
  }));

  return (
    <section aria-labelledby="schedule-title">
      <h1 id="schedule-title">{d.scheduleTitle}</h1>
      {locationIds.length > 1 && (
        <div className="ehr-doc-location">
          <SelectField
            label={d.location}
            value={locationId}
            onChange={(e) => setChosen(e.target.value)}
          >
            {locationIds.map((id, i) => (
              <option key={id} value={id}>
                {d.locationN(i + 1)}
              </option>
            ))}
          </SelectField>
        </div>
      )}
      {!readable ? (
        <PermissionNote scope={d.scheduleNoRead} />
      ) : state.kind === 'loading' ? (
        <LoadingState label={d.scheduleTitle} lines={4} />
      ) : state.kind === 'error' ? (
        <LoadError failure={state.failure} onRetry={reload} />
      ) : (
        <>
          <p className="ehr-muted">
            {d.updatedAt(state.updatedAt.toLocaleTimeString([], { timeStyle: 'short' }))}{' '}
            <button type="button" className="ehr-link-btn" onClick={reload}>
              {d.refresh}
            </button>
          </p>
          {state.failure !== undefined && (
            <Banner tone="warning">
              <p>{d.chartLoadFailed}</p>
            </Banner>
          )}
          {mine.length === 0 ? (
            <EmptyState message={d.scheduleEmpty} />
          ) : (
            <ScheduleDay
              heading={d.visitsHeading}
              events={events}
              onOpen={(id) => {
                const v = mine.find((x) => x.reservationId === id);
                if (v === undefined) return;
                workspace.set({
                  patientId: v.patientId,
                  label: v.patientName ?? d.patientFallback,
                  visit: v,
                });
                navigate('/patients');
              }}
            />
          )}
        </>
      )}
    </section>
  );
}
