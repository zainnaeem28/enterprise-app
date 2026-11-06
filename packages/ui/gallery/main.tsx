// Design-system gallery: every shared component in the states of UI-UX 6 and 8, with synthetic data only.
// Used by the Playwright run (full axe incl. contrast and target size, plus candidate screenshots). Not shipped.
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles.css';
import * as ui from '../src/index.js';

const params = new URLSearchParams(location.search);
const portal = params.get('portal') ?? 'doctor';
document.documentElement.dataset.portal = portal;
const dialog = params.get('dialog');
const noop = () => {};

const allergies: ui.AllergyData = {
  state: 'recorded',
  items: [
    { id: '1', name: 'Penicillin (hives)', severity: 'severe' },
    { id: '2', name: 'Sulfa', severity: 'moderate' },
  ],
  moreCount: 0,
  uncodedCount: 2,
};

const slots = ['9:00 AM', '9:30 AM', '10:30 AM', '1:00 PM'].map((label, i) => ({
  id: `s${i}`,
  label,
  available: true,
}));

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="ehr-card" style={{ marginBottom: 16 }} aria-label={title}>
      <h2 style={{ marginTop: 0, fontSize: 18 }}>{title}</h2>
      {children}
    </section>
  );
}

function Dialogs() {
  switch (dialog) {
    case 'confirm':
      return (
        <ui.ConfirmRiskDialog
          title="Cancel appointment"
          consequence="A fee applies if you cancel less than 24 hours before the visit."
          confirmLabel="Cancel appointment (a fee applies)"
          patient={{ name: 'Patient A. Sample', dob: '01/01/1980' }}
          onConfirm={noop}
          onCancel={noop}
        />
      );
    case 'sign':
      return (
        <ui.SignNoteDialog
          patient={{ name: 'Patient A. Sample', dob: '01/01/1980' }}
          onConfirm={noop}
          onCancel={noop}
        />
      );
    case 'btg':
      return <ui.BreakTheGlassDialog onConfirm={noop} onCancel={noop} />;
    case 'session-warning':
      return <ui.SessionWarningDialog secondsLeft={120} onStay={noop} />;
    case 'session-ended':
      return <ui.SessionEndedDialog onSignIn={noop} />;
    case 'passkey':
      return <ui.PasskeyPrompt onCancel={noop} />;
    case 'reauth':
      return <ui.ReauthDialog onReauth={noop} onCancel={noop} />;
    default:
      return null;
  }
}

