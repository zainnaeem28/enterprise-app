import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  Banner,
  Button,
  ErrorSummary,
  LoadingState,
  PermissionNote,
  SelectField,
  TextField,
} from '@ehr/ui';
import { newKey } from '../lib/core.js';
import type { Failure } from '../lib/core.js';
import { useAccountCtx } from '../lib/ctx.js';
import { ConflictPanel, failureText, summaryOf, useSubmit } from '../lib/forms.js';
import { useHeadingFocus, usePageTitle } from '../lib/hooks.js';
import { Problem } from '../lib/Problem.js';
import type { Contact, Profile } from '../types.js';

interface Form {
  phone: string;
  email: string;
  line1: string;
  line2: string;
  city: string;
  postalCode: string;
  stateCode: string;
  preferredLanguage: string;
  pharmacyName: string;
}

const LABEL: Record<keyof Form, string> = {
  phone: 'Phone number',
  email: 'Email address',
  line1: 'Address line 1',
  line2: 'Address line 2',
  city: 'City',
  postalCode: 'ZIP code',
  stateCode: 'State',
  preferredLanguage: 'Preferred language',
  pharmacyName: 'Preferred pharmacy',
};

const formOf = (p: Profile): Form => ({
  phone: p.phone,
  email: p.email,
  line1: p.address.line1,
  line2: p.address.line2,
  city: p.address.city,
  postalCode: p.address.postalCode,
  stateCode: p.stateCode,
  preferredLanguage: p.preferredLanguage,
  pharmacyName: p.pharmacyName,
});

const LANGUAGES: Record<string, string> = { en: 'English', es: 'Spanish' };

/** The server field name behind each form field (the 400 names fields by API path, not by screen field). */
const FIELD_OF: Record<string, keyof Form> = {
  phone: 'phone',
  email: 'email',
  address: 'line1',
  stateCode: 'stateCode',
  preferredLanguage: 'preferredLanguage',
  preferredPharmacy: 'pharmacyName',
};

/** Client-side checks that only save a round trip; the server decides (TC-PP-02). Messages never echo the value (CN-03). */
export function validate(f: Form, was: Form): Record<string, string> {
  const e: Record<string, string> = {};
  if (f.phone.trim() === '' && was.phone !== '')
    e['phone'] =
      'Phone number: enter a new number, or restore the old one. It cannot be left empty.';
  else if (f.phone !== '' && !/^\+?[0-9 ()\-.]{7,20}$/.test(f.phone.trim()))
    e['phone'] = 'Phone number: use digits only, for example 555 010 0100.';
  if (f.email.trim() === '' && was.email !== '')
    e['email'] =
      'Email address: enter a new address, or restore the old one. It cannot be left empty.';
  else if (f.email !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim()))
    e['email'] = 'Email address: enter it like name@example.com.';
  if (f.stateCode !== '' && !/^[A-Za-z]{2}$/.test(f.stateCode.trim()))
    e['stateCode'] = 'State: use the two-letter code (letters only).';
  if (
    f.line1.length > 200 ||
    f.line2.length > 200 ||
    f.city.length > 100 ||
    f.pharmacyName.length > 200
  )
    e['line1'] = 'Address or pharmacy: one of the entries is too long. Shorten it.';
  return e;
}

/** Only what changed goes in the PATCH. An address is sent whole when any part of it changed. */
export function patchOf(f: Form, was: Form): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (f.phone.trim() !== was.phone && f.phone.trim() !== '') patch['phone'] = f.phone.trim();
  if (f.email.trim() !== was.email && f.email.trim() !== '') patch['email'] = f.email.trim();
  if (f.stateCode.trim() !== was.stateCode && f.stateCode.trim() !== '')
    patch['stateCode'] = f.stateCode.trim().toUpperCase();
  if (f.preferredLanguage !== was.preferredLanguage && f.preferredLanguage !== '')
    patch['preferredLanguage'] = f.preferredLanguage;
  if (f.pharmacyName.trim() !== was.pharmacyName && f.pharmacyName.trim() !== '')
    patch['preferredPharmacy'] = { name: f.pharmacyName.trim() };
  if (
    (['line1', 'line2', 'city', 'postalCode'] as const).some((k) => f[k].trim() !== was[k]) &&
    f.line1.trim() !== ''
  ) {
    patch['address'] = Object.fromEntries(
      (['line1', 'line2', 'city', 'postalCode'] as const)
        .filter((k) => f[k].trim() !== '')
        .map((k) => [k, f[k].trim()]),
    );
  }
  return patch;
}

const changedLabels = (patch: Record<string, unknown>): string[] =>
  Object.keys(patch).map((k) =>
    k === 'address'
      ? 'Address'
      : k === 'preferredPharmacy'
        ? LABEL.pharmacyName
        : LABEL[k as keyof Form],
  );

