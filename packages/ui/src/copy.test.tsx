// Review round 1 (FE01-FR-R1-01, -03, -04, -05): allergy block never collapses away, wording comes only from
// `copy`, ids are unique, and an overdue escalation says so.
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import * as ui from './index.js';

afterEach(cleanup);

const allergies = {
  state: 'recorded' as const,
  items: [{ id: 'a1', name: 'Penicillin', severity: 'severe' as const }],
  moreCount: 2,
  uncodedCount: 1,
};

describe('PatientBanner', () => {
  it('keeps the allergy block outside the collapsible region', () => {
    const { container } = render(
      <ui.PatientBanner
        name="Test Person"
        dob="1990-01-01"
        age="35"
        mrn="X1"
        allergies={allergies}
      />,
    );
    const more = container.querySelector('.ehr-patient-banner__more');
    const block = container.querySelector('[data-allergy-state]');
    expect(more).not.toBeNull();
    expect(block).not.toBeNull();
    expect(more?.contains(block)).toBe(false);
  });
  it('keeps the not-shown chip outside the collapsible region too', () => {
    const { container } = render(
      <ui.PatientBanner name="Test Person" dob="1990-01-01" age="35" mrn="X1" allergies={null} />,
    );
    const more = container.querySelector('.ehr-patient-banner__more');
    expect(more?.querySelector('[data-allergy-state]')).toBeNull();
    expect(container.querySelector('[data-allergy-state="not-shown"]')).not.toBeNull();
  });
  it('gives two banners distinct ids and matching aria-controls', () => {
    const { container } = render(
      <>
        <ui.PatientBanner name="A B" dob="1" age="1" mrn="1" allergies={null} />
        <ui.PatientBanner name="C D" dob="1" age="1" mrn="2" allergies={null} />
      </>,
    );
    const toggles = [...container.querySelectorAll('.ehr-patient-banner__toggle')];
    const ids = toggles.map((t) => t.getAttribute('aria-controls'));
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(container.querySelectorAll(`[id="${id}"]`)).toHaveLength(1);
  });
});

describe('escalationText', () => {
  it('shows an overdue state once the deadline has passed', () => {
    const row = { id: '1', type: 'T', where: 'W', escalatesAtMs: 1000, status: 'open' as const };
    expect(ui.escalationText(row, 500)).toBe('Escalates in 0:01');
    expect(ui.escalationText(row, 1000)).toBe(ui.uiStrings.escalationOverdue);
    expect(ui.escalationText(row, 5000)).toBe(ui.uiStrings.escalationOverdue);
  });
});

/** Every string replaced by a sentinel; functions return the sentinel too. */
const copy = Object.fromEntries(
  Object.entries(ui.uiStrings).map(([k, v], i) => [
    k,
    typeof v === 'function' ? () => `ZZ${i}x` : `ZZ${i}x`,
  ]),
);
const keyIndex = (k: string) => Object.keys(ui.uiStrings).indexOf(k);
const defaults = Object.values(ui.uiStrings).filter((v) => typeof v === 'string') as string[];

