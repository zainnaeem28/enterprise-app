import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Banner, Button, LoadingState, SelectField, StatusChip, TextField } from '@ehr/ui';
import { useHeadingFocus, usePageTitle } from '../profile/lib/hooks.js';
import { Problem } from '../profile/lib/Problem.js';
import type { Failure } from '../profile/lib/core.js';
import type { TelehealthApi } from './api.js';
import { browserProbe } from './probe.js';
import type { Probe } from './probe.js';
import { clockIn, zoneLabels } from './time.js';
import { configuredStates } from './states.js';
import type { StateOption } from './states.js';
import type { DeviceCheck, JoinGrant, SessionView } from './types.js';

export interface JoinPageProps {
  api: TelehealthApi;
  reservationId: string;
  /**
   * Hands the single-use credential to the video client. No vendor is chosen yet (C-11), so the app supplies this; without it the
   * page says the video client is not connected. The credential is never rendered, stored, logged or put in a URL.
   */
  onGrant?: (grant: JoinGrant) => void;
  probe?: Probe;
  /** Poll interval while waiting (the API says 5 s). */
  pollMs?: number;
  /** The viewer's IANA zone (tests). */
  viewer?: string;
  now?: () => number;
  /** The states offered (code, name). Defaults to the deployment configuration; empty means a code is typed instead. */
  states?: readonly StateOption[];
}

const VERDICT: Record<string, string> = { pass: 'Working', fail: 'Not working' };

/**
 * PP-23 device check and join, PP-21 waiting room. Order: both time zones, device check, state-of-location confirmation (TL-1),
 * then join. The server decides the window, the licensing rule and admission; this page shows what it said.
 */