/** PP-35: profile and contact details. Name and date of birth are shown, not edited here. */
export function ProfilePage() {
  const { api, selfId, go } = useAccountCtx();
  const [profile, setProfile] = useState<Profile | undefined>();
  const [form, setForm] = useState<Form | undefined>();
  const [failure, setFailure] = useState<Failure | undefined>();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<string[] | undefined>();
  const [conflict, setConflict] = useState<{ label: string; value: string }[] | undefined>();
  const [refused, setRefused] = useState<string | undefined>();
  const { busy, run } = useSubmit();
  const heading = useHeadingFocus<HTMLHeadingElement>();
  usePageTitle('Your details');

  const load = useCallback(async () => {
    if (selfId === undefined) return;
    const r = await api.profile(selfId);
    if (!r.ok) return setFailure(r);
    setFailure(undefined);
    setProfile(r.data);
    setForm(formOf(r.data));
  }, [api, selfId]);
  useEffect(() => {
    void load();
  }, [load]);

  if (selfId === undefined)
    return (
      <section aria-labelledby="profile-h" className="ehr-card profile">
        <h1 id="profile-h" ref={heading} tabIndex={-1}>
          Your details
        </h1>
        <PermissionNote scope="Appointments only" />
        <p>
          Your account is linked to appointments for other people. Only the patient can see and
          change their own details.
        </p>
        <Button onClick={() => go('/family')}>Back to family and access</Button>
      </section>
    );
  if (failure !== undefined && profile === undefined)
    return <Problem failure={failure} onRetry={() => void load()} />;
  if (profile === undefined || form === undefined)
    return <LoadingState label="Loading your details" lines={4} />;

  const set = (k: keyof Form) => (e: { target: { value: string } }) => {
    setForm({ ...form, [k]: e.target.value });
    setSaved(undefined);
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (profile === undefined || form === undefined || selfId === undefined) return;
    const found = validate(form, formOf(profile));
    setErrors(found);
    setRefused(undefined);
    if (Object.keys(found).length > 0) return;
    const patch = patchOf(form, formOf(profile));
    if (Object.keys(patch).length === 0) {
      setErrors({ phone: 'Nothing has changed yet. Change a detail, then save.' });
      return;
    }
    await run(async () => {
      const r = await api.saveProfile(selfId, profile.version, patch);
      if (r.ok) {
        setSaved(changedLabels(patch));
        setConflict(undefined);
        await load();
        return;
      }
      if (r.status === 412) {
        setConflict(
          (Object.keys(LABEL) as (keyof Form)[])
            .filter((k) => form[k] !== formOf(profile)[k])
            .map((k) => ({ label: LABEL[k], value: form[k] })),
        );
        return;
      }
      if (r.status === 400 && r.fields.length > 0) {
        const mapped: Record<string, string> = {};
        for (const name of r.fields) {
          const id = FIELD_OF[name];
          if (id !== undefined)
            mapped[id] = `${LABEL[id]}: this was not accepted. Check it and try again.`;
        }
        if (Object.keys(mapped).length > 0) return setErrors(mapped);
      }
      setFailure(r);
      setRefused(failureText(r));
    });
  }

  const reload = async () => {
    setConflict(undefined);
    setErrors({});
    await load();
  };

  return (
    <section aria-labelledby="profile-h" className="ehr-card profile">
      <h1 id="profile-h" ref={heading} tabIndex={-1}>
        Your details
      </h1>
      <ErrorSummary errors={summaryOf(errors)} />
      {saved !== undefined && (
        <Banner tone="info" title="Your details were saved">
          Changed: {saved.join(', ')}. Changes to your details are recorded for your protection.
          They stay on screen until you leave this page.
        </Banner>
      )}
      {conflict !== undefined && <ConflictPanel mine={conflict} onReload={() => void reload()} />}
      {failure !== undefined && refused === undefined && (
        <Problem failure={failure} onRetry={() => setFailure(undefined)} />
      )}
      {refused !== undefined && <Banner tone="warning">{refused}</Banner>}

      <dl className="profile-fixed">
        <div className="profile-row">
          <dt>Name</dt>
          <dd>
            {profile.givenName} {profile.familyName}
          </dd>
        </div>
        <div className="profile-row">
          <dt>Date of birth</dt>
          <dd>{profile.dateOfBirth}</dd>
        </div>
      </dl>
      <p className="profile-note">
        To change your name or date of birth, please contact the clinic. They need to check it with
        you.
      </p>

      <form onSubmit={(e) => void submit(e)} noValidate aria-label="Your contact details">
        <TextField
          label={LABEL.phone}
          type="tel"
          autoComplete="tel"
          value={form.phone}
          onChange={set('phone')}
          error={errors['phone']}
          id="phone"
        />
        <TextField
          label={LABEL.email}
          type="email"
          autoComplete="email"
          value={form.email}
          onChange={set('email')}
          error={errors['email']}
          id="email"
        />
        <fieldset className="profile-set">
          <legend>Address</legend>
          <TextField
            label={LABEL.line1}
            autoComplete="address-line1"
            value={form.line1}
            onChange={set('line1')}
            error={errors['line1']}
            id="line1"
          />
          <TextField
            label={LABEL.line2}
            autoComplete="address-line2"
            value={form.line2}
            onChange={set('line2')}
            id="line2"
          />
          <TextField
            label={LABEL.city}
            autoComplete="address-level2"
            value={form.city}
            onChange={set('city')}
            id="city"
          />
          <TextField
            label={LABEL.stateCode}
            autoComplete="address-level1"
            maxLength={2}
            value={form.stateCode}
            onChange={set('stateCode')}
            error={errors['stateCode']}
            id="stateCode"
          />
          <TextField
            label={LABEL.postalCode}
            autoComplete="postal-code"
            value={form.postalCode}
            onChange={set('postalCode')}
            id="postalCode"
          />
        </fieldset>
        <SelectField
          label={LABEL.preferredLanguage}
          value={form.preferredLanguage}
          onChange={set('preferredLanguage')}
          id="preferredLanguage"
        >
          {form.preferredLanguage !== '' && LANGUAGES[form.preferredLanguage] === undefined && (
            <option value={form.preferredLanguage}>{form.preferredLanguage}</option>
          )}
          {Object.entries(LANGUAGES).map(([code, name]) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
        </SelectField>
        <TextField
          label={LABEL.pharmacyName}
          hint="The name of the pharmacy you use."
          value={form.pharmacyName}
          onChange={set('pharmacyName')}
          id="pharmacyName"
        />
        <p className="profile-actions">
          <Button type="submit" variant="primary" disabled={busy} aria-busy={busy}>
            Save my details
          </Button>{' '}
          <Button onClick={() => go('/profile/notifications')}>Notification preferences</Button>
        </p>
      </form>

      <EmergencyContact
        contact={profile.contacts.find((c) => c.kind === 'emergency')}
        onSaved={load}
      />
    </section>
  );
}

function EmergencyContact({
  contact,
  onSaved,
}: {
  contact: Contact | undefined;
  onSaved: () => Promise<void>;
}) {
  const { api, selfId } = useAccountCtx();
  const [f, setF] = useState({
    name: contact?.name ?? '',
    relationship: contact?.relationship ?? '',
    phone: contact?.phone ?? '',
    email: contact?.email ?? '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const key = useRef(newKey());
  const { busy, run } = useSubmit();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => {
    setF({ ...f, [k]: e.target.value });
    setDone(false);
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (selfId === undefined) return;
    const found: Record<string, string> = {};
    if (f.name.trim() === '') found['ec-name'] = 'Contact name: enter a name.';
    if (f.phone.trim() === '' && f.email.trim() === '')
      found['ec-phone'] = 'Contact phone or email: enter at least one way to reach them.';
    setErrors(found);
    setProblem(undefined);
    if (Object.keys(found).length > 0) return;
    const body: Record<string, unknown> = {
      kind: 'emergency',
      name: f.name.trim(),
      ...(f.relationship.trim() === '' ? {} : { relationship: f.relationship.trim() }),
      ...(f.phone.trim() === '' ? {} : { phone: f.phone.trim() }),
      ...(f.email.trim() === '' ? {} : { email: f.email.trim() }),
    };
    await run(async () => {
      const r =
        contact === undefined
          ? await api.addContact(selfId, body, key.current)
          : await api.saveContact(selfId, contact.id, contact.version, body);
      if (r.ok) {
        setDone(true);
        key.current = newKey();
        return onSaved();
      }
      setProblem(
        r.status === 412
          ? 'Someone changed this contact while you were editing. Reload the page to see the latest.'
          : r.status === 400
            ? 'The contact was not accepted. Check the name, phone number and email address.'
            : 'We could not save the contact. Your entries are still here. Try again.',
      );
    });
  }

  return (
    <form
      onSubmit={(e) => void submit(e)}
      noValidate
      aria-labelledby="ec-h"
      className="profile-set"
    >
      <h2 id="ec-h">Emergency contact</h2>
      <ErrorSummary errors={summaryOf(errors)} />
      {done && <Banner tone="info">Emergency contact saved.</Banner>}
      {problem !== undefined && <Banner tone="warning">{problem}</Banner>}
      <TextField
        id="ec-name"
        label="Contact name"
        autoComplete="off"
        value={f.name}
        onChange={set('name')}
        error={errors['ec-name']}
      />
      <TextField
        id="ec-rel"
        label="Relationship (optional)"
        autoComplete="off"
        value={f.relationship}
        onChange={set('relationship')}
      />
      <TextField
        id="ec-phone"
        label="Contact phone"
        type="tel"
        autoComplete="off"
        value={f.phone}
        onChange={set('phone')}
        error={errors['ec-phone']}
      />
      <TextField
        id="ec-email"
        label="Contact email (optional)"
        type="email"
        autoComplete="off"
        value={f.email}
        onChange={set('email')}
      />
      <p className="profile-actions">
        <Button type="submit" disabled={busy} aria-busy={busy}>
          {contact === undefined ? 'Add emergency contact' : 'Save emergency contact'}
        </Button>
      </p>
    </form>
  );
}
