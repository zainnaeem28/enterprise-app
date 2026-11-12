import { EmptyState, StatusChip, Icon } from '@ehr/ui';
import type { ContentSource, LegalPage, Organisation } from '../content.js';
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
      <section className="site-hero">
        <div className="site-hero__copy">
          <p className="ehr-eyebrow">Care that fits into your life</p>
          <h1>{content.home.heading}</h1>
          <p className="site-lead">{content.home.intro}</p>
          <div className="site-hero__actions">
            <BookLink patientOrigin={ctx.patientOrigin} label="Book appointment" />
            <a href="/doctors">
              Find your doctor <Icon name="arrow" size={18} />
            </a>
          </div>
          <p className="site-hero__note">
            <Icon name="calendar" size={16} /> Choose your service, doctor, and appointment time.
          </p>
        </div>
        <div className="site-hero__visual">
          <div className="site-orbit" aria-hidden="true">
            <span />
            <span />
            <Icon name="heart" size={70} />
          </div>
          <div className="site-journey">
            <span className="ehr-feature-icon">
              <Icon name="calendar" size={24} />
            </span>
            <div>
              <p className="ehr-eyebrow">A little easier, from the start</p>
              <h2>Your care journey</h2>
            </div>
            <ol>
              <li>
                <span>01</span>
                <div>
                  <strong>Find the right care</strong>
                  <small>Explore our services and doctors.</small>
                </div>
                <Icon name="check" size={16} />
              </li>
              <li>
                <span>02</span>
                <div>
                  <strong>Make time for you</strong>
                  <small>Choose an available appointment.</small>
                </div>
                <Icon name="check" size={16} />
              </li>
              <li>
                <span>03</span>
                <div>
                  <strong>Come prepared</strong>
                  <small>Manage your visit in your portal.</small>
                </div>
                <Icon name="arrow" size={16} />
              </li>
            </ol>
          </div>
        </div>
      </section>
      <div className="site-intro-strip">
        <div>
          <Icon name="people" size={24} />
          <span>
            <strong>Find your care team</strong>
            <small>Get to know our doctors</small>
          </span>
        </div>
        <div>
          <Icon name="calendar" size={24} />
          <span>
            <strong>Book on your terms</strong>
            <small>Explore available appointments</small>
          </span>
        </div>
        <div>
          <Icon name="notes" size={24} />
          <span>
            <strong>Stay organised</strong>
            <small>Manage visits in your patient portal</small>
          </span>
        </div>
      </div>
      <Section title="Find the care you need">
        <div className="site-section__intro">
          <p>Explore our services and take the next step.</p>
          <a href="/services">
            All services <Icon name="arrow" size={17} />
          </a>
        </div>
        {dir === null ? (
          <DirectoryUnavailableNotice />
        ) : dir.services.length === 0 ? (
          <EmptyState message="No services are listed yet." />
        ) : (
          <ul className="site-cards">
            {dir.services.slice(0, 6).map((service) => (
              <li key={service.id} className="site-card site-service">
                <span className="ehr-feature-icon">
                  <Icon name={service.mode === 'video' ? 'message' : 'heart'} size={24} />
                </span>
                <h3>{service.name}</h3>
                <p>
                  {service.durationMin} minutes ·{' '}
                  {service.mode === 'video' ? 'Video visit' : 'In person'}
                </p>
                <BookLink
                  patientOrigin={ctx.patientOrigin}
                  serviceId={service.id}
                  label={`Book ${service.name}`}
                  primary={false}
                />
              </li>
            ))}
          </ul>
        )}
      </Section>
      <section className="site-portal-callout">
        <div>
          <p className="ehr-eyebrow">Your patient portal</p>
          <h2>One place for your next steps.</h2>
          <p>Book visits, update your details, and prepare for your appointment.</p>
        </div>
        <a className="ehr-btn ehr-btn--primary" href={ctx.patientOrigin}>
          Open patient portal <Icon name="arrow" size={18} />
        </a>
      </section>
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

/** `organisation` adds the organisation's own contact details, only those entered in the CMS. `nppHref` links the Notice of Privacy Practices. */
export function LegalPageView({
  page,
  organisation,
  nppHref,
}: {
  page: LegalPage;
  organisation?: Organisation | undefined;
  nppHref?: string | undefined;
}) {
  const org = organisation;
  const hasContact =
    org !== undefined && (org.addressLines.length > 0 || org.phone !== null || org.email !== null);
  return (
    <>
      <h1>{page.title}</h1>
      {page.paragraphs.map((p) => (
        <p key={p}>{p}</p>
      ))}
      {nppHref !== undefined && (
        <p>
          Our <a href={nppHref}>Notice of Privacy Practices</a> explains how health information is
          handled and what your rights are.
        </p>
      )}
      {org !== undefined && hasContact && (
        <>
          <h2>Contact us</h2>
          {org.name !== null && <p>{org.name}</p>}
          {org.addressLines.length > 0 && (
            <p>
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
        </>
      )}
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
