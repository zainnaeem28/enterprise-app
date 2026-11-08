import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Banner, Button, ErrorSummary, StatusChip, TextField } from '@ehr/ui';
import type { Tone } from '@ehr/ui';
import { newKey } from '../../profile/lib/core.js';
import type { Failure } from '../../profile/lib/core.js';
import { useSubmit } from '../../profile/lib/forms.js';
import { useHeadingFocus, usePageTitle } from '../../profile/lib/hooks.js';
import { Problem } from '../../profile/lib/Problem.js';
import { usePrevisit } from '../ctx.js';
import { previsitPath } from '../routes.js';
import { ITEM_LABEL } from '../types.js';
import type { ConsentItem, ItemStatus } from '../types.js';

const TONE: Record<ItemStatus, Tone> = { todo: 'warning', done: 'success', fix: 'danger' };
const statusOf = (c: ConsentItem): ItemStatus =>
  c.status === 'signed' ? 'done' : c.status === 'outdated' ? 'fix' : 'todo';

/** PP-26 consents to read and e-sign. A required consent that is not signed keeps the consultation gate closed (BR-09). */
export function ConsentsPage() {
  const { previsit, reservationId, go } = usePrevisit();
  const ref = useHeadingFocus<HTMLHeadingElement>();
  usePageTitle('Consent forms');
  const items = previsit.consentItems;
  return (
    <section className="pv" aria-labelledby="c-h">
      <h1 id="c-h" ref={ref} tabIndex={-1}>
        Consent forms
      </h1>
      {!previsit.consents && (
        <Banner tone="warning" title="Your consultation cannot start yet">
          A required consent is not signed. Sign it here and your visit can go ahead.
        </Banner>
      )}
      {previsit.consents && (
        <Banner tone="info" title="All required consents are signed">
          Nothing more to do here.
        </Banner>
      )}
      {items === undefined ? (
        previsit.consents ? null : (
          <Banner tone="info" title="The forms cannot be shown here yet">
            The text of the consent forms is not available on this page yet. Ask the clinic to help
            you sign before your visit.
          </Banner>
        )
      ) : (
        <ul className="pv-items" aria-label="Consent forms">
          {items.map((c) => (
            <ConsentCard key={`${c.templateKey}`} item={c} />
          ))}
        </ul>
      )}
      <Button onClick={() => go(previsitPath(reservationId))}>Back to my pre-visit list</Button>
    </section>
  );
}

function ConsentCard({ item }: { item: ConsentItem }) {
  const { api, reload } = usePrevisit();
  const [name, setName] = useState('');
  const [agree, setAgree] = useState(false);
  const [errors, setErrors] = useState<{ fieldId: string; message: string }[]>([]);
  const [problem, setProblem] = useState<Failure | undefined>();
  const [signed, setSigned] = useState(false);
  const key = useRef(newKey());
  const { busy, run } = useSubmit();
  const status = signed ? 'done' : statusOf(item);
  const canSign = item.id !== undefined && item.text !== undefined;
  const base = `c-${item.templateKey}`;

  const sign = (e: FormEvent) => {
    e.preventDefault();
    const next: { fieldId: string; message: string }[] = [];
    if (name.trim() === '')
      next.push({ fieldId: `${base}-name`, message: 'Type your full name to sign' });
    if (!agree)
      next.push({
        fieldId: `${base}-agree`,
        message: 'Tick the box to say you have read this form',
      });
    setErrors(next);
    if (next.length > 0 || item.id === undefined) return;
    void run(async () => {
      setProblem(undefined);
      const r = await api.signConsent(item.id as string, name.trim(), key.current);
      if (!r.ok) {
        // A refusal means nothing was signed; the next try is a new step with a new key only if the first did not reach the server.
        if (r.status !== 0 && r.status < 500) key.current = newKey();
        return setProblem(r);
      }
      setSigned(true);
      reload();
    });
  };

  return (
    <li className="pv-item">
      <h2>{item.title}</h2>
      <StatusChip tone={TONE[status]}>{ITEM_LABEL[status]}</StatusChip>
      {status === 'done' ? (
        <p role="status">Signed. This stays on your record.</p>
      ) : !canSign ? (
        <p>The text of this form is not available here yet. Ask the clinic to help you sign it.</p>
      ) : (
        <>
          <div
            className="pv-consent-text"
            tabIndex={0}
            role="region"
            aria-label={`${item.title}, full text`}
          >
            {item.text}
          </div>
          <ErrorSummary errors={errors} />
          {problem !== undefined &&
            (problem.code === 'patient.consent_not_pending' ? (
              <Banner tone="warning" title="This form changed">
                A newer version is waiting. Reload to read it before you sign.
              </Banner>
            ) : (
              <Problem failure={problem} />
            ))}
          <form onSubmit={sign} noValidate>
            <label className="pv-radio" htmlFor={`${base}-agree`}>
              <input
                id={`${base}-agree`}
                type="checkbox"
                checked={agree}
                onChange={(e) => setAgree(e.target.checked)}
              />{' '}
              I have read this form and I agree.
            </label>
            <TextField
              id={`${base}-name`}
              label="Type your full name to sign"
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              {...(errors.some((x) => x.fieldId === `${base}-name`)
                ? { error: 'Type your full name' }
                : {})}
            />
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? 'Signing…' : 'Sign'}
            </Button>
          </form>
        </>
      )}
    </li>
  );
}
