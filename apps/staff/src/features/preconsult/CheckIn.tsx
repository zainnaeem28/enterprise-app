import { useState } from 'react';
import { Banner, Button, EmptyState, LoadingState } from '@ehr/ui';
import { useDesk } from './DeskContext.js';
import { PatientPicker } from './PatientPicker.js';
import { ActionError, LoadError } from './Problem.js';
import { QrCode } from './QrCode.js';
import { CheckInButton, PrevisitChips, StatusCell, canCheckIn } from './VisitRows.js';
import { preStrings as p } from './strings.js';
import { timeOf } from './format.js';
import { useLoad } from './useLoad.js';
import { useVisitActions } from './useCheckIn.js';
import type { Failure } from './http.js';
import type { PatientHit } from './types.js';

/** PC-02: find the patient, check the visit in; and the daily QR code patients scan to check themselves in. */
export function CheckIn() {
  const { can } = useDesk();
  return (
    <section aria-labelledby="checkin-title">
      <h2 id="checkin-title">{p.checkInTitle}</h2>
      <FindAndCheckIn />
      {can('scheduling.check_in') && <QrPanel />}
    </section>
  );
}

function FindAndCheckIn() {
  const { api, locationId } = useDesk();
  const [patient, setPatient] = useState<PatientHit | null>(null);
  const { state, reload } = useLoad(
    () => api.arrivals(locationId),
    [locationId, patient?.id],
    patient !== null,
  );
  const actions = useVisitActions(reload);
  const visits =
    state.kind === 'ready' && patient !== null
      ? state.data.filter((a) => a.patientId === patient.id)
      : [];

  return (
    <div>
      <PatientPicker
        idPrefix="ci"
        chooseLabel={p.showVisits}
        chosenId={patient?.id ?? null}
        onChoose={setPatient}
      />
      {patient !== null && (
        <section aria-label={p.visitsToday}>
          <h3>
            {p.visitsToday}: {patient.givenName} {patient.familyName}
          </h3>
          {state.kind === 'loading' && <LoadingState label={p.visitsToday} lines={2} />}
          {state.kind === 'error' && <LoadError failure={state.failure} onRetry={reload} />}
          {state.kind === 'ready' && visits.length === 0 && <EmptyState message={p.noVisitToday} />}
          {actions.notice !== null && (
            <Banner tone="info">
              <p>{actions.notice}</p>
            </Banner>
          )}
          {actions.failure !== null && <ActionError failure={actions.failure} />}
          <ul className="ehr-plain-list">
            {visits.map((a) => (
              <li key={a.reservationId} className="ehr-card">
                <strong>{timeOf(a.startsAt)}</strong> <StatusCell a={a} />{' '}
                <PrevisitChips previsit={a.previsit} />{' '}
                {canCheckIn(a) && (
                  <CheckInButton
                    a={a}
                    busy={actions.busy}
                    onClick={(x) => void actions.checkIn(x)}
                  />
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function QrPanel() {
  const { api, locationId } = useDesk();
  const [open, setOpen] = useState(false);
  const [qr, setQr] = useState<{ token: string; localDate: string } | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);

  async function show() {
    setOpen(true);
    setBusy(true);
    setFailure(null);
    const r = await api.qr(locationId);
    setBusy(false);
    if (r.ok) setQr(r.data);
    else setFailure(r);
  }

  return (
    <section aria-labelledby="qr-title" className="ehr-card">
      <h3 id="qr-title">{p.qrTitle}</h3>
      <p>{p.qrBody}</p>
      {!open ? (
        <Button onClick={() => void show()}>{p.qrShow}</Button>
      ) : (
        <>
          <Button
            onClick={() => {
              setOpen(false);
              setQr(null);
            }}
          >
            {p.qrHide}
          </Button>
          {busy && <LoadingState label={p.qrTitle} lines={2} />}
          {failure !== null && <ActionError failure={failure} />}
          {qr !== null && (
            <figure>
              <QrCode text={qr.token} label={p.qrAlt} />
              <figcaption>
                {p.qrFor(qr.localDate)}
                <br />
                {p.qrFallback} <code>{qr.token}</code>
              </figcaption>
            </figure>
          )}
        </>
      )}
    </section>
  );
}
