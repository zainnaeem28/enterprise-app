import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Banner, Button, ErrorSummary, LoadingState, SelectField, TextField } from '@ehr/ui';
import type { Failure } from '../lib/core.js';
import { useAccountCtx } from '../lib/ctx.js';
import { ConflictPanel, failureText, summaryOf, useSubmit } from '../lib/forms.js';
import { useHeadingFocus, usePageTitle } from '../lib/hooks.js';
import { Problem } from '../lib/Problem.js';
import type { Channel, Preferences } from '../types.js';

const CHANNEL_LABEL: Record<Channel, string> = {
  email: 'Email',
  sms: 'Text message (SMS)',
  push: 'Notification on my phone',
  in_app: 'In the patient portal',
};
const OPTIONAL: Channel[] = ['email', 'sms', 'push'];
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

interface Form {
  channels: Channel[];
  reminderChannel: Channel | '';
  quiet: boolean;
  start: string;
  end: string;
  timeZone: string;
}

const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';

const formOf = (p: Preferences): Form => ({
  channels: p.channels.filter((c) => c !== 'in_app'),
  reminderChannel: p.reminderChannel ?? '',
  quiet: p.quietHours !== null,
  start: p.quietHours?.start ?? '22:00',
  end: p.quietHours?.end ?? '07:00',
  timeZone: p.quietHours?.timeZone || zone(),
});

/** The body of the PUT. `in_app` is always in it: a patient cannot switch off the in-portal notice (TC-NT-04). */
export function bodyOf(f: Form, language: string): Record<string, unknown> {
  const channels: Channel[] = [...f.channels, 'in_app'];
  return {
    channels,
    reminderChannel: f.reminderChannel === '' ? null : f.reminderChannel,
    language,
    quietHours: f.quiet ? { start: f.start, end: f.end, timeZone: f.timeZone } : null,
  };
}

/**
 * PP-36: how the patient is contacted. The API stores channels, a reminder channel and quiet hours (not one channel per message
 * type). Safety and security notices are always shown in the portal, which is the one channel that cannot be switched off.
 */
