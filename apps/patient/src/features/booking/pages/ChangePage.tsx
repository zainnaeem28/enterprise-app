import { useEffect } from 'react';
import { LoadingState } from '@ehr/ui';
import { useBooking } from '../context.js';
import { Problem } from '../components/Problem.js';
import { TimeStep } from './TimeStep.js';
import { useAppointment } from './DetailPage.js';

/** PP-16: change time. Starts from the appointment's own service, place, doctor and type. */
export function ChangePage({ id }: { id: string }) {
  const { setDraft, setPending, draft, go } = useBooking();
  const { appointment: a, failure, reload } = useAppointment(id);

  useEffect(() => {
    if (a === undefined) return;
    setPending(undefined);
    setDraft((d) => ({
      ...d,
      serviceId: a.serviceId,
      locationId: a.locationId,
      clinicianId: a.clinicianId,
      mode: a.mode,
    }));
  }, [a, setDraft, setPending]);

  const notOpen = a !== undefined && a.status !== 'confirmed';
  useEffect(() => {
    if (notOpen) go(`/appointments/${id}`);
  }, [notOpen, go, id]);

  if (failure !== undefined) return <Problem failure={failure} onRetry={() => void reload()} />;
  if (a === undefined || draft.serviceId !== a.serviceId)
    return <LoadingState label="Loading your appointment" lines={3} />;
  if (notOpen) return null;
  return (
    <TimeStep
      rescheduleOf={{ id: a.id, version: a.version }}
      backTo={`/appointments/${a.id}`}
      nextTo={`/appointments/${a.id}/change/confirm`}
    />
  );
}
