import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Banner,
  Button,
  CalendarWeek,
  ErrorSummary,
  LoadingState,
  RefreshingContent,
  TextField,
} from '@ehr/ui';
import type { DayColumn, FieldError } from '@ehr/ui';
import { newKey } from '../api.js';
import type { Failure } from '../api.js';
import { useBooking, useHeadingFocus, usePageTitle } from '../context.js';
import { BookingSteps } from '../components/BookingSteps.js';
import { HoldTimer } from '../components/HoldTimer.js';
import { isRefusal, Problem, Refusal } from '../components/Problem.js';
import { SlotTaken } from '../components/SlotTaken.js';
import { VisitSummary } from '../components/Summary.js';
import { clockLabel, dayKey, dayLabel } from '../time.js';
import type { Slot, VisitMode } from '../types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const slotId = (s: Slot) => `${s.startsAt}|${s.clinicianId}|${s.locationId}`;

/**
 * PP-12 (book) and PP-16 (change time): pick a time. Choosing a time creates the hold at once (UI-UX 7.2) and the
 * countdown follows the server's expiry. Slot taken and hold expired keep the service and doctor and offer
 * alternatives and the waitlist.
 */
export function TimeStep({
  rescheduleOf,
  backTo,
  nextTo,
}: {
  rescheduleOf?: { id: string; version: number };
  backTo: string;
  nextTo: string;
}) {
  const { api, go, patientId, draft, setDraft, pending, setPending, services, places } =
    useBooking();
  const service = services.find((s) => s.id === draft.serviceId);
  const place = places.find((p) => p.id === draft.locationId);
  const zone = place?.timeZone ?? 'UTC';

  const [week, setWeek] = useState(0);
  const [slots, setSlots] = useState<Slot[] | undefined>();
  const [stale, setStale] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [failure, setFailure] = useState<Failure | undefined>();
  const [refusal, setRefusal] = useState<Failure | undefined>();
  const [taken, setTaken] = useState<{ alternatives: string[]; slot: Slot } | undefined>();
  const [expired, setExpired] = useState(false);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [holding, setHolding] = useState(false);
  const holdKeys = useRef(new Map<string, string>());
  const heading = useHeadingFocus<HTMLHeadingElement>();
  usePageTitle(rescheduleOf === undefined ? 'Book: date and time' : 'Change time');

  const { serviceId, locationId, clinicianId, mode } = draft;
  const range = useCallback(() => {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const from = week === 0 ? new Date() : new Date(midnight.getTime() + week * 7 * DAY_MS);
    return { from, to: new Date(midnight.getTime() + (week + 1) * 7 * DAY_MS) };
  }, [week]);

  const load = useCallback(async () => {
    if (serviceId === undefined) return;
    setRefreshing(true);
    const { from, to } = range();
    const r = await api.search({
      serviceId,
      ...(locationId ? { locationId } : {}),
      ...(clinicianId ? { clinicianId } : {}),
      mode,
      from: from.toISOString(),
      to: to.toISOString(),
    });
    setRefreshing(false);
    if (!r.ok) return setFailure(r);
    setFailure(undefined);
    setSlots(r.data.slots);
    setStale(r.data.stale);
    setUpdatedAt(new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }));
  }, [api, serviceId, locationId, clinicianId, mode, range]);

  useEffect(() => {
    if (serviceId === undefined) return go('/book');
    void load();
  }, [serviceId, load, go]);

  const days: DayColumn[] = (() => {
    const { from } = range();
    const keys: string[] = [];
    for (let i = 0; i < 7; i++) {
      const k = dayKey(new Date(from.getTime() + i * DAY_MS).toISOString(), zone);
      if (!keys.includes(k)) keys.push(k);
    }
    for (const s of slots ?? []) {
      const k = dayKey(s.startsAt, zone);
      if (!keys.includes(k)) keys.push(k);
    }
    keys.sort();
    return keys.map((k) => {
      const inDay = (slots ?? []).filter((s) => dayKey(s.startsAt, zone) === k);
      return {
        id: k,
        heading: dayLabel(inDay[0]?.startsAt ?? `${k}T12:00:00Z`, zone),
        slots: inDay.map((s) => ({
          id: slotId(s),
          label: clockLabel(s.startsAt, zone),
          available: true,
        })),
      };
    });
  })();
  const none = slots !== undefined && slots.length === 0;
  const selectedId = pending === undefined ? undefined : slotId(pending.slot);

  async function holdSlot(slot: Slot) {
    if (holding || serviceId === undefined) return;
    const video = slot.mode === 'video';
    const state = draft.patientState.trim().toUpperCase();
    if (video && !/^[A-Z]{2}$/.test(state)) {
      return setErrors([
        {
          fieldId: 'patient-state',
          message: 'Enter the two-letter state you will be in during the video visit.',
        },
      ]);
    }
    setErrors([]);
    setHolding(true);
    setRefusal(undefined);
    setTaken(undefined);
    setExpired(false);
    // A retry of the same time (for example after a timeout) is the same request, so the same key.
    const id = slotId(slot);
    const key = holdKeys.current.get(id) ?? newKey();
    holdKeys.current.set(id, key);
    const r = await api.hold(
      {
        patientId,
        serviceId,
        locationId: slot.locationId,
        clinicianId: slot.clinicianId,
        startsAt: slot.startsAt,
        mode: slot.mode,
        ...(video ? { patientState: state } : {}),
        ...(rescheduleOf ? { rescheduleOf: rescheduleOf.id } : {}),
      },
      key,
    );
    setHolding(false);
    if (r.ok) {
      setPending({
        slot,
        hold: r.data,
        confirmKey: newKey(),
        ...(rescheduleOf ? { rescheduleOf } : {}),
      });
      return;
    }
    setPending(undefined);
    if (r.code === 'scheduling.slot_taken') {
      holdKeys.current.delete(id);
      setTaken({ alternatives: r.alternatives, slot });
      void load();
    } else if (isRefusal(r)) setRefusal(r);
    else setFailure(r);
  }

  const pickAlternative = (iso: string) => {
    if (taken === undefined) return;
    const len = Date.parse(taken.slot.endsAt) - Date.parse(taken.slot.startsAt);
    void holdSlot({
      ...taken.slot,
      startsAt: iso,
      endsAt: new Date(Date.parse(iso) + len).toISOString(),
    });
  };

  const setMode = (m: VisitMode) => {
    setPending(undefined);
    setDraft((d) => ({ ...d, mode: m }));
  };
  const fixedMode = service?.mode;

  return (
    <section aria-labelledby="time-h" className="ehr-card booking">
      {rescheduleOf === undefined && <BookingSteps current="time" />}
      <h1 id="time-h" ref={heading} tabIndex={-1}>
        {rescheduleOf === undefined ? 'Choose a date and time' : 'Choose a new time'}
      </h1>
      <p className="ehr-muted">
        Times are shown in the clinic&apos;s time zone
        {place !== undefined && ` (${place.name})`}. Only available times are shown.
      </p>
      <ErrorSummary errors={errors} />

      <fieldset className="booking-mode">
        <legend>Type of visit</legend>
        {(['in_person', 'video'] as const).map((m) => (
          <label key={m} className="booking-choice">
            <input
              type="radio"
              name="mode"
              checked={mode === m}
              disabled={fixedMode !== undefined && fixedMode !== m}
              onChange={() => setMode(m)}
            />
            <span>{m === 'video' ? 'Video visit' : 'In person'}</span>
          </label>
        ))}
      </fieldset>
      {mode === 'video' && (
        <TextField
          id="patient-state"
          label="State you will be in during the video visit"
          hint="Two letters, for example NY. We can only offer video visits in some states."
          maxLength={2}
          autoComplete="address-level1"
          value={draft.patientState}
          onChange={(e) => setDraft((d) => ({ ...d, patientState: e.target.value }))}
        />
      )}

      {expired && (
        <Banner tone="warning" title="Your hold on that time ran out">
          We kept your service and doctor. Choose a time again.
        </Banner>
      )}
      {refusal !== undefined && <Refusal failure={refusal} />}
      {stale && (
        <Banner tone="info">
          These times may be a few minutes out of date. We check again when you pick one.
        </Banner>
      )}

      {taken !== undefined && (
        <SlotTaken
          alternatives={taken.alternatives}
          timeZone={zone}
          busy={holding}
          onPick={pickAlternative}
          onWaitlist={() => go('/waitlist/join')}
        />
      )}

      {failure !== undefined ? (
        <Problem
          failure={failure}
          onRetry={() => {
            setFailure(undefined);
            void load();
          }}
        />
      ) : slots === undefined ? (
        <LoadingState label="Loading times" lines={4} onRetry={() => void load()} />
      ) : (
        <RefreshingContent refreshing={refreshing || holding}>
          <CalendarWeek
            days={days}
            selectedId={selectedId}
            onSelect={(id) => {
              const s = slots.find((x) => slotId(x) === id);
              if (s !== undefined) void holdSlot(s);
            }}
            onPrev={() => setWeek((w) => Math.max(0, w - 1))}
            onNext={() => setWeek((w) => w + 1)}
            weekLabel={week === 0 ? 'This week' : `In ${week} ${week === 1 ? 'week' : 'weeks'}`}
          />
          <p className="ehr-muted">
            {updatedAt !== undefined && <>Updated at {updatedAt}. </>}
            <Button onClick={() => void load()}>Refresh times</Button>
          </p>
        </RefreshingContent>
      )}

      {none && (
        <p>
          No times are open in this week. Try another week, or{' '}
          <Button onClick={() => go('/waitlist/join')}>join the waitlist</Button>.
        </p>
      )}

      <aside className="booking-selection" aria-label="Your selection">
        <h2>Your selection</h2>
        {pending === undefined ? (
          <p className="ehr-muted">No time chosen yet.</p>
        ) : (
          <>
            <VisitSummary
              serviceId={draft.serviceId ?? ''}
              locationId={pending.slot.locationId}
              startsAt={pending.slot.startsAt}
              mode={pending.slot.mode}
              timeZone={zone}
            />
            <HoldTimer
              expiresAt={pending.hold.expiresAt}
              clockOffsetMs={pending.hold.clockOffsetMs}
              onExpired={() => {
                setPending(undefined);
                setExpired(true);
                void load();
              }}
            />
            <p className="ehr-muted">Going back to an earlier step does not extend the hold.</p>
          </>
        )}
        <p className="booking-actions">
          <Button
            variant="primary"
            disabled={pending === undefined}
            aria-describedby="continue-why"
            onClick={() => go(nextTo)}
          >
            Continue
          </Button>{' '}
          <Button onClick={() => go(backTo)}>Back</Button>
        </p>
        {pending === undefined && (
          <p id="continue-why" className="ehr-muted">
            Choose a time to continue.
          </p>
        )}
      </aside>
    </section>
  );
}
