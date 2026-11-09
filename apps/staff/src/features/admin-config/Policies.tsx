import { ResourceScreen } from './ResourceScreen.js';
import { POLICIES } from './specs.js';
import { configStrings as s } from './strings.js';

/** AD-07: booking policies. Late changes are blocked, not charged (D-3); a stored fee is shown as stored only. */
export function Policies() {
  return (
    <div>
      <h1 id="policies-title">{s.policiesTitle}</h1>
      <p>{s.policiesIntro}</p>
      <p>{s.auditNote}</p>
      <ResourceScreen spec={{ ...POLICIES, title: s.navPolicies }} />
    </div>
  );
}
