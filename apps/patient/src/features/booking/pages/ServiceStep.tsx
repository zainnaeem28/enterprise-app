import { useState } from 'react';
import { Button, EmptyState, ErrorSummary, SelectField } from '@ehr/ui';
import type { FieldError } from '@ehr/ui';
import { useBooking, useHeadingFocus, usePageTitle } from '../context.js';
import { BookingSteps } from '../components/BookingSteps.js';

/** PP-10: choose a service. */
export function ServiceStep() {
  const { services, patients, patientId, setPatientId, draft, setDraft, go } = useBooking();
  const [errors, setErrors] = useState<FieldError[]>([]);
  const heading = useHeadingFocus<HTMLHeadingElement>();
  usePageTitle('Book: service');

  const next = () => {
    if (draft.serviceId === undefined) {
      return setErrors([{ fieldId: 'service-list', message: 'Choose a service to continue.' }]);
    }
    setErrors([]);
    go('/book/doctor');
  };

  return (
    <section aria-labelledby="svc-h" className="ehr-card booking">
      <BookingSteps current="service" />
      <h1 id="svc-h" ref={heading} tabIndex={-1}>
        What would you like to book?
      </h1>
      <ErrorSummary errors={errors} />
      {patients.length > 1 && (
        <SelectField
          label="Booking for"
          value={patientId}
          onChange={(e) => setPatientId(e.target.value)}
        >
          {patients.map((p, i) => (
            <option key={p.patientId} value={p.patientId}>
              {p.relation === 'self' ? 'Me' : `Family member ${i}`}
            </option>
          ))}
        </SelectField>
      )}
      {services.length === 0 ? (
        <EmptyState message="No services are open for online booking right now. Please call the clinic." />
      ) : (
        <fieldset id="service-list" tabIndex={-1} className="booking-choices">
          <legend>Service</legend>
          {services.map((s) => (
            <label key={s.id} className="booking-choice">
              <input
                type="radio"
                name="service"
                value={s.id}
                checked={draft.serviceId === s.id}
                onChange={() =>
                  setDraft((d) => ({
                    ...d,
                    serviceId: s.id,
                    clinicianId: undefined,
                    mode: s.mode ?? d.mode,
                  }))
                }
              />
              <span>
                {s.name}
                {s.durationMin !== undefined && (
                  <span className="ehr-muted"> · {s.durationMin} minutes</span>
                )}
              </span>
            </label>
          ))}
        </fieldset>
      )}
      <p className="booking-actions">
        <Button variant="primary" onClick={next}>
          Continue
        </Button>{' '}
        <Button onClick={() => go('/appointments')}>Back to appointments</Button>
      </p>
    </section>
  );
}
