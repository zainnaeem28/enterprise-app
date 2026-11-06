import type { ReactNode } from 'react';
import { StatusChip } from '@ehr/ui';
import { useBooking } from '../context.js';
import { whenLabels } from '../time.js';
import type { Appointment, Slot } from '../types.js';

export function SummaryRow({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="booking-row">
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** Service, place, time (with zone label; both zones for a video visit), mode. Doctor name only when the directory gave one. */
export function VisitSummary({
  serviceId,
  locationId,
  startsAt,
  mode,
  timeZone,
  doctorName,
  status,
}: {
  serviceId: string;
  locationId: string;
  startsAt: string;
  mode: Slot['mode'];
  timeZone?: string | undefined;
  doctorName?: string | undefined;
  status?: ReactNode;
}) {
  const { services, places } = useBooking();
  const service = services.find((s) => s.id === serviceId);
  const place = places.find((p) => p.id === locationId);
  const zone = timeZone ?? place?.timeZone ?? 'UTC';
  return (
    <dl className="booking-summary">
      <SummaryRow term="Visit">{service?.name ?? 'Appointment'}</SummaryRow>
      <SummaryRow term="When">
        {whenLabels(startsAt, zone, mode === 'video').map((l) => (
          <span key={l} className="booking-line">
            {l}
          </span>
        ))}
      </SummaryRow>
      <SummaryRow term="Type">{mode === 'video' ? 'Video visit' : 'In person'}</SummaryRow>
      {place !== undefined && mode === 'in_person' && (
        <SummaryRow term="Where">{place.name}</SummaryRow>
      )}
      {doctorName !== undefined && <SummaryRow term="Doctor">{doctorName}</SummaryRow>}
      {status !== undefined && <SummaryRow term="Status">{status}</SummaryRow>}
    </dl>
  );
}

export const statusChip = (a: Appointment) =>
  a.status === 'confirmed' ? (
    <StatusChip tone="success">Confirmed</StatusChip>
  ) : (
    <StatusChip>{a.status.replace(/_/g, ' ')}</StatusChip>
  );

/** The cancellation policy sentence (PP-13, PP-17). Block-only default (D-3): after the cut-off a change is refused, nothing is charged, and no fee is shown. */
export function PolicyText() {
  const { policy } = useBooking();
  const until =
    policy.cutoffHours === undefined
      ? "until the clinic's cut-off time before it starts"
      : `until ${policy.cutoffHours} ${policy.cutoffHours === 1 ? 'hour' : 'hours'} before it starts`;
  return (
    <p className="booking-policy">
      <strong>Cancellation policy.</strong> You can cancel or change this appointment online {until}
      . After that, please call the clinic.
    </p>
  );
}