export function JoinPage({
  api,
  reservationId,
  onGrant,
  probe = browserProbe,
  pollMs = 5000,
  viewer,
  now = Date.now,
  states = configuredStates(),
}: JoinPageProps) {
  const ref = useHeadingFocus<HTMLHeadingElement>();
  usePageTitle('Video visit');
  const [session, setSession] = useState<SessionView | undefined>();
  const [failure, setFailure] = useState<Failure | undefined>();
  const [attempt, setAttempt] = useState(0);
  const [check, setCheck] = useState<DeviceCheck | undefined>();
  const [checkNote, setCheckNote] = useState<string | undefined>();
  const [checking, setChecking] = useState(false);
  const [state, setState] = useState('');
  const [stateError, setStateError] = useState<string | undefined>();
  const [confirmed, setConfirmed] = useState<string | undefined>();
  const [locationProblem, setLocationProblem] = useState<'refused' | Failure | undefined>();
  const [phase, setPhase] = useState<'idle' | 'joining' | 'waiting' | 'connected'>('idle');
  const [earlyAt, setEarlyAt] = useState<string | undefined>();
  const [note, setNote] = useState<string | undefined>();
  const [joinProblem, setJoinProblem] = useState<Failure | undefined>();
  const [needsHandler, setNeedsHandler] = useState(false);
  const alive = useRef(true);
  const busy = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const r = await api.session(reservationId);
    if (!alive.current) return undefined;
    if (r.ok) {
      setSession(r.data);
      setFailure(undefined);
      return r.data;
    }
    setFailure(r);
    return undefined;
  }, [api, reservationId]);

  useEffect(() => {
    void refresh();
  }, [refresh, attempt]);

  // Re-evaluate the join window when it opens, so the banner and the button do not wait for another render.
  const [, setTick] = useState(0);
  const opensAt = session?.joinOpensAt;
  useEffect(() => {
    if (opensAt === undefined) return;
    const wait = new Date(opensAt).getTime() - now();
    if (!(wait > 0)) return;
    const t = setTimeout(() => setTick((n) => n + 1), Math.min(wait + 50, 2_147_000_000));
    return () => clearTimeout(t);
  }, [opensAt, now]);

  const join = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setJoinProblem(undefined);
    setNote(undefined);
    setPhase((p) => (p === 'waiting' ? p : 'joining'));
    const o = await api.join(reservationId);
    busy.current = false;
    if (!alive.current) return;
    switch (o.kind) {
      case 'granted':
        setEarlyAt(undefined);
        if (onGrant === undefined) {
          setNeedsHandler(true);
          setPhase('idle');
          return;
        }
        setPhase('connected');
        onGrant(o.grant);
        return;
      case 'waiting':
        setEarlyAt(undefined);
        return setPhase('waiting');
      case 'early':
        setEarlyAt(o.opensAt);
        return setPhase('idle');
      case 'location_required':
        setConfirmed(undefined);
        setPhase('idle');
        return setNote('Please confirm where you are before you join.');
      case 'refused':
        setPhase('idle');
        if (o.failure.code === 'telehealth.licensing_refused') return setLocationProblem('refused');
        if (o.failure.code === 'telehealth.session_closed')
          return setNote('This video visit has ended or is not open any more.');
        return setJoinProblem(o.failure);
    }
  }, [api, reservationId, onGrant]);

  // Waiting room: poll the status (passive) and ask for the credential again the moment the host admits.
  useEffect(() => {
    if (phase !== 'waiting') return;
    const t = setInterval(() => {
      void refresh().then((s) => {
        if (s === undefined) return;
        if (s.admission === 'removed' || s.status === 'ended' || s.status === 'failed')
          return setPhase('idle');
        if (s.admission === 'admitted') void join();
      });
    }, pollMs);
    return () => clearInterval(t);
  }, [phase, pollMs, refresh, join]);

  const runCheck = async () => {
    setChecking(true);
    setCheckNote(undefined);
    const result = await probe();
    const sent = await api.deviceCheck(reservationId, result);
    if (!alive.current) return;
    setChecking(false);
    setCheck(result);
    if (!sent.ok)
      setCheckNote(
        sent.status === 503
          ? 'The video room is not ready yet. Try the check again in a minute.'
          : 'We could not record the result. You can still try to join.',
      );
  };

  const confirmLocation = async (e: FormEvent) => {
    e.preventDefault();
    if (state === '') return setStateError('Choose the state you are in right now');
    setStateError(undefined);
    setLocationProblem(undefined);
    const r = await api.confirmLocation(reservationId, state);
    if (!alive.current) return;
    if (r.ok) {
      setNote(undefined);
      return setConfirmed(state);
    }
    if (r.code === 'telehealth.licensing_refused') return setLocationProblem('refused');
    setLocationProblem(r);
  };

  if (failure !== undefined && session === undefined)
    return <Problem failure={failure} onRetry={() => setAttempt((n) => n + 1)} />;
  if (session === undefined) return <LoadingState label="Loading" lines={4} />;

  const times = zoneLabels(session.startsAt, session.clinicTimeZone, viewer);
  const ended = session.status === 'ended' || session.status === 'failed';
  const removed = session.admission === 'removed';
  const early = new Date(session.joinOpensAt).getTime() > now();
  const locationDone =
    confirmed !== undefined || (!session.needsLocationConfirmation && note === undefined);
  const canJoin =
    !ended &&
    !removed &&
    !early &&
    locationDone &&
    phase !== 'joining' &&
    phase !== 'waiting' &&
    phase !== 'connected';

  return (
    <section className="th" aria-labelledby="th-h">
      <h1 id="th-h" ref={ref} tabIndex={-1}>
        Video visit
      </h1>
      <dl className="th-zones" aria-label="Visit time">
        <dt>Clinic time</dt>
        <dd>{times.clinic}</dd>
        {times.mine !== undefined && (
          <>
            <dt>Your time</dt>
            <dd>{times.mine}</dd>
          </>
        )}
      </dl>
      {ended && (
        <Banner tone="info" title="This video visit is over">
          {session.status === 'failed'
            ? 'The video room could not be made. The clinic will contact you.'
            : 'There is nothing more to do here.'}
        </Banner>
      )}
      {!ended && removed && (
        <Banner tone="warning" title="You were removed from the waiting room">
          Your clinician removed you from this visit. Contact the clinic if you think this is a
          mistake. If this is an emergency, call 911.
        </Banner>
      )}
      {!ended && early && (
        <Banner tone="info" title="Joining opens soon">
          You can join from {clockIn(session.joinOpensAt, viewer ?? session.clinicTimeZone)}
          {times.mine !== undefined
            ? ` (${clockIn(session.joinOpensAt, session.clinicTimeZone)} clinic time)`
            : ''}
          . You can check your devices now.
        </Banner>
      )}
      {earlyAt !== undefined && !early && (
        <Banner tone="info" title="Joining is not open yet">
          Try again at {clockIn(earlyAt, viewer ?? session.clinicTimeZone)}.
        </Banner>
      )}
      {note !== undefined && (
        <Banner tone="warning" title="One more step">
          {note}
        </Banner>
      )}
      {joinProblem !== undefined && <Problem failure={joinProblem} onRetry={() => void join()} />}

      {!ended && (
        <>
          <section className="th-step" aria-labelledby="th-dev">
            <h2 id="th-dev">1. Check your camera and microphone</h2>
            <p>Your browser will ask to use them. Nothing is recorded.</p>
            <div className="th-actions">
              <Button onClick={() => void runCheck()} disabled={checking}>
                {checking ? 'Checking…' : check === undefined ? 'Check my devices' : 'Check again'}
              </Button>
            </div>
            {check !== undefined && (
              <ul className="th-checks" aria-label="Device check result">
                {(
                  [
                    ['Camera', check.camera],
                    ['Microphone', check.mic],
                    ['Connection', check.bandwidth],
                  ] as const
                ).map(([label, v]) => (
                  <li key={label}>
                    {label}:{' '}
                    <StatusChip tone={v === 'pass' ? 'success' : 'danger'}>{VERDICT[v]}</StatusChip>
                  </li>
                ))}
              </ul>
            )}
            {check !== undefined &&
              (check.camera === 'fail' || check.mic === 'fail' || check.bandwidth === 'fail') && (
                <Banner tone="warning" title="Something is not working">
                  Allow the camera and microphone in your browser, close other apps that use them,
                  or move to a stronger connection. If the connection could not be measured, you can
                  still try to join.
                </Banner>
              )}
            {checkNote !== undefined && <p role="status">{checkNote}</p>}
          </section>

          <section className="th-step" aria-labelledby="th-loc">
            <h2 id="th-loc">2. Confirm where you are</h2>
            <p>
              Your clinician can only see you by video if you are in a state they are licensed in.
            </p>
            {confirmed !== undefined ? (
              <p role="status">
                <StatusChip tone="success">Confirmed</StatusChip> You said you are in{' '}
                {states.find(([c]) => c === confirmed)?.[1] ?? confirmed}.
              </p>
            ) : (
              <form onSubmit={(e) => void confirmLocation(e)} noValidate>
                {states.length > 0 ? (
                  <SelectField
                    id="th-state"
                    label="The state you are in right now"
                    value={state}
                    onChange={(e) => setState(e.target.value)}
                    {...(stateError !== undefined ? { error: stateError } : {})}
                  >
                    <option value="">Choose a state</option>
                    {states.map(([code, name]) => (
                      <option key={code} value={code}>
                        {name}
                      </option>
                    ))}
                  </SelectField>
                ) : (
                  <TextField
                    id="th-state"
                    label="The state you are in right now"
                    hint="Two-letter state code"
                    value={state}
                    onChange={(e) => setState(e.target.value.toUpperCase())}
                    {...(stateError !== undefined ? { error: stateError } : {})}
                  />
                )}
                <Button type="submit">Confirm my location</Button>
              </form>
            )}
            {locationProblem === 'refused' && (
              <Banner tone="danger" title="This visit cannot go ahead by video from there">
                Your clinician cannot see you by video from that state. Contact the clinic to change
                your visit. If this is an emergency, call 911.
              </Banner>
            )}
            {locationProblem !== undefined && locationProblem !== 'refused' && (
              <Problem failure={locationProblem} />
            )}
          </section>

          <section className="th-step" aria-labelledby="th-join">
            <h2 id="th-join">3. Join</h2>
            {phase === 'waiting' && (
              <Banner tone="info" title="You are in the waiting room">
                Your clinician will let you in. Keep this page open. You do not need to do anything.
              </Banner>
            )}
            {phase === 'connected' && (
              <p role="status">
                <StatusChip tone="success">Connected</StatusChip> Your video is starting.
              </p>
            )}
            {needsHandler && (
              <Banner tone="warning" title="The video app is not connected yet">
                You were let in, but this portal cannot start video yet. Ask the clinic for another
                way to join.
              </Banner>
            )}
            <div className="th-actions">
              <Button variant="primary" onClick={() => void join()} disabled={!canJoin}>
                {phase === 'joining' ? 'Joining…' : 'Join the visit'}
              </Button>
            </div>
            {!locationDone && <p>Confirm your location first.</p>}
          </section>
        </>
      )}
    </section>
  );
}
