import { EmptyState, StatusChip } from '@ehr/ui';
import type { ContentSource, LegalPage } from '../content.js';
import type { Directory, Doctor, Location, NextSlot } from '../directory.js';
import {
  BookLink,
  DirectoryUnavailableNotice,
  LocationBlock,
  NextSlotText,
  Section,
  doctorHref,
  serviceName,
} from '../components/parts.js';

export interface Ctx {
  patientOrigin: string;
  content: ContentSource;
  /** `null` when the directory could not be read (then pages show the notice, never an empty list as if it were true). */
  dir: Directory | null;
}

const tzOf = (dir: Directory, d: Doctor): string | undefined =>
  dir.locations.find((l) => d.locationIds.includes(l.id))?.timeZone;

export function HomePage({ ctx }: { ctx: Ctx }) {
  const { content, dir } = ctx;
  return (
    <>
      <h1>{content.home.heading}</h1>
      <p className="site-lead">{content.home.intro}</p>
      <p>
        <BookLink patientOrigin={ctx.patientOrigin} label="Book appointment" />
      </p>
      <Section title="Services">
        {dir === null ? (
          <DirectoryUnavailableNotice />
        ) : (
          <ul className="site-cards">
            {dir.services.slice(0, 6).map((s) => (
              <li key={s.id} className="site-card">
                {s.name}
              </li>
            ))}
          </ul>
        )}
        <p>
          <a href="/services">All services</a> · <a href="/doctors">Find a doctor</a> ·{' '}
          <a href="/locations">Locations</a>
        </p>
      </Section>
    </>
  );
}

