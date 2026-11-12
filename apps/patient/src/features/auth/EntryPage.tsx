import { Button, Icon } from '@ehr/ui';

export type Intent = 'sign-in' | 'create';

/** Entry: both buttons lead to the same secure sign-in; no password, code or passkey field lives on our pages. */
export function EntryPage({ onContinue }: { onContinue: (intent: Intent) => void }) {
  return (
    <section className="patient-entry ehr-card" aria-labelledby="entry-h">
      <span className="ehr-feature-icon">
        <Icon name="heart" size={28} />
      </span>
      <p className="ehr-eyebrow">Welcome to your patient portal</p>
      <h1 id="entry-h">
        Your next step to
        <br />
        feeling better.
      </h1>
      <p className="patient-entry__lead">
        Sign in to see your visits and messages, or create an account.
      </p>
      <p>
        <Button variant="primary" onClick={() => onContinue('sign-in')}>
          Sign in
        </Button>{' '}
        <Button onClick={() => onContinue('create')}>Create account</Button>
      </p>
      <div className="patient-entry__features">
        <span>
          <Icon name="calendar" /> Manage your visits
        </span>
        <span>
          <Icon name="notes" /> Prepare for appointments
        </span>
        <span>
          <Icon name="people" /> Update your details
        </span>
      </div>
    </section>
  );
}
