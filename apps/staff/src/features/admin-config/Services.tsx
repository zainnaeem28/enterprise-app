import { ResourceScreen } from './ResourceScreen.js';
import { SERVICES } from './specs.js';
import { configStrings as s } from './strings.js';

/** AD-06: the services catalogue, with the neutral display name for services that reveal a condition. */
export function Services() {
  return (
    <section aria-labelledby="services-title">
      <h1 id="services-title">{s.servicesTitle}</h1>
      <p>{s.servicesIntro}</p>
      <p>{s.auditNote}</p>
      <ResourceScreen spec={{ ...SERVICES, title: s.navServices }} />
    </section>
  );
}
