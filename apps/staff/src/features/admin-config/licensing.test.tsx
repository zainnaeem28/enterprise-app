// CONTRACT MOCK of organisation.yaml (GET|PUT /admin/staff-profiles/{principalId}, GET /admin/operating-states) and the principal list.
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { ID, json, page, portal, problem } from './testkit.js';
import type { Seen } from './testkit.js';

afterEach(cleanup);
const click = async (name: string | RegExp) => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
};
const PRINCIPAL = ID(61);

const routes =
  (extra: (x: Seen) => Response | undefined = () => undefined) =>
  (x: Seen) => {
    const e = extra(x);
    if (e !== undefined) return e;
    if (x.path.endsWith('/admin/operating-states'))
      return page([
        {
          jurisdictionCode: 'NY',
          effectiveFrom: '2020-01-01',
          telehealthAllowed: true,
          rowVersion: 1,
        },
        {
          jurisdictionCode: 'NJ',
          effectiveFrom: '2020-01-01',
          telehealthAllowed: false,
          rowVersion: 1,
        },
        {
          jurisdictionCode: 'CT',
          effectiveFrom: '2999-01-01',
          telehealthAllowed: true,
          rowVersion: 1,
        },
      ]);
    if (x.path.endsWith('/admin/principals'))
      return page([{ principalId: PRINCIPAL, displayName: 'Dr Sam Lee', realm: 'staff' }]);
    if (x.path.endsWith(`/admin/staff-profiles/${PRINCIPAL}`) && x.method === 'GET')
      return json(200, {
        principalId: PRINCIPAL,
        displayName: 'Dr Sam Lee',
        licensedStates: ['NY'],
      });
    return problem(404, 'kernel.not_found');
  };

async function openClinician(handler = routes()) {
  const p = portal('/admin/licensing', handler);
  render(p.ui);
  fireEvent.change(await screen.findByLabelText('Find a clinician'), { target: { value: 'sam' } });
  await click('Search');
  await click(/Choose Dr Sam Lee/);
  await screen.findByRole('heading', { name: 'Dr Sam Lee' });
  return p;
}

describe('Clinician licensed states editor (ruling C item 4)', () => {
  it('shows the clinic’s operating states that have started, as text, and is reachable from the portal path', async () => {
    const { ui } = portal('/admin/licensing', routes());
    render(ui);
    expect(
      await screen.findByRole('heading', { name: 'Clinician licensed states' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('Telehealth allowed')).toBeInTheDocument();
    expect(screen.getByText('Telehealth not allowed')).toBeInTheDocument();
    expect(screen.queryByText('CT')).toBeNull();
  });

  it('adds and removes states and sends exactly the resulting set with one PUT', async () => {
    const { seen } = await openClinician(
      routes((x) =>
        x.method === 'PUT'
          ? json(200, { principalId: PRINCIPAL, displayName: 'x', licensedStates: ['NJ', 'NY'] })
          : undefined,
      ),
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Add a state'), { target: { value: 'nj' } });
    await click('Add state');
    expect(screen.getByRole('button', { name: 'Remove NJ' })).toBeInTheDocument();
    await click('Save');
    expect(await screen.findByText(/applies to the next booking/)).toBeInTheDocument();
    const puts = seen.filter((x) => x.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0]?.path).toBe(`/api/v1/admin/staff-profiles/${PRINCIPAL}`);
    expect(puts[0]?.body).toEqual({ licensedStates: ['NJ', 'NY'] });
  });

  it('refuses a state that is not two capital letters before anything is sent', async () => {
    const { seen } = await openClinician();
    fireEvent.change(screen.getByLabelText('Add a state'), { target: { value: 'N1' } });
    await click('Add state');
    expect(screen.getByText('Use two capital letters.')).toBeInTheDocument();
    expect(seen.filter((x) => x.method === 'PUT')).toHaveLength(0);
  });

  it('says plainly when the person has no clinician profile', async () => {
    const p = portal('/admin/licensing', (x) =>
      x.path.includes('/staff-profiles/') ? problem(404, 'kernel.not_found') : routes()(x),
    );
    render(p.ui);
    fireEvent.change(await screen.findByLabelText('Find a clinician'), {
      target: { value: 'sam' },
    });
    await click('Search');
    await click(/Choose Dr Sam Lee/);
    expect(await screen.findByText(/no clinician profile/)).toBeInTheDocument();
  });

  it('has no serious accessibility violations', async () => {
    await openClinician();
    const r = await axe.run(document.body, {
      runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'],
    });
    expect(r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual(
      [],
    );
  });
});