export function AboutPage({ ctx }: { ctx: Ctx }) {
  const { content, dir } = ctx;
  return (
    <>
      <h1>{content.organisation.name === null ? 'About' : `About ${content.organisation.name}`}</h1>
      <p className="site-lead">{content.about.intro}</p>
      <Section title="What we offer">
        {dir === null ? (
          <DirectoryUnavailableNotice />
        ) : dir.services.length === 0 ? (
          <EmptyState message="No services are listed yet." />
        ) : (
          <ul className="site-cards">
            {dir.services.map((s) => (
              <li key={s.id} className="site-card">
                {s.name}
              </li>
            ))}
          </ul>
        )}
        <p>
          <a href="/services">All services</a> · <a href="/doctors">Find a doctor</a> ·{' '}
          <a href="/locations">Locations</a>
        </p>
      </Section>
      {content.organisation.clinicians.length > 0 && (
        <Section title="Our team">
          <ul className="site-cards">
            {content.organisation.clinicians.map((c) => (
              <li key={c.name} className="site-card">
                {c.name}
                {c.title !== null && <>, {c.title}</>}
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title="How booking works">
        <p>{content.about.booking}</p>
        <p>
          <BookLink patientOrigin={ctx.patientOrigin} label="Book appointment" />{' '}
          <a href="/contact">Contact</a>
        </p>
      </Section>
    </>
  );
}

export function ServicesPage({ ctx }: { ctx: Ctx }) {
  const { dir } = ctx;
  return (
    <>
      <h1>Services</h1>
      {dir === null ? (
        <DirectoryUnavailableNotice />
      ) : dir.services.length === 0 ? (
        <EmptyState message="No services are listed yet." />
      ) : (
        <ul className="site-cards">
          {dir.services.map((s) => (
            <li key={s.id} className="site-card">
              <h2>{s.name}</h2>
              <p>
                {s.durationMin} minutes ·{' '}
                <StatusChip tone="info">
                  {s.mode === 'video' ? 'Video visit' : 'In person'}
                </StatusChip>
              </p>
              <BookLink
                patientOrigin={ctx.patientOrigin}
                serviceId={s.id}
                label={`Book ${s.name}`}
                primary={false}
              />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function DoctorsPage({ ctx, slots }: { ctx: Ctx; slots: Map<string, NextSlot> }) {
  const { dir } = ctx;
  return (
    <>
      <h1>Find a doctor</h1>
      {dir === null ? (
        <DirectoryUnavailableNotice />
      ) : dir.doctors.length === 0 ? (
        <EmptyState message="No doctors are listed yet." />
      ) : (
        <ul className="site-cards">
          {dir.doctors.map((d) => {
            const sid = d.serviceIds[0];
            return (
              <li key={d.id} className="site-card">
                <h2>
                  <a href={doctorHref(d)}>{d.name}</a>
                </h2>
                <NextSlotText
                  slot={slots.get(d.id) ?? { state: 'unknown' }}
                  timeZone={tzOf(dir, d)}
                />
                <BookLink
                  patientOrigin={ctx.patientOrigin}
                  clinicianId={d.id}
                  {...(sid !== undefined ? { serviceId: sid } : {})}
                  label={`Book with ${d.name}`}
                />
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

export function DoctorPage({
  ctx,
  doctor,
  slots,
}: {
  ctx: Ctx;
  doctor: Doctor;
  slots: Map<string, NextSlot>;
}) {
  const dir = ctx.dir;
  if (dir === null) return <DirectoryUnavailableNotice />;
  const places = dir.locations.filter((l) => doctor.locationIds.includes(l.id));
  return (
    <>
      <p>
        <a href="/doctors">← All doctors</a>
      </p>
      <h1>{doctor.name}</h1>
      {places.length > 0 && (
        <Section title="Where">
          <ul>
            {places.map((l) => (
              <li key={l.id}>{l.name}</li>
            ))}
          </ul>
        </Section>
      )}
      <Section title="Appointments">
        {doctor.serviceIds.length === 0 ? (
          <p>
            <BookLink
              patientOrigin={ctx.patientOrigin}
              clinicianId={doctor.id}
              label={`Book with ${doctor.name}`}
            />
          </p>
        ) : (
          <ul className="site-cards">
            {doctor.serviceIds.map((sid) => (
              <li key={sid} className="site-card">
                <h3>{serviceName(dir.services, sid)}</h3>
                <NextSlotText
                  slot={slots.get(sid) ?? { state: 'unknown' }}
                  timeZone={tzOf(dir, doctor)}
                />
                <BookLink
                  patientOrigin={ctx.patientOrigin}
                  serviceId={sid}
                  clinicianId={doctor.id}
                  label={`Book ${serviceName(dir.services, sid)}`}
                />
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

function mapHref(l: Location): string | null {
  if (l.geo === null) return null;
  return `https://www.openstreetmap.org/?mlat=${l.geo.lat}&mlon=${l.geo.lng}#map=16/${l.geo.lat}/${l.geo.lng}`;
}

export function LocationsPage({ ctx }: { ctx: Ctx }) {
  const { dir } = ctx;
  return (
    <>
      <h1>Locations</h1>
      {dir === null ? (
        <DirectoryUnavailableNotice />
      ) : dir.locations.length === 0 ? (
        <EmptyState message="No locations are listed yet." />
      ) : (
        <ul className="site-cards">
          {dir.locations.map((l) => {
            const href = mapHref(l);
            return (
              <li key={l.id} className="site-card">
                <h2>{l.name}</h2>
                <LocationBlock l={l} />
                {href !== null && (
                  <p>
                    <a href={href} target="_blank" rel="noopener noreferrer">
                      Open map (opens OpenStreetMap in a new tab)
                    </a>
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

export function ContactPage({ ctx }: { ctx: Ctx }) {
  const c = ctx.content.contact;
  const org = ctx.content.organisation;
  const { dir } = ctx;
  return (
    <>
      <h1>Contact</h1>
      <p className="site-lead">{c.intro}</p>
      {org.addressLines.length > 0 && (
        <p>
          Address:{' '}
          {org.addressLines.map((l, i) => (
            <span key={l}>
              {i > 0 && <br />}
              {l}
            </span>
          ))}
        </p>
      )}
      {org.phone !== null && <p>Phone: {org.phone}</p>}
      {org.email !== null && (
        <p>
          Email: <a href={`mailto:${org.email}`}>{org.email}</a>
        </p>
      )}
      {org.hours !== null && <p>Hours: {org.hours}</p>}
      <Section title="Our locations">
        {dir === null ? (
          <DirectoryUnavailableNotice />
        ) : (
          <ul className="site-cards">
            {dir.locations.map((l) => (
              <li key={l.id} className="site-card">
                <h3>{l.name}</h3>
                <LocationBlock l={l} />
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

export function LegalPageView({ page }: { page: LegalPage }) {
  return (
    <>
      <h1>{page.title}</h1>
      {page.paragraphs.map((p) => (
        <p key={p}>{p}</p>
      ))}
    </>
  );
}

export function NotFoundPage() {
  return (
    <>
      <h1>Page not found</h1>
      <p>We couldn’t find that page.</p>
      <p>
        <a href="/">Go to the home page</a>
      </p>
    </>
  );
}