export function NotificationsPage() {
  const { api, selfId, go } = useAccountCtx();
  const [prefs, setPrefs] = useState<Preferences | undefined>();
  const [form, setForm] = useState<Form | undefined>();
  const [has, setHas] = useState<{ phone: boolean; email: boolean } | undefined>();
  const [failure, setFailure] = useState<Failure | undefined>();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [conflict, setConflict] = useState<{ label: string; value: string }[] | undefined>();
  const [refused, setRefused] = useState<string | undefined>();
  const { busy, run } = useSubmit();
  const heading = useHeadingFocus<HTMLHeadingElement>();
  usePageTitle('Notification preferences');

  const load = useCallback(async () => {
    if (selfId === undefined) return;
    const [p, prof] = await Promise.all([api.preferences(selfId), api.profile(selfId)]);
    if (!p.ok) return setFailure(p);
    setFailure(undefined);
    setPrefs(p.data);
    setForm(formOf(p.data));
    // Only a convenience: the server refuses a channel without an address (422) whether or not this read worked.
    setHas(prof.ok ? { phone: prof.data.phone !== '', email: prof.data.email !== '' } : undefined);
  }, [api, selfId]);
  useEffect(() => {
    void load();
  }, [load]);

  if (selfId === undefined)
    return (
      <section aria-labelledby="np-h" className="ehr-card profile">
        <h1 id="np-h" ref={heading} tabIndex={-1}>
          Notification preferences
        </h1>
        <p>
          Notification preferences belong to the patient. Your account can see appointments only.
        </p>
        <Button onClick={() => go('/family')}>Back to family and access</Button>
      </section>
    );
  if (failure !== undefined && prefs === undefined)
    return <Problem failure={failure} onRetry={() => void load()} />;
  if (prefs === undefined || form === undefined)
    return <LoadingState label="Loading your preferences" lines={4} />;

  const toggle = (c: Channel) => {
    const on = form.channels.includes(c);
    const channels = on ? form.channels.filter((x) => x !== c) : [...form.channels, c];
    setForm({
      ...form,
      channels,
      reminderChannel: form.reminderChannel === c && on ? '' : form.reminderChannel,
    });
    setSaved(false);
  };
  const missing = (c: Channel) =>
    has !== undefined && ((c === 'sms' && !has.phone) || (c === 'email' && !has.email));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (prefs === undefined || form === undefined || selfId === undefined) return;
    const found: Record<string, string> = {};
    if (form.quiet) {
      if (!HHMM.test(form.start)) found['qh-start'] = 'Quiet hours start: enter a time like 22:00.';
      if (!HHMM.test(form.end)) found['qh-end'] = 'Quiet hours end: enter a time like 07:00.';
      if (HHMM.test(form.start) && form.start === form.end)
        found['qh-end'] = 'Quiet hours: the start and the end must be different times.';
    }
    setErrors(found);
    setRefused(undefined);
    if (Object.keys(found).length > 0) return;
    await run(async () => {
      const r = await api.savePreferences(selfId, prefs.version, bodyOf(form, prefs.language));
      if (r.ok) {
        setSaved(true);
        setConflict(undefined);
        setPrefs(r.data);
        setForm(formOf(r.data));
        return;
      }
      if (r.status === 412) {
        setConflict([
          { label: 'Contact me by', value: form.channels.map((c) => CHANNEL_LABEL[c]).join(', ') },
        ]);
        return;
      }
      const text = failureText(r);
      if (text !== undefined) return setRefused(text);
      setFailure(r);
    });
  }

  return (
    <section aria-labelledby="np-h" className="ehr-card profile">
      <h1 id="np-h" ref={heading} tabIndex={-1}>
        Notification preferences
      </h1>
      <ErrorSummary errors={summaryOf(errors)} />
      {saved && (
        <Banner tone="info" title="Your preferences were saved">
          We will use them for new messages.
        </Banner>
      )}
      {conflict !== undefined && (
        <ConflictPanel
          mine={conflict}
          onReload={() => {
            setConflict(undefined);
            void load();
          }}
        />
      )}
      {refused !== undefined && <Banner tone="warning">{refused}</Banner>}
      {failure !== undefined && prefs !== undefined && (
        <Problem failure={failure} onRetry={() => setFailure(undefined)} />
      )}

      <form onSubmit={(e) => void submit(e)} noValidate aria-label="Notification preferences">
        <fieldset className="profile-set">
          <legend>Contact me by</legend>
          <label className="profile-choice">
            <input type="checkbox" checked disabled aria-describedby="np-always" />
            {CHANNEL_LABEL.in_app}
          </label>
          <p id="np-always" className="profile-note">
            Always on. Safety and security notices are always shown in the portal and cannot be
            switched off.
          </p>
          {OPTIONAL.map((c) => (
            <div key={c}>
              <label className="profile-choice">
                <input
                  type="checkbox"
                  checked={form.channels.includes(c)}
                  onChange={() => toggle(c)}
                  aria-describedby={missing(c) ? `np-miss-${c}` : undefined}
                />
                {CHANNEL_LABEL[c]}
              </label>
              {missing(c) && (
                <p id={`np-miss-${c}`} className="profile-note">
                  {c === 'sms'
                    ? 'Add a phone number under Your details to use text messages.'
                    : 'Add an email address under Your details to use email.'}
                </p>
              )}
            </div>
          ))}
        </fieldset>

        <SelectField
          id="reminder"
          label="Send appointment reminders by"
          value={form.reminderChannel}
          onChange={(e) => {
            setForm({ ...form, reminderChannel: e.target.value as Channel | '' });
            setSaved(false);
          }}
        >
          <option value="">No preference</option>
          {[...form.channels, 'in_app' as Channel].map((c) => (
            <option key={c} value={c}>
              {CHANNEL_LABEL[c]}
            </option>
          ))}
        </SelectField>

        <fieldset className="profile-set">
          <legend>Quiet hours</legend>
          <label className="profile-choice">
            <input
              type="checkbox"
              checked={form.quiet}
              onChange={() => {
                setForm({ ...form, quiet: !form.quiet });
                setSaved(false);
              }}
            />
            Use quiet hours
          </label>
          {form.quiet && (
            <>
              <TextField
                id="qh-start"
                label="Quiet hours start (24-hour)"
                value={form.start}
                onChange={(e) => setForm({ ...form, start: e.target.value })}
                error={errors['qh-start']}
              />
              <TextField
                id="qh-end"
                label="Quiet hours end (24-hour)"
                value={form.end}
                onChange={(e) => setForm({ ...form, end: e.target.value })}
                error={errors['qh-end']}
              />
              <p className="profile-note">Times are in {form.timeZone}.</p>
            </>
          )}
        </fieldset>

        <p className="profile-actions">
          <Button type="submit" variant="primary" disabled={busy} aria-busy={busy}>
            Save preferences
          </Button>{' '}
          <Button onClick={() => go('/profile')}>Back to your details</Button>
        </p>
      </form>
    </section>
  );
}
