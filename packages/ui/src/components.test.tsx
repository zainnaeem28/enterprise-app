// One axe test and one keyboard test for every exported component (FE-01 acceptance). The coverage test at the
// bottom fails when an export has no case, so a new component cannot ship untested.
// jsdom applies no layout, so colour-contrast is covered by tokens.test.ts (calculated) and target-size /
// contrast by the browser run where Chromium exists; here axe runs the structural WCAG 2.x A/AA rules.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as ui from './index.js';

afterEach(cleanup);

async function violations(container: HTMLElement) {
  const r = await axe.run(container, {
    runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  });
  return r.violations.map(
    (v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target).join(', ')}`,
  );
}

const FOCUSABLE =
  'a[href],button,input,select,textarea,summary,[tabindex],[contenteditable="true"]';

/** Generic keyboard contract: nothing sets a positive tabindex, every focusable control has an accessible name,
 * and every enabled tab stop can actually take focus. */
function genericKeyboard(container: HTMLElement) {
  const stops = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) =>
      !el.hasAttribute('disabled') &&
      el.getAttribute('tabindex') !== '-1' &&
      !el.closest('[hidden]'),
  );
  for (const el of stops) {
    expect(Number(el.getAttribute('tabindex') ?? 0)).toBeLessThanOrEqual(0);
    if (el.tagName === 'DIV' || el.tagName === 'TR' || el.getAttribute('role') === 'region')
      continue;
    const name = el.getAttribute('aria-label') ?? el.textContent ?? '';
    const labelled =
      (el.id !== '' && container.querySelector(`label[for="${el.id}"]`) !== null) ||
      el.closest('label') !== null;
    expect(name.trim() !== '' || labelled || el.getAttribute('aria-labelledby') !== null).toBe(
      true,
    );
    el.focus();
    expect(document.activeElement).toBe(el);
  }
  return stops;
}

const noop = () => {};
const patient = { name: 'Sample Patient', dob: '01/01/1980' };
const allergies = {
  state: 'recorded' as const,
  items: [
    { id: 'a1', name: 'Penicillin (hives)', severity: 'severe' as const },
    { id: 'a2', name: 'Sulfa', severity: 'mild' as const },
  ],
  moreCount: 2,
  uncodedCount: 1,
};
const slots = [
  { id: 's1', label: '9:00 AM', available: true },
  { id: 's2', label: '9:30 AM', available: true },
  { id: 's3', label: '10:00 AM', available: true },
];

interface Case {
  render: () => ReactElement;
  /** Component-specific keyboard behaviour, run after the generic contract. */
  keys?: (c: HTMLElement) => unknown;
}

const cases: Record<string, Case> = {
  Icon: { render: () => <ui.Icon name="calendar" /> },
  BrandMark: { render: () => <ui.BrandMark /> },
  Button: {
    render: () => <ui.Button onClick={noop}>Save</ui.Button>,
    keys: () =>
      expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute('type', 'button'),
  },
  StatusBar: { render: () => <ui.StatusBar tone="info">New version</ui.StatusBar> },
  AlertDialog: {
    render: () => (
      <ui.AlertDialog
        title="Title"
        actions={
          <>
            <ui.Button>One</ui.Button>
            <ui.Button>Two</ui.Button>
          </>
        }
      >
        <p>Body</p>
      </ui.AlertDialog>
    ),
    keys: () => {
      const [one, two] = screen.getAllByRole('button') as [HTMLElement, HTMLElement];
      expect(document.activeElement).toBe(one);
      two.focus();
      fireEvent.keyDown(two, { key: 'Tab' });
      expect(document.activeElement).toBe(one);
      fireEvent.keyDown(one, { key: 'Tab', shiftKey: true });
      expect(document.activeElement).toBe(two);
    },
  },
  BrandWordmark: { render: () => <ui.BrandWordmark name="Example Clinic" /> },
  SkipLink: { render: () => <ui.SkipLink targetId="main">Skip to content</ui.SkipLink> },
  Banner: {
    render: () => (
      <ui.Banner tone="warning" title="Heads up">
        Text
      </ui.Banner>
    ),
  },
  ErrorSummary: {
    render: () => (
      <>
        <ui.ErrorSummary errors={[{ fieldId: 'f1', message: 'Enter a date of birth' }]} />
        <ui.TextField id="f1" label="Date of birth" />
      </>
    ),
    keys: () => {
      cleanup();
      render(<ui.ErrorSummary errors={[{ fieldId: 'f1', message: 'Enter a date of birth' }]} />);
      expect(document.activeElement).toBe(screen.getByRole('alert'));
      cleanup();
      render(
        <>
          <ui.ErrorSummary errors={[{ fieldId: 'f1', message: 'Enter a date of birth' }]} />
          <ui.TextField id="f1" label="Date of birth" />
        </>,
      );
      fireEvent.click(screen.getByRole('link', { name: 'Enter a date of birth' }));
      expect(document.activeElement).toBe(screen.getByLabelText('Date of birth'));
    },
  },
  OtpInput: {
    render: () => <ui.OtpInput value="" onChange={noop} />,
    keys: () => {
      const input = screen.getByLabelText('Verification code');
      expect(input).toHaveAttribute('autocomplete', 'one-time-code');
    },
  },
  SelectField: {
    render: () => (
      <ui.SelectField label="Specialty" hint="Pick one" error="Choose a specialty">
        <option>Any</option>
      </ui.SelectField>
    ),
    keys: () => {
      const sel = screen.getByLabelText('Specialty');
      expect(sel).toHaveAttribute('aria-invalid', 'true');
      expect(sel.getAttribute('aria-describedby')).toMatch(/hint.*error/);
    },
  },
  Skeleton: { render: () => <ui.Skeleton /> },
  StatusChip: { render: () => <ui.StatusChip tone="success">Checked in</ui.StatusChip> },
  TextAreaField: { render: () => <ui.TextAreaField label="Note" error="Add a note" /> },
  TextField: {
    render: () => <ui.TextField label="Name" hint="As on your ID" error="Enter your name" />,
    keys: () =>
      expect(screen.getByLabelText('Name')).toHaveAccessibleDescription(
        /As on your ID.*Enter your name/,
      ),
  },
  ToastRegion: {
    render: () => <ui.ToastRegion toasts={[{ id: 't', message: 'Saved' }]} onDismiss={noop} />,
    keys: () => {
      const spy = vi.fn();
      cleanup();
      render(<ui.ToastRegion toasts={[{ id: 't', message: 'Saved' }]} onDismiss={spy} />);
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss message' }));
      expect(spy).toHaveBeenCalledWith('t');
    },
  },
  AppBar: {
    render: () => (
      <ui.AppBar
        portalName="Doctor portal"
        productName="[Product name]"
        realmBanner="Admin sign-in realm"
      />
    ),
    keys: () => expect(screen.getByText('Doctor portal')).toBeVisible(),
  },
  Stepper: {
    render: () => (
      <ui.Stepper
        steps={[
          { id: 'a', label: 'Service' },
          { id: 'b', label: 'Time' },
        ]}
        currentId="b"
      />
    ),
    keys: () =>
      expect(screen.getByText('Time').closest('li')).toHaveAttribute('aria-current', 'step'),
  },
  Tabs: {
    render: () => {
      const T = () => {
        const [sel, setSel] = useState('a');
        return (
          <ui.Tabs
            label="Chart"
            selected={sel}
            onSelect={setSel}
            items={[
              { id: 'a', label: 'Summary', panel: <p>One</p> },
              { id: 'b', label: 'Vitals', panel: <p>Two</p> },
            ]}
          />
        );
      };
      return <T />;
    },
    keys: () => {
      const a = screen.getByRole('tab', { name: 'Summary' });
      a.focus();
      fireEvent.keyDown(a, { key: 'ArrowRight' });
      const b = screen.getByRole('tab', { name: 'Vitals' });
      expect(b).toHaveAttribute('aria-selected', 'true');
      expect(document.activeElement).toBe(b);
      expect(a).toHaveAttribute('tabindex', '-1');
      fireEvent.keyDown(b, { key: 'Home' });
      expect(screen.getByRole('tab', { name: 'Summary' })).toHaveAttribute('aria-selected', 'true');
    },
  },
  EmptyState: {
    render: () => (
      <ui.EmptyState message="No appointments yet." action={<ui.Button>Book</ui.Button>} />
    ),
    keys: () => {
      cleanup();
      const clear = vi.fn();
      render(<ui.EmptyState message="x" filtered onClearFilters={clear} />);
      fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
      expect(clear).toHaveBeenCalled();
    },
  },
  ErrorState: {
    render: () => <ui.ErrorState kind="forbidden" homeHref="/" helpHref="/help" />,
    keys: () => {
      cleanup();
      const retry = vi.fn();
      render(<ui.ErrorState kind="server" requestId="req-123" onRetry={retry} />);
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      expect(retry).toHaveBeenCalled();
      expect(screen.getByText('req-123')).toBeInTheDocument();
    },
  },
  LoadingState: {
    render: () => <ui.LoadingState />,
    keys: () => expect(document.querySelector('[aria-busy="true"]')).not.toBeNull(),
  },
  MaintenanceBanner: {
    render: () => <ui.MaintenanceBanner>Tonight 22:00 ET</ui.MaintenanceBanner>,
  },
  OfflineBanner: { render: () => <ui.OfflineBanner /> },
  PartialFailureList: {
    render: () => (
      <ui.PartialFailureList
        items={[
          { id: '1', label: 'scan.pdf', ok: true },
          { id: '2', label: 'lab.pdf', ok: false, reason: 'Too large' },
        ]}
      />
    ),
  },
  PermissionNote: { render: () => <ui.PermissionNote scope="pre-visit items" /> },
  RefreshingContent: {
    render: () => (
      <ui.RefreshingContent refreshing>
        <p>Chart</p>
      </ui.RefreshingContent>
    ),
    keys: () => expect(screen.getByText('Chart')).toBeInTheDocument(),
  },
  SessionEndedDialog: {
    render: () => <ui.SessionEndedDialog onSignIn={noop} />,
    keys: () =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Sign in' })),
  },
  SessionWarningDialog: {
    render: () => <ui.SessionWarningDialog secondsLeft={120} onStay={noop} />,
    keys: () => {
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Stay signed in' }));
      expect(screen.getByText('You will be signed out in 2:00.')).toBeInTheDocument();
    },
  },
  StaleChip: { render: () => <ui.StaleChip ago="3 min ago" /> },
  AuditTable: {
    render: () => (
      <ui.AuditTable
        rows={[
          {
            id: '1',
            time: '10:42',
            who: 'Dr. Sample A',
            action: 'Viewed chart',
            record: 'Patient …a91',
            outcome: 'allowed',
          },
        ]}
        onOpen={noop}
      />
    ),
  },
  CardList: {
    render: () => (
      <ui.CardList
        label="Doctors"
        rows={[{ id: '1', n: 'Dr. A' }]}
        rowKey={(r) => r.id}
        title={(r) => r.n}
        action={() => <ui.Button>Book</ui.Button>}
      />
    ),
  },
  DataTable: {
    render: () => (
      <ui.DataTable
        caption="Arrivals"
        rows={[
          { id: '1', n: 'A' },
          { id: '2', n: 'B' },
        ]}
        rowKey={(r) => r.id}
        columns={[{ key: 'n', header: 'Name', render: (r) => r.n }]}
        onOpen={noop}
      />
    ),
    keys: () => {
      cleanup();
      const open = vi.fn();
      render(
        <ui.DataTable
          caption="Arrivals"
          rows={[
            { id: '1', n: 'A' },
            { id: '2', n: 'B' },
          ]}
          rowKey={(r) => r.id}
          columns={[{ key: 'n', header: 'Name', render: (r) => r.n }]}
          onOpen={open}
        />,
      );
      const rows = screen.getAllByRole('row').slice(1);
      rows[0]!.focus();
      fireEvent.keyDown(rows[0]!, { key: 'j' });
      expect(document.activeElement).toBe(rows[1]);
      fireEvent.keyDown(rows[1]!, { key: 'Enter' });
      expect(open).toHaveBeenCalledWith({ id: '2', n: 'B' });
    },
  },
  DocumentList: {
    render: () => (
      <ui.DocumentList
        documents={[{ id: '1', name: 'Referral.pdf', href: '/d/1', textAvailable: false }]}
      />
    ),
    keys: () => expect(screen.getByText(/Text is not available/)).toBeInTheDocument(),
  },
  FilterBar: {
    render: () => (
      <ui.FilterBar label="Filter doctors" onApply={noop} onClear={noop}>
        <ui.TextField label="Specialty" />
      </ui.FilterBar>
    ),
    keys: () => {
      cleanup();
      const apply = vi.fn();
      render(
        <ui.FilterBar label="Filter" onApply={apply}>
          <ui.TextField label="Specialty" />
        </ui.FilterBar>,
      );
      fireEvent.submit(screen.getByRole('search'));
      expect(apply).toHaveBeenCalled();
    },
  },
  MessageThread: {
    render: () => (
      <ui.MessageThread
        label="Messages"
        messages={[{ id: '1', from: 'Clinic', at: '10:00', body: 'Hello' }]}
      />
    ),
  },
  Timeline: {
    render: () => (
      <ui.Timeline
        label="Delivery"
        entries={[{ id: '1', time: '10:00', label: 'Out for delivery', current: true }]}
      />
    ),
  },
  UploadList: {
    render: () => (
      <ui.UploadList
        onPick={noop}
        onRemove={noop}
        items={[
          { id: '1', name: 'a.pdf', scan: 'scanning' },
          { id: '2', name: 'b.pdf', scan: 'blocked' },
        ]}
      />
    ),
  },
  CalendarWeek: {
    render: () => (
      <ui.CalendarWeek
        weekLabel="Week of Nov 9"
        onPrev={noop}
        onNext={noop}
        onSelect={noop}
        days={[
          { id: 'mon', heading: 'Mon 9', slots },
          { id: 'fri', heading: 'Fri 13', slots: [] },
        ]}
      />
    ),
  },
  ScheduleDay: {
    render: () => (
      <ui.ScheduleDay
        heading="Thu 12"
        onOpen={noop}
        events={[{ id: '1', start: '9:00 AM', end: '9:30 AM', title: 'Follow-up' }]}
      />
    ),
  },
  SlotGrid: {
    render: () => <ui.SlotGrid label="Wed 11" slots={slots} selectedId="s2" onSelect={noop} />,
    keys: () => {
      const first = screen.getByRole('button', { name: '9:00 AM' });
      first.focus();
      fireEvent.keyDown(first, { key: 'ArrowDown' });
      expect(document.activeElement).toBe(screen.getByRole('button', { name: /9:30 AM/ }));
      expect(screen.getByRole('button', { name: /9:30 AM/ })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    },
  },
  AlertBar: {
    render: () => <ui.AlertBar state="paused" onReload={noop} />,
    keys: () => {
      // No dismiss or close control on a safety bar.
      expect(screen.queryByRole('button', { name: /dismiss|close/i })).toBeNull();
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Live alerts are paused because this page is out of date. Reload now.',
      );
    },
  },
  AlertTray: {
    render: () => (
      <ui.AlertTray
        serverNow={() => 0}
        onAcknowledge={noop}
        alerts={[
          { id: '1', type: 'Red flag', where: 'Room 3', escalatesAtMs: 250_000, status: 'open' },
        ]}
      />
    ),
    keys: () => {
      expect(screen.getByText(/Escalates in 4:10/)).toBeInTheDocument();
      cleanup();
      const ack = vi.fn();
      render(
        <ui.AlertTray
          serverNow={() => 0}
          onAcknowledge={ack}
          alerts={[
            { id: '9', type: 'Red flag', where: 'Room 3', escalatesAtMs: null, status: 'open' },
          ]}
        />,
      );
      expect(screen.getByText(/Escalation time not set/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /Acknowledge/ }));
      expect(ack).toHaveBeenCalledWith('9');
    },
  },
  AllergyBlock: {
    render: () => <ui.AllergyBlock allergies={allergies} onOpenList={noop} />,
    keys: () => {
      expect(screen.getByText('1 uncoded: needs review')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /\+2 more/ })).toBeInTheDocument();
      cleanup();
      render(<ui.AllergyBlock allergies={{ state: 'none_recorded', items: [] }} />);
      expect(screen.getByText('No allergies recorded')).toBeInTheDocument();
      expect(screen.queryByText(/No known allergies/)).toBeNull();
      cleanup();
      render(<ui.AllergyBlock allergies={null} />);
      expect(
        screen.getByText('Allergies not available with your current access'),
      ).toBeInTheDocument();
    },
  },
  BreakTheGlassDialog: {
    render: () => <ui.BreakTheGlassDialog onConfirm={noop} onCancel={noop} />,
    keys: () => {
      cleanup();
      const ok = vi.fn();
      render(<ui.BreakTheGlassDialog onConfirm={ok} onCancel={noop} />);
      const go = screen.getByRole('button', { name: 'Open chart with emergency access' });
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'short' } });
      fireEvent.click(go);
      expect(ok).not.toHaveBeenCalled();
      expect(screen.getByText('Enter at least 10 characters.')).toBeInTheDocument();
      fireEvent.change(screen.getByRole('textbox'), {
        target: { value: 'Covering colleague, urgent referral' },
      });
      fireEvent.click(go);
      expect(ok).toHaveBeenCalledWith('Covering colleague, urgent referral');
    },
  },
  BtgReviewPanel: {
    render: () => (
      <ui.BtgReviewPanel
        who="Dr. Sample B"
        opened="10:41 ET"
        patient="Patient …c04"
        reason="Covering"
        onDecide={noop}
      />
    ),
  },
  ConfirmRiskDialog: {
    render: () => (
      <ui.ConfirmRiskDialog
        title="Cancel appointment"
        consequence="A fee applies."
        confirmLabel="Cancel appointment (a fee applies)"
        patient={patient}
        onConfirm={noop}
        onCancel={noop}
      />
    ),
    keys: () => {
      // Safe default: Cancel has focus, the risky button names its consequence, no OK/Yes/No.
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
      expect(
        screen.getByRole('button', { name: 'Cancel appointment (a fee applies)' }),
      ).toBeInTheDocument();
      expect(screen.getByText(/Sample Patient/)).toBeInTheDocument();
      expect(screen.getByText(/01\/01\/1980/)).toBeInTheDocument();
    },
  },
  EmergencyAccessBanner: { render: () => <ui.EmergencyAccessBanner /> },
  PasskeyPrompt: { render: () => <ui.PasskeyPrompt onCancel={noop} /> },
  PatientBanner: {
    render: () => (
      <ui.PatientBanner
        name="Patient A. Sample"
        dob="01/01/1980"
        age="45 y"
        mrn="SYN-000123"
        sex="Female"
        allergies={allergies}
      />
    ),
    keys: () => {
      const toggle = screen.getByRole('button', { name: 'Show details' });
      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByText(/Patient A. Sample/)).toBeInTheDocument();
    },
  },
  RangeText: {
    render: () => (
      <ui.RangeText status="out_of_range" value="152/96" unit="mmHg" low={90} high={140} />
    ),
    keys: () => {
      expect(screen.getByText('Out of range')).toBeInTheDocument();
      expect(screen.getByText(/Range 90-140 mmHg/)).toBeInTheDocument();
      cleanup();
      const { container } = render(<ui.RangeText status="no_range" value="88" unit="bpm" />);
      expect(container).toHaveTextContent('No reference range set');
      expect(container).not.toHaveTextContent('Out of range');
      cleanup();
      const r2 = render(
        <ui.RangeText status="out_of_range" value="93" unit="%" low={95} high={null} />,
      );
      expect(r2.container).toHaveTextContent('Range at least 95 %');
      cleanup();
      const r3 = render(<ui.RangeText status="unit_mismatch" value="5" unit="kg" />);
      expect(r3.container).toHaveTextContent('range not applied');
      cleanup();
      const r4 = render(<ui.RangeText status="entered_in_error" value="5" unit="kg" />);
      expect(r4.container).toHaveTextContent('Entered in error');
    },
  },
  ReauthDialog: { render: () => <ui.ReauthDialog onReauth={noop} onCancel={noop} /> },
  SecurityKeyPrompt: { render: () => <ui.SecurityKeyPrompt onCancel={noop} /> },
  SignNoteDialog: {
    render: () => <ui.SignNoteDialog patient={patient} onConfirm={noop} onCancel={noop} />,
    keys: () => expect(screen.getAllByText('Sign and lock note').length).toBeGreaterThan(1),
  },
  SoapEditor: {
    render: () => (
      <ui.SoapEditor
        value={{ s: 'Chest tightness', o: '', a: '', p: '' }}
        onChange={noop}
        onSaveDraft={noop}
        onSign={noop}
        draftSavedAt="09:41:12"
      />
    ),
    keys: () => {
      expect(screen.getByRole('button', { name: 'Sign and lock note' })).toBeInTheDocument();
      cleanup();
      render(
        <ui.SoapEditor
          value={{ s: '', o: '', a: '', p: '' }}
          onChange={noop}
          onSaveDraft={noop}
          onSign={noop}
          signed
          onAddAddendum={noop}
        />,
      );
      expect(screen.getByRole('button', { name: 'Add addendum' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Sign and lock note' })).toBeNull();
    },
  },
};
import { useState } from 'react';

const NOT_COMPONENTS = new Set([
  'pickCopy',
  'uiStrings',
  'useBusy',
  'escalationText',
  'resolveBrandName',
]);

describe.each(Object.entries(cases))('%s', (name, c) => {
  it('has no axe violations (structural WCAG 2.2 A/AA rules)', async () => {
    const { container } = render(c.render());
    expect(await violations(container)).toEqual([]);
  });
  it('is keyboard operable', async () => {
    // Specific behaviour first, on a fresh mount (initial focus), then the generic contract on another.
    const first = render(c.render());
    await c.keys?.(first.container);
    cleanup();
    const { container } = render(c.render());
    genericKeyboard(container);
    expect(name).toBeTruthy();
  });
});

describe('coverage', () => {
  it('every exported component has an axe and keyboard case', () => {
    const exported = Object.keys(ui).filter((k) => !NOT_COMPONENTS.has(k));
    expect(exported.filter((k) => !(k in cases))).toEqual([]);
    expect(Object.keys(cases).filter((k) => !exported.includes(k))).toEqual([]);
  });
});
