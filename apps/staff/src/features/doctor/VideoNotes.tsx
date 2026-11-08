import { useEffect, useRef, useState } from 'react';
import { Banner, Button } from '@ehr/ui';
import { useDoctor } from './DoctorContext.js';
import { ActionError } from './Problem.js';
import { NoteEditor } from './NoteEditor.js';
import type { VideoHandle } from './video.js';
import type { Failure } from '../preconsult/http.js';
import { newKey } from '../preconsult/http.js';
import { docStrings as d } from './strings.js';
import type { Note, Visit, WaitingParticipant } from './types.js';

const WAITING_POLL_MS = 5000;

/**
 * DR-04: the video pane and the note side by side (stacked on a phone). Video goes through the `VideoAdapter` interface only:
 * this file never names a vendor. The waiting room is read from the passive host status route every 5 s (UI-UX 7.4).
 */
export function VideoNotes({
  visit,
  patient,
  resume,
}: {
  visit: Visit;
  patient: { id: string; name: string; dob: string } | null;
  resume?: Note;
}) {
  const { api, video, online } = useDoctor();
  const box = useRef<HTMLDivElement>(null);
  const handle = useRef<VideoHandle | null>(null);
  const [waiting, setWaiting] = useState<WaitingParticipant[] | null>(null);
  const [state, setState] = useState<'idle' | 'joining' | 'joined' | 'ended' | 'failed'>('idle');
  const [failure, setFailure] = useState<Failure | null>(null);
  const keys = useRef({ admit: newKey(), end: newKey() });

  useEffect(() => {
    let live = true;
    const poll = async () => {
      const r = await api.waiting(visit.reservationId);
      if (live && r.ok) setWaiting(r.data);
    };
    void poll();
    const t = setInterval(() => void poll(), WAITING_POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [api, visit.reservationId]);

  useEffect(
    () => () => {
      void handle.current?.leave();
    },
    [],
  );

  async function join() {
    if (video === undefined || box.current === null) return;
    setState('joining');
    try {
      handle.current = await video.join(box.current, { reservationId: visit.reservationId });
      setState('joined');
    } catch {
      setState('failed');
    }
  }

  async function admit(id?: string) {
    setFailure(null);
    const r = await api.admit(visit.reservationId, keys.current.admit, id);
    if (r.ok) {
      keys.current.admit = newKey();
      const w = await api.waiting(visit.reservationId);
      if (w.ok) setWaiting(w.data);
    } else {
      if (r.status !== 0 && r.status < 500) keys.current.admit = newKey();
      setFailure(r);
    }
  }

  async function end() {
    setFailure(null);
    await handle.current?.leave();
    handle.current = null;
    const r = await api.endVideo(visit.reservationId, keys.current.end);
    if (r.ok) setState('ended');
    else setFailure(r);
  }

  return (
    <div className="ehr-doc-video">
      <section aria-labelledby="video-title" className="ehr-card ehr-doc-video__pane">
        <h2 id="video-title">{d.videoTitle}</h2>
        {video === undefined ? (
          <Banner tone="info">
            <p>{d.videoNotConnected}</p>
          </Banner>
        ) : (
          <>
            <div ref={box} className="ehr-doc-video__stage" aria-label={d.videoTitle} />
            {state === 'joined' && <p role="status">{d.videoJoined}</p>}
            {state === 'ended' && <p role="status">{d.videoEnded}</p>}
            {state === 'failed' && (
              <Banner tone="danger">
                <p>{d.videoFailed}</p>
              </Banner>
            )}
            <div className="ehr-actions">
              {state !== 'joined' && state !== 'ended' && (
                <Button
                  variant="primary"
                  onClick={() => void join()}
                  disabled={state === 'joining' || !online}
                >
                  {d.joinVideo}
                </Button>
              )}
              {state === 'joined' && <Button onClick={() => void end()}>{d.leaveVideo}</Button>}
            </div>
          </>
        )}
        <h3 className="ehr-state__sub">{d.videoWaiting}</h3>
        {failure !== null && <ActionError failure={failure} />}
        {waiting === null || waiting.length === 0 ? (
          <p className="ehr-muted">{d.videoNobody}</p>
        ) : (
          <ul className="ehr-plain-list">
            {waiting.map((w) => (
              <li key={w.id}>
                {w.name}{' '}
                {w.admission === 'waiting' && (
                  <Button onClick={() => void admit(w.id)}>
                    {d.admit}
                    <span className="ehr-visually-hidden"> {w.name}</span>
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <NoteEditor patient={patient} visit={visit} {...(resume === undefined ? {} : { resume })} />
    </div>
  );
}
