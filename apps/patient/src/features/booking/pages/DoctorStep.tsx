import { useEffect, useState } from 'react';
import { Button, ErrorSummary, LoadingState, SelectField } from '@ehr/ui';
import type { FieldError } from '@ehr/ui';
import { useBooking, useHeadingFocus, usePageTitle } from '../context.js';
import { BookingSteps } from '../components/BookingSteps.js';
import { Problem } from '../components/Problem.js';
import type { Failure } from '../api.js';
import type { Doctor } from '../types.js';

const ANY = '';

/** PP-11: choose a place and a doctor ("any available doctor" is the default). */
export function DoctorStep() {
  const { api, places, draft, setDraft, go } = useBooking();
  const [doctors, setDoctors] = useState<Doctor[] | undefined>();
  const [failure, setFailure] = useState<Failure | undefined>();
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [attempt, setAttempt] = useState(0);
  const heading = useHeadingFocus<HTMLHeadingElement>();
  usePageTitle('Book: doctor and place');

  const { serviceId, locationId } = draft;
  useEffect(() => {
    if (serviceId === undefined) return go('/book');
    let live = true;
    setDoctors(undefined);
    setFailure(undefined);
    void api.doctors(serviceId, locationId).then((r) => {
      if (!live) return;
      if (r.ok) setDoctors(r.data);
      else setFailure(r);
    });
    return () => {
      live = false;
    };
  }, [api, serviceId, locationId, attempt, go]);

  // One place: nothing to choose, so it is picked for the patient and still named on screen.
  useEffect(() => {
    if (places.length === 1 && locationId === undefined)
      setDraft((d) => ({ ...d, locationId: places[0]?.id }));
  }, [places, locationId, setDraft]);

  const next = () => {
    if (draft.locationId === undefined) {
      return setErrors([{ fieldId: 'place', message: 'Choose where you want to be seen.' }]);
    }
    setErrors([]);
    go('/book/time');
  };

  return (
    <section aria-labelledby="doc-h" className="ehr-card booking">
      <BookingSteps current="doctor" />
      <h1 id="doc-h" ref={heading} tabIndex={-1}>
        Where and with whom?
      </h1>
      <ErrorSummary errors={errors} />
      <SelectField
        id="place"
        label="Place"
        value={draft.locationId ?? ''}
        onChange={(e) =>
          setDraft((d) => ({
            ...d,
            locationId: e.target.value === '' ? undefined : e.target.value,
            clinicianId: undefined,
          }))
        }
      >
        <option value="">Choose a place</option>
        {places.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </SelectField>
      {failure !== undefined ? (
        <Problem failure={failure} onRetry={() => setAttempt((n) => n + 1)} />
      ) : doctors === undefined ? (
        <LoadingState label="Loading doctors" lines={2} />
      ) : (
        <SelectField
          label="Doctor"
          value={draft.clinicianId ?? ANY}
          onChange={(e) =>
            setDraft((d) => ({
              ...d,
              clinicianId: e.target.value === ANY ? undefined : e.target.value,
            }))
          }
        >
          <option value={ANY}>Any available doctor</option>
          {doctors.map((d) => (
            <option key={d.clinicianId} value={d.clinicianId}>
              {d.displayName}
            </option>
          ))}
        </SelectField>
      )}
      <p className="booking-actions">
        <Button variant="primary" onClick={next}>
          Continue
        </Button>{' '}
        <Button onClick={() => go('/book')}>Back</Button>
      </p>
    </section>
  );
}