function Gallery() {
  const [tab, setTab] = useState('summary');
  const [slot, setSlot] = useState('s2');
  const [note, setNote] = useState({
    s: 'Chest tightness since this morning, no radiation.',
    o: '',
    a: '',
    p: '',
  });
  return (
    <>
      <ui.SkipLink targetId="main">Skip to content</ui.SkipLink>
      <ui.AppBar
        portalName={`${portal} portal`}
        productName="[Product name]"
        realmBanner={
          portal === 'admin'
            ? 'Admin sign-in realm. Clinical data is not available here.'
            : undefined
        }
        user={<span>Sample User</span>}
        help={
          <a href="#help" style={{ color: 'inherit' }}>
            Help
          </a>
        }
      />
      <ui.StatusBar tone="info">
        A new version is available. Finish or save what you are doing, then reload.
      </ui.StatusBar>
      <ui.AlertBar state="raised" />
      <ui.PatientBanner
        name="Patient A. Sample"
        dob="01/01/1980"
        age="45 y"
        sex="Female"
        mrn="SYN-000123"
        allergies={allergies}
        onOpenAllergies={noop}
      />
      <main id="main" className="ehr-main">
        <h1 style={{ fontSize: 30, margin: '0 0 16px' }}>Design system gallery</h1>
        <Section title="Buttons and chips">
          <p>
            <ui.Button variant="primary">Save and queue for doctor</ui.Button>{' '}
            <ui.Button>Cancel</ui.Button> <ui.Button disabled>Disabled</ui.Button>{' '}
            <ui.PlaceholderMark />
          </p>
          <p>
            <ui.StatusChip tone="neutral">Confirmed</ui.StatusChip>{' '}
            <ui.StatusChip tone="info">In triage</ui.StatusChip>{' '}
            <ui.StatusChip tone="success">Checked in</ui.StatusChip>{' '}
            <ui.StatusChip tone="warning">Forms missing</ui.StatusChip>{' '}
            <ui.StatusChip tone="danger">Missing consent</ui.StatusChip>{' '}
            <ui.StaleChip ago="3 min ago" />
          </p>
        </Section>
        <Section title="Banners and states">
          <ui.Banner tone="info">Your changes are saved.</ui.Banner>
          <ui.Banner tone="warning" title="Maintenance">
            Tonight 22:00 ET. Sign-in stays available.
          </ui.Banner>
          <ui.OfflineBanner />
          <ui.PermissionNote scope="pre-visit items" />
          <ui.PartialFailureList
            items={[
              { id: '1', label: 'scan.pdf', ok: true },
              { id: '2', label: 'lab.pdf', ok: false, reason: 'File too large' },
            ]}
          />
        </Section>
        <Section title="Loading, empty, error">
          <ui.LoadingState />
          <ui.EmptyState
            message="No appointments yet."
            action={<ui.Button variant="primary">Book your first visit</ui.Button>}
          />
          <ui.ErrorState kind="forbidden" homeHref="#home" helpHref="#help" />
          <ui.ErrorState kind="not-found" homeHref="#home" />
          <ui.ErrorState kind="server" requestId="req-0a1b2c" onRetry={noop} />
          <ui.ErrorState kind="rate-limited" retryAfterSeconds={30} onRetry={noop} />
          <ui.ErrorState
            kind="conflict"
            onReload={noop}
            userText="Chest tightness since this morning."
          />
        </Section>
        <Section title="Form field set">
          <ui.ErrorSummary errors={[{ fieldId: 'dob', message: 'Enter a date of birth' }]} />
          <ui.TextField
            id="dob"
            label="Date of birth"
            hint="For example 01/01/1980"
            error="Enter a date of birth"
            autoComplete="bday"
          />
          <ui.TextField label="Full name" autoComplete="name" />
          <ui.SelectField label="Language">
            <option>English</option>
          </ui.SelectField>
          <ui.OtpInput value="" onChange={noop} hint="Six digits from your authenticator" />
          <ui.TextAreaField label="Triage note" />
        </Section>
        <Section title="Tabs and stepper">
          <ui.Stepper
            steps={[
              { id: 'a', label: 'Service' },
              { id: 'b', label: 'Doctor & place' },
              { id: 'c', label: 'Date & time' },
              { id: 'd', label: 'Confirm' },
            ]}
            currentId="c"
          />
          <ui.Tabs
            label="Chart"
            selected={tab}
            onSelect={setTab}
            items={[
              {
                id: 'summary',
                label: 'Summary',
                panel: <p>Problems, medications, vitals trend.</p>,
              },
              { id: 'vitals', label: 'Vitals', panel: <p>Vitals table.</p> },
            ]}
          />
        </Section>
        <Section title="Scheduling">
          <ui.SlotGrid label="Wed 11" slots={slots} selectedId={slot} onSelect={setSlot} />
          <ui.CalendarWeek
            weekLabel="Week of Nov 9"
            onPrev={noop}
            onNext={noop}
            selectedId={slot}
            onSelect={setSlot}
            days={[
              { id: 'mon', heading: 'Mon 9', slots },
              { id: 'tue', heading: 'Tue 10', slots: slots.slice(0, 2) },
              { id: 'fri', heading: 'Fri 13', slots: [] },
            ]}
          />
          <ui.ScheduleDay
            heading="Thu 12"
            onOpen={noop}
            events={[{ id: '1', start: '9:00 AM', end: '9:30 AM', title: 'Follow-up' }]}
          />
        </Section>
        <Section title="Tables and lists">
          <ui.DataTable
            caption="Arrivals today"
            selectedKey="2"
            onOpen={noop}
            rows={[
              {
                id: '1',
                t: '9:00',
                n: 'Patient B. Sample',
                s: <ui.StatusChip tone="warning">Waiting</ui.StatusChip>,
              },
              {
                id: '2',
                t: '9:20',
                n: 'Patient C. Sample',
                s: <ui.StatusChip tone="info">In triage</ui.StatusChip>,
              },
            ]}
            rowKey={(r) => r.id}
            columns={[
              { key: 't', header: 'Time', render: (r) => r.t },
              { key: 'n', header: 'Patient', render: (r) => r.n },
              { key: 's', header: 'Status', render: (r) => r.s },
            ]}
          />
          <ui.CardList
            label="Doctors"
            rows={[{ id: '1', n: 'Dr. Sample Doctor A' }]}
            rowKey={(r) => r.id}
            title={(r) => r.n}
            meta={() => 'Family medicine'}
            action={() => <ui.Button variant="primary">Book this doctor</ui.Button>}
          />
          <ui.AuditTable
            rows={[
              {
                id: '1',
                time: '10:42:08',
                who: 'Dr. Sample Doctor A',
                action: 'Viewed chart',
                record: 'Patient …a91',
                outcome: 'allowed',
              },
              {
                id: '2',
                time: '10:41:55',
                who: 'Dr. Sample Doctor B',
                action: 'Opened (BTG)',
                record: 'Patient …c04',
                outcome: 'reason-given',
              },
            ]}
          />
          <ui.Timeline
            label="Delivery"
            entries={[
              { id: '1', time: '09:10', label: 'Accepted', tone: 'success' },
              { id: '2', time: '11:30', label: 'Out for delivery', tone: 'info', current: true },
            ]}
          />
          <ui.MessageThread
            label="Messages"
            messages={[
              {
                id: '1',
                from: 'Clinic',
                at: '10:00',
                body: 'Your results are ready. Sign in to view them.',
              },
            ]}
          />
          <ui.DocumentList
            documents={[
              {
                id: '1',
                name: 'Referral.pdf',
                meta: 'Added Nov 3',
                href: '#d',
                textAvailable: false,
              },
            ]}
          />
          <ui.UploadList
            onPick={noop}
            items={[
              { id: '1', name: 'insurance.pdf', scan: 'clean' },
              { id: '2', name: 'photo.jpg', scan: 'scanning' },
              { id: '3', name: 'bad.exe', scan: 'blocked' },
            ]}
          />
        </Section>
        <Section title="Safety-critical">
          <ui.AllergyBlock allergies={allergies} onOpenList={noop} />
          <p>
            <ui.AllergyBlock allergies={{ state: 'none_recorded', items: [] }} />
          </p>
          <p>
            <ui.AllergyBlock allergies={null} />
          </p>
          <ui.AlertBar state="paused" onReload={noop} />
          <ui.AlertBar state="disconnected" onCheck={noop} />
          <ui.AlertTray
            serverNow={() => 0}
            onAcknowledge={noop}
            alerts={[
              {
                id: '1',
                type: 'Red flag',
                where: 'Room 3',
                patient: 'Patient C. Sample, DOB 01/01/1980',
                escalatesAtMs: 250000,
                status: 'open',
              },
              {
                id: '2',
                type: 'Red flag',
                where: 'Room 5',
                escalatesAtMs: null,
                status: 'escalated',
                escalationLevel: 1,
              },
            ]}
          />
          <p>
            <ui.RangeText status="out_of_range" value="152/96" unit="mmHg" low={90} high={140} />
          </p>
          <p>
            <ui.RangeText status="in_range" value="72" unit="bpm" low={60} high={100} />
          </p>
          <p>
            <ui.RangeText status="no_range" value="88" unit="bpm" />
          </p>
          <p>
            <ui.RangeText status="unit_mismatch" value="5" unit="kg" />
          </p>
          <p>
            <ui.RangeText status="entered_in_error" value="5" unit="kg" />
          </p>
          <ui.EmergencyAccessBanner />
          <ui.BtgReviewPanel
            who="Dr. Sample Doctor B"
            opened="Today 10:41 AM ET"
            patient="Patient …c04 (not assigned)"
            reason="Covering colleague, urgent referral"
            onDecide={noop}
          />
        </Section>
        <Section title="Visit note">
          <ui.SoapEditor
            value={note}
            onChange={setNote}
            onSaveDraft={noop}
            onSign={noop}
            draftSavedAt="09:41:12"
          />
        </Section>
      </main>
      <Dialogs />
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Gallery />
  </StrictMode>,
);
