import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Banner, Button, ErrorSummary, SelectField, TextField } from '@ehr/ui';
import { newKey } from '../lib/core.js';
import { useAccountCtx } from '../lib/ctx.js';
import { summaryOf, useSubmit } from '../lib/forms.js';
import { useHeadingFocus, usePageTitle } from '../lib/hooks.js';
import { Problem } from '../lib/Problem.js';
import type { Failure } from '../lib/core.js';
import { PROXY_RELATIONSHIPS } from '../types.js';
import type { ProxyRelationship } from '../types.js';

const LABEL: Record<ProxyRelationship, string> = {
  parent: 'Parent',
  guardian: 'Guardian',
  carer: 'Carer',
  other: 'Other',
};

/**
 * PP-07: ask the clinic to link a family member. The server creates a `requested` link that staff verify, and refuses with
 * `identity.proxy_rules_not_configured` until the D-7 rule values exist. That refusal is shown as "not open yet", never as sent.
 */
export function AddProxyPage() {
  const { api, selfId, go } = useAccountCtx();
  const [relationship, setRelationship] = useState<ProxyRelationship>('parent');
  const [name, setName] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<Failure | undefined>();
  const [notOpen, setNotOpen] = useState(false);
  const [sent, setSent] = useState(false);
  const key = useRef(newKey());
  const { busy, run } = useSubmit();
  const heading = useHeadingFocus<HTMLHeadingElement>();
  usePageTitle('Link a family member');

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (selfId === undefined) return;
    const found: Record<string, string> = {};
    const trimmed = name.trim();
    if (trimmed === '' || trimmed.length > 100)
      found['proxy-name'] = 'Their name: enter a name of up to 100 characters.';
    setErrors(found);
    setFailure(undefined);
    setNotOpen(false);
    if (Object.keys(found).length > 0) return;
    await run(async () => {
      const r = await api.requestProxy(
        selfId,
        { relationship, patientDisplayName: trimmed },
        key.current,
      );
      if (r.ok) return setSent(true);
      if (r.code === 'identity.proxy_rules_not_configured') return setNotOpen(true);
      if (r.status === 400)
        return setErrors({
          'proxy-name': 'Their name: this was not accepted. Check it and try again.',
        });
      setFailure(r);
    });
  }

  if (selfId === undefined)
    return (
      <section aria-labelledby="add-h" className="ehr-card profile">
        <h1 id="add-h" ref={heading} tabIndex={-1}>
          Link a family member
        </h1>
        <p>Only a patient with their own record can ask to link a family member.</p>
        <Button onClick={() => go('/family')}>Back to family and access</Button>
      </section>
    );

  if (sent)
    return (
      <section aria-labelledby="add-h" className="ehr-card profile">
        <h1 id="add-h" ref={heading} tabIndex={-1}>
          Request sent
        </h1>
        <Banner tone="info">
          The clinic will check who this person is. Nothing is shared until they have. You can
          follow the status under Family and access.
        </Banner>
        <Button variant="primary" onClick={() => go('/family')}>
          See family and access
        </Button>
      </section>
    );

  return (
    <section aria-labelledby="add-h" className="ehr-card profile">
      <h1 id="add-h" ref={heading} tabIndex={-1}>
        Link a family member
      </h1>
      <p>
        A linked person can see your appointments only. The clinic checks who they are before the
        link starts.
      </p>
      <ErrorSummary errors={summaryOf(errors)} />
      {notOpen && (
        <Banner tone="warning" title="Linking family members is not open yet">
          Nothing was sent. The clinic is still setting up how these links are checked. Please call
          the clinic if you need someone to help with your appointments now.
        </Banner>
      )}
      {failure !== undefined && <Problem failure={failure} onRetry={() => setFailure(undefined)} />}
      <form onSubmit={(e) => void submit(e)} noValidate aria-label="Link a family member">
        <SelectField
          id="proxy-rel"
          label="How are they related to you?"
          value={relationship}
          onChange={(e) => setRelationship(e.target.value as ProxyRelationship)}
        >
          {PROXY_RELATIONSHIPS.map((r) => (
            <option key={r} value={r}>
              {LABEL[r]}
            </option>
          ))}
        </SelectField>
        <TextField
          id="proxy-name"
          label="Their name"
          hint="First name and last initial is enough."
          autoComplete="off"
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={errors['proxy-name']}
        />
        <p className="profile-actions">
          <Button type="submit" variant="primary" disabled={busy} aria-busy={busy}>
            Send request
          </Button>{' '}
          <Button onClick={() => go('/family')}>Cancel</Button>
        </p>
      </form>
    </section>
  );
}
