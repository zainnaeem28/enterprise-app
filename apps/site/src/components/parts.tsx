import type { ReactNode } from 'react';
import { Banner } from '@ehr/ui';
import { bookUrl } from '../handoff.js';
import type { Doctor, Location, NextSlot, Service } from '../directory.js';
import { formatSlot } from '../format.js';

export function BookLink({
  patientOrigin,
  serviceId,
  clinicianId,
  label,
  primary = true,
}: {
  patientOrigin: string;
  serviceId?: string;
  clinicianId?: string;
  label: string;
  primary?: boolean;
}) {
  return (
    <a
      className={primary ? 'ehr-btn ehr-btn--primary' : 'ehr-btn'}
      href={bookUrl(patientOrigin, {
        ...(serviceId !== undefined ? { serviceId } : {}),
        ...(clinicianId !== undefined ? { clinicianId } : {}),
      })}
      data-book
    >
      {label}
    </a>
  );
}

/** The slot text carries its own age note: the answer is cached up to a minute (SBR, 60 s staleness). */
export function NextSlotText({ slot, timeZone }: { slot: NextSlot; timeZone: string | undefined }) {
  if (slot.state === 'slot')
    return (
      <p className="site-slot">
        Next available: <time dateTime={slot.startsAt}>{formatSlot(slot.startsAt, timeZone)}</time>
        <span className="site-muted"> (updated about a minute ago; it may change)</span>
      </p>
    );
  if (slot.state === 'none')
    return (
      <p className="site-slot">
        No online appointments are open right now. Please check back soon.
      </p>
    );
  return (
    <p className="site-slot">Availability can’t be shown right now. You can still start to book.</p>
  );
}

export function DirectoryUnavailableNotice() {
  return (
    <Banner tone="warning" title="This list is not available right now">
      Please try again in a few minutes, or contact us.
    </Banner>
  );
}

export function serviceName(services: Service[], id: string): string {
  return services.find((s) => s.id === id)?.name ?? 'Appointment';
}

export function LocationBlock({ l }: { l: Location }) {
  return (
    <address className="site-address">
      {l.addressLines.map((line) => (
        <span key={line}>
          {line}
          <br />
        </span>
      ))}
      {l.phone !== null && <a href={`tel:${l.phone.replace(/[^+\d]/g, '')}`}>{l.phone}</a>}
    </address>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="site-section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export const doctorHref = (d: Doctor) => `/doctors/${d.id}`;
