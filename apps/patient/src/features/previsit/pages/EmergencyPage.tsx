import { Banner, Button } from '@ehr/ui';
import { useHeadingFocus, usePageTitle } from '../../profile/lib/hooks.js';
import { usePrevisit } from '../ctx.js';
import { previsitPath } from '../routes.js';

/** Shown only when the questionnaire result is a red flag. This is the neutral default used when the questionnaire template supplies no advice (wording sign-off is tracked in docs/GO-LIVE.md item 11). */
export const DEFAULT_EMERGENCY_ADVICE =
  'Some of your answers may need attention right away. If you feel unwell now or think this is an emergency, call 911 or your local emergency number. Do not wait for your visit.';

/**
 * PP-22 emergency advice. The advice text is the one the reviewed questionnaire template supplies; it is shown as returned. When
 * the page is opened without it (a reload), the fixed default text is shown. No dismiss that hides it, no clinical advice beyond
 * the text. Calling is a link, so it works as a dial button on phones.
 */
export function EmergencyPage() {
  const { advice, reservationId, go } = usePrevisit();
  const ref = useHeadingFocus<HTMLHeadingElement>();
  usePageTitle('Important');
  return (
    <section aria-labelledby="pv-em" className="pv">
      <h1 id="pv-em" ref={ref} tabIndex={-1}>
        Please read this now
      </h1>
      <Banner tone="danger" title="Emergency advice">
        <p className="pv-advice">{advice ?? DEFAULT_EMERGENCY_ADVICE}</p>
      </Banner>
      <p>
        <a className="ehr-btn ehr-btn--primary pv-call" href="tel:911">
          Call 911
        </a>
      </p>
      <p>
        Your answers were sent to the clinic. This screen does not replace the clinic&apos;s own
        advice.
      </p>
      <Button onClick={() => go(previsitPath(reservationId))}>Back to my pre-visit list</Button>
    </section>
  );
}
