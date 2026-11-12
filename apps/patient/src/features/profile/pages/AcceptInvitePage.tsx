import { useState } from 'react';
import type { FormEvent } from 'react';
import { Banner, Button, ErrorSummary, Icon, TextField } from '@ehr/ui';
import type { Failure } from '../lib/core.js';
import { useAccountCtx } from '../lib/ctx.js';
import { summaryOf, useSubmit } from '../lib/forms.js';
import { useHeadingFocus, usePageTitle } from '../lib/hooks.js';
import { Problem } from '../lib/Problem.js';

/**
 * Proxy verification: the invited person signs in with the account whose own e-mail address was invited and enters the code from
 * that e-mail. The server gives one answer (422) for a wrong, expired, locked, used or foreign code, so this screen never says
 * which of those it was and never repeats the code.
 */
export function AcceptInvitePage({ grantId }: { grantId: string }) {
  const { api, go } = useAccountCtx();
  const [code, setCode] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [refused, setRefused] = useState(false);
  const [failure, setFailure] = useState<Failure | undefined>();
  const [done, setDone] = useState(false);
  const { busy, run } = useSubmit();
  const heading = useHeadingFocus<HTMLHeadingElement>();
  usePageTitle('Confirm your invitation');

  async function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = code.trim();
    setFailure(undefined);
    setRefused(false);
    if (trimmed === '') {
      setErrors({ 'invite-code': 'The code: enter the code from the email.' });
      return;
    }
    setErrors({});
    await run(async () => {
      const r = await api.acceptInvite(grantId, trimmed);
      if (r.ok) return setDone(true);
      if (r.status === 422 || r.status === 400) return setRefused(true);
      setFailure(r);
    });
  }

  if (done)
    return (
      <section aria-labelledby="accept-h" className="ehr-card profile profile-invitation">
        <span className="ehr-feature-icon">
          <Icon name={done ? 'check' : 'people'} size={24} />
        </span>
        <h1 id="accept-h" ref={heading} tabIndex={-1}>
          You are linked
        </h1>
        <Banner tone="info">
          The invitation is accepted. You can now see what the person who invited you chose to
          share. You can leave at any time from Family and access.
        </Banner>
        <Button variant="primary" onClick={() => go('/family')}>
          See family and access
        </Button>
      </section>
    );

  return (
    <section aria-labelledby="accept-h" className="ehr-card profile profile-invitation">
      <span className="ehr-feature-icon">
        <Icon name={done ? 'check' : 'people'} size={24} />
      </span>
      <h1 id="accept-h" ref={heading} tabIndex={-1}>
        Confirm your invitation
      </h1>
      <p>
        Enter the code from the invitation email. Sign in with the account that uses the email
        address the invitation was sent to.
      </p>
      <ErrorSummary errors={summaryOf(errors)} />
      {refused && (
        <Banner tone="warning" title="That code was not accepted">
          The code may be wrong, out of date or already used, or this account may not be the one
          invited. Check the email and try again. If it keeps failing, ask the person to send a new
          invitation.
        </Banner>
      )}
      {failure !== undefined && <Problem failure={failure} onRetry={() => setFailure(undefined)} />}
      <form onSubmit={(e) => void submit(e)} noValidate aria-label="Confirm your invitation">
        <TextField
          id="invite-code"
          label="Code from the email"
          autoComplete="one-time-code"
          inputMode="numeric"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          error={errors['invite-code']}
        />
        <p className="profile-actions">
          <Button type="submit" variant="primary" disabled={busy} aria-busy={busy}>
            Confirm
          </Button>{' '}
          <Button onClick={() => go('/family')}>Cancel</Button>
        </p>
      </form>
    </section>
  );
}