const safety: Record<string, () => ReactElement> = {
  AllergyBlock: () => <ui.AllergyBlock allergies={allergies} onOpenList={() => {}} copy={copy} />,
  AllergyNone: () => (
    <ui.AllergyBlock allergies={{ state: 'none_recorded', items: [] }} copy={copy} />
  ),
  AllergyHidden: () => <ui.AllergyBlock allergies={null} copy={copy} />,
  PatientBanner: () => (
    <ui.PatientBanner name="Zed" dob="1990" age="35" mrn="9" allergies={allergies} copy={copy} />
  ),
  AlertBar: () => <ui.AlertBar state="paused" onReload={() => {}} copy={copy} />,
  AlertBarOff: () => <ui.AlertBar state="disconnected" onCheck={() => {}} copy={copy} />,
  AlertTray: () => (
    <>
      <ui.AlertTray alerts={[]} serverNow={() => 0} onAcknowledge={() => {}} copy={copy} />
      <ui.AlertTray
        alerts={[
          { id: '1', type: 'Qq', where: 'Ww', escalatesAtMs: 5000, status: 'open' },
          {
            id: '2',
            type: 'Qq',
            where: 'Ww',
            escalatesAtMs: null,
            status: 'acknowledged',
            acknowledgedBy: 'Dr',
            acknowledgedAt: '10:00',
          },
        ]}
        serverNow={() => 0}
        onAcknowledge={() => {}}
        copy={copy}
      />
    </>
  ),
  SignNoteDialog: () => (
    <ui.SignNoteDialog
      patient={{ name: 'Zed', dob: '1990' }}
      onConfirm={() => {}}
      onCancel={() => {}}
      copy={copy}
    />
  ),
  ReauthDialog: () => <ui.ReauthDialog onReauth={() => {}} onCancel={() => {}} copy={copy} />,
  SecurityKeyPrompt: () => <ui.SecurityKeyPrompt onCancel={() => {}} copy={copy} />,
  BreakTheGlassDialog: () => (
    <ui.BreakTheGlassDialog onConfirm={() => {}} onCancel={() => {}} copy={copy} />
  ),
  BtgReviewPanel: () => (
    <ui.BtgReviewPanel
      who="Qq"
      opened="Ww"
      patient="Ee"
      reason="Rr"
      onDecide={() => {}}
      copy={copy}
    />
  ),
  SoapEditor: () => (
    <ui.SoapEditor
      value={{ s: '', o: '', a: '', p: '' }}
      onChange={() => {}}
      onSaveDraft={() => {}}
      onSign={() => {}}
      copy={copy}
    />
  ),
  SoapSigned: () => (
    <ui.SoapEditor
      value={{ s: '', o: '', a: '', p: '' }}
      onChange={() => {}}
      onSaveDraft={() => {}}
      onSign={() => {}}
      signed
      onAddAddendum={() => {}}
      copy={copy}
    />
  ),
  SessionWarningDialog: () => (
    <ui.SessionWarningDialog secondsLeft={60} onStay={() => {}} onSignOut={() => {}} copy={copy} />
  ),
  DataTable: () => (
    <ui.DataTable caption="Cc" columns={[]} rows={[]} rowKey={() => ''} copy={copy} />
  ),
  CardList: () => (
    <ui.CardList label="Cc" rows={[]} rowKey={() => ''} title={() => null} copy={copy} />
  ),
  AuditTable: () => <ui.AuditTable rows={[]} copy={copy} />,
  DocumentList: () => <ui.DocumentList documents={[]} copy={copy} />,
  ErrorSummary: () => <ui.ErrorSummary errors={[{ fieldId: 'f', message: 'Mm' }]} copy={copy} />,
  OtpInput: () => <ui.OtpInput value="" onChange={() => {}} copy={copy} />,
};

describe('copy hooks: no default wording remains when copy is replaced', () => {
  it.each(Object.entries(safety))('%s', (_name, make) => {
    const { container } = render(make());
    // Open the BTG panel error path and the dialog error path so conditional wording is checked too.
    for (const b of container.querySelectorAll('button')) {
      if (
        [`ZZ${keyIndex('btgSubmit')}x`, `ZZ${keyIndex('btgContinue')}x`].includes(
          b.textContent ?? '',
        )
      )
        fireEvent.click(b);
    }
    const body = container.ownerDocument.body;
    const html = [
      body.textContent ?? '',
      ...[...body.querySelectorAll('[aria-label],[title]')].map(
        (e) => `${e.getAttribute('aria-label')} ${e.getAttribute('title')}`,
      ),
    ].join(' ');
    const left = defaults.filter((d) => d.length > 2 && html.includes(d));
    expect(left).toEqual([]);
    expect(html).toMatch(/ZZ\d+x/);
  });
  it('banner toggle wording comes from copy', () => {
    const { container } = render(safety.PatientBanner!());
    const t = container.querySelector('.ehr-patient-banner__toggle');
    expect(t?.textContent).toBe(`ZZ${keyIndex('showDetails')}x`);
    fireEvent.click(t!);
    expect(t?.textContent).toBe(`ZZ${keyIndex('hideDetails')}x`);
  });
});
