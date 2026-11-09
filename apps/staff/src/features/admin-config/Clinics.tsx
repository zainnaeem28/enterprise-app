import { ResourceScreen } from './ResourceScreen.js';
import { HOLIDAYS, HOURS, LOCATIONS, ROOMS } from './specs.js';
import { configStrings as s } from './strings.js';

/** AD-04: locations, rooms, opening hours and holidays. */
export function Clinics() {
  return (
    <section aria-labelledby="clinics-title">
      <h1 id="clinics-title">{s.clinicsTitle}</h1>
      <p>{s.auditNote}</p>
      <ResourceScreen spec={LOCATIONS} />
      <ResourceScreen spec={ROOMS} />
      <ResourceScreen spec={HOURS} />
      <ResourceScreen spec={HOLIDAYS} />
    </section>
  );
}
