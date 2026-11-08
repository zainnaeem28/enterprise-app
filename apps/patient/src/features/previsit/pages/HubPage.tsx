import { useEffect, useState } from 'react';
import { Banner, Button, StatusChip } from '@ehr/ui';
import type { Tone } from '@ehr/ui';
import { useHeadingFocus, usePageTitle } from '../../profile/lib/hooks.js';
import { usePrevisit } from '../ctx.js';
import { previsitPath } from '../routes.js';
import { ITEM_LABEL } from '../types.js';
import type { ItemStatus } from '../types.js';

const TONE: Record<ItemStatus, Tone> = { todo: 'warning', done: 'success', fix: 'danger' };

/**
 * PP-25..27 overview (J-06): the three pre-visit items, each "To do", "Done" or "Needs fixing". A required consent that is not
 * signed keeps the consultation gate closed (BR-09); the page says so. The gate itself is enforced by the server.
 */
export function HubPage() {
  const { api, patientId, previsit, go, reservationId } = usePrevisit();
  const ref = useHeadingFocus<HTMLHeadingElement>();
  usePageTitle('Before your visit');
  const [cardFix, setCardFix] = useState(false);

  useEffect(() => {
    let live = true;
    void api.documents.list(patientId).then((r) => {
      if (!live || !r.ok) return;
      const cards = r.data.filter((d) => d.classification === 'insurance_card');
      setCardFix(
        cards.some((d) => d.status === 'quarantined') &&
          !cards.some((d) => d.status === 'clean' || d.status === 'confirmed'),
      );
    });
    return () => {
      live = false;
    };
  }, [api, patientId]);

  const consentFix = previsit.consentItems?.some((c) => c.status === 'outdated') === true;
  const items: { id: string; part: string; label: string; status: ItemStatus; note: string }[] = [
    {
      id: 'questionnaire',
      part: 'questionnaire',
      label: 'Health questionnaire',
      status: previsit.questionnaire ? 'done' : 'todo',
      note: previsit.questionnaire ? 'Sent to the clinic.' : 'A few questions about how you are.',
    },
    {
      id: 'consents',
      part: 'consents',
      label: 'Consent forms',
      status: previsit.consents ? 'done' : consentFix ? 'fix' : 'todo',
      note: previsit.consents
        ? 'All required consents are signed.'
        : consentFix
          ? 'A consent has a newer version. Please read and sign it again.'
          : 'Read and sign the forms your visit needs.',
    },
    {
      id: 'insurance',
      part: 'insurance',
      label: 'Insurance card',
      status: previsit.insurance ? 'done' : cardFix ? 'fix' : 'todo',
      note: previsit.insurance
        ? 'Your insurance details are on file.'
        : cardFix
          ? 'A photo could not be accepted. Please upload it again.'
          : 'Photos of the front and back of your card.',
    },
  ];

  return (
    <section aria-labelledby="pv-h" className="pv">
      <h1 id="pv-h" ref={ref} tabIndex={-1}>
        Before your visit
      </h1>
      <p>Three things help the clinic get ready. Each shows where you are.</p>
      {!previsit.consents && (
        <Banner tone="warning" title="Your consultation cannot start yet">
          A required consent is not signed. Sign it below and your visit can go ahead.
        </Banner>
      )}
      <ul className="pv-items" aria-label="Pre-visit items">
        {items.map((i) => (
          <li key={i.id} className="pv-item">
            <h2>{i.label}</h2>
            <StatusChip tone={TONE[i.status]}>{ITEM_LABEL[i.status]}</StatusChip>
            <p>{i.note}</p>
            <Button
              variant={i.status === 'done' ? 'secondary' : 'primary'}
              onClick={() => go(previsitPath(reservationId, i.part))}
              aria-label={`${i.status === 'done' ? 'Review' : 'Open'}: ${i.label}`}
            >
              {i.status === 'done' ? 'Review' : 'Open'}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
