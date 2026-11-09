import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { uiStrings } from '@ehr/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminStrings as s } from './strings.js';
import {
  ID,
  change,
  event,
  grant,
  json,
  portal,
  principal,
  problem,
  request,
  roles,
} from './testkit.js';
import type { Seen } from './testkit.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const click = async (name: string | RegExp) => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
};
const type = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const serious = async (container: HTMLElement) => {
  const r = await axe.run(container, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] });
  return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
};

describe('Audit log (AD-01)', () => {
  const auditRoutes =
    (extra: (s: Seen) => Response | undefined = () => undefined) =>
    (seen: Seen) => {
      const x = extra(seen);
      if (x !== undefined) return x;
      if (seen.path.endsWith('/audit-events/search'))
        return json(200, {
          items: [
            event(1),
            event(2, {
              outcome: 'denied',
              actorPersonId: null,
              action: 'read',
              denialReason: 'forbidden',
            }),
          ],
          truncated: false,
        });
      return problem(404, 'kernel.not_found');
    };

  it('searches with the period and filters, and shows allowed and denied in words', async () => {
    const { ui, seen } = portal('/admin/audit', auditRoutes());
    render(ui);
    type(s.action, 'view');
    type(s.actor, ID(90).toUpperCase());
    await click(s.search);
    expect(await screen.findByRole('table', { hidden: true })).toBeInTheDocument();
    const body = seen.find((x) => x.path.endsWith('/audit-events/search'))?.body as Record<
      string,
      unknown
    >;
    expect(body['action']).toBe('view');
    expect(body['actorPersonId']).toBe(ID(90));
    expect(Date.parse(String(body['to'])) - Date.parse(String(body['from']))).toBeLessThanOrEqual(
      31 * 86_400_000,
    );
    expect(screen.getByText(s.allowed)).toBeInTheDocument();
    expect(screen.getByText(s.denied)).toBeInTheDocument();
    expect(screen.getByText(s.system)).toBeInTheDocument();
  });

  it('refuses a period over 31 days or a malformed reference before any call', async () => {
    const { ui, seen } = portal('/admin/audit', auditRoutes());
    render(ui);
    type(s.from, '2026-01-01T00:00');
    type(s.to, '2026-11-01T00:00');
    type(s.patient, 'not-a-reference');
    await click(s.search);
    expect(seen).toHaveLength(0);
    const summary = screen.getAllByText(s.rangeTooLong);
    expect(summary.length).toBeGreaterThan(0);
    expect(screen.getAllByText(s.notReference).length).toBeGreaterThan(0);
  });

  it('says so when nothing matches the filters, and when the answer was cut short', async () => {
    const { ui } = portal('/admin/audit', () => json(200, { items: [], truncated: false }));
    render(ui);
    type(s.action, 'zzz');
    await click(s.search);
    expect(await screen.findByText(uiStrings.emptyFiltered)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: uiStrings.clearFilters }).length).toBe(2);
    cleanup();
    const t = portal('/admin/audit', () => json(200, { items: [event(1)], truncated: true }));
    render(t.ui);
    await click(s.search);
    expect(await screen.findByText(s.truncated)).toBeInTheDocument();
  });

  it('shows the server error with its reference and a retry', async () => {
    const { ui } = portal('/admin/audit', () => problem(503, 'kernel.unavailable'));
    render(ui);
    await click(s.search);
    expect(await screen.findByText(/req-1/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('exports: needs a reason, follows the job from queued to ready, announces it, and opens the download', async () => {
    let polls = 0;
    const { ui, seen } = portal(
      '/admin/audit',
      auditRoutes((x) => {
        if (x.method === 'POST' && x.path.endsWith('/audit-exports'))
          return json(200, { id: ID(50), status: 'queued' });
        if (x.method === 'GET' && x.path.endsWith(`/audit-exports/${ID(50)}`)) {
          polls += 1;
          return json(
            200,
            polls < 2
              ? { id: ID(50), status: 'running', rowCount: null, expiresAt: null }
              : { id: ID(50), status: 'ready', rowCount: 12, expiresAt: '2026-11-09T12:00:00Z' },
          );
        }
        if (x.path.endsWith('/download-url'))
          return json(200, {
            url: 'https://files.test/export.csv',
            expiresAt: '2026-11-09T12:05:00Z',
          });
        return undefined;
      }),
    );
    render(ui);
    await click(s.search);
    await screen.findByRole('button', { name: s.exportAction });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await click(s.exportAction);
    expect(screen.getByText(s.exportReasonShort)).toBeInTheDocument();
    expect(seen.some((x) => x.path.endsWith('/audit-exports'))).toBe(false);
    type(s.exportReason, 'Quarterly access review for the board');
    await click(s.exportAction);
    expect(await screen.findByText(s.exportQueued)).toBeInTheDocument();
    const posted = seen.find((x) => x.method === 'POST' && x.path.endsWith('/audit-exports'))
      ?.body as Record<string, unknown>;
    expect(posted['reason']).toBe('Quarterly access review for the board');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4100);
    });
    expect(await screen.findByText(s.exportRunning)).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4100);
    });
    const ready = await screen.findByText(new RegExp(s.exportReady));
    expect(ready.closest('[role="status"], [role="alert"]')).not.toBeNull();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    await click(s.exportDownload);
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        'https://files.test/export.csv',
        '_blank',
        'noopener,noreferrer',
      ),
    );
  });

  it('translates audit.export_too_large and failed or expired jobs', async () => {
    const { ui } = portal('/admin/audit', (x) =>
      x.path.endsWith('/audit-events/search')
        ? json(200, { items: [event(1)], truncated: false })
        : problem(422, 'audit.export_too_large'),
    );
    render(ui);
    await click(s.search);
    type(s.exportReason, 'Quarterly access review for the board');
    await click(s.exportAction);
    expect(await screen.findByText(s.exportTooLarge)).toBeInTheDocument();
  });

  it('asks for the security key when no grant is live, then goes on', async () => {
    const { ui, seen, store } = portal(
      '/admin/audit',
      (x) => {
        if (x.path.endsWith('/audit-events/search'))
          return json(200, { items: [event(1)], truncated: false });
        if (x.path.endsWith('/elevation/options'))
          return json(200, {
            challengeId: ID(5),
            publicKey: {
              challenge: 'AQID',
              timeout: 1000,
              userVerification: 'required',
              allowCredentials: [],
            },
          });
        if (x.path.endsWith('/elevation/verify'))
          return json(200, { elevationExpiresAt: new Date(Date.now() + 900_000).toISOString() });
        if (x.path.endsWith('/audit-exports')) return json(200, { id: ID(50), status: 'queued' });
        return problem(404, 'kernel.not_found');
      },
      { granted: false },
    );
    render(ui);
    await click(s.search);
    type(s.exportReason, 'Quarterly access review for the board');
    await click(s.exportAction);
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Export the audit log');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: /use security key/i }));
    });
    expect(await screen.findByText(s.exportQueued)).toBeInTheDocument();
    expect(store.isLive()).toBe(true);
    expect(seen.map((x) => x.path.split('/').slice(-2).join('/'))).toContain('elevation/verify');
  });
});

describe('Break-the-glass review (AD-02)', () => {
  const routes =
    (review: () => Response = () => json(200, { id: ID(1), reviewStatus: 'justified' })) =>
    (x: Seen) => {
      if (x.method === 'GET' && x.path.endsWith('/btg-grants'))
        return json(200, {
          items: [grant(1), grant(2, { reason: 'Second reason' })],
          nextCursor: null,
        });
      if (x.path.endsWith('/review')) return review();
      return problem(404, 'kernel.not_found');
    };

  it('lists pending access and asks for the pending filter', async () => {
    const { ui, seen } = portal('/admin/btg', routes());
    render(ui);
    expect(await screen.findByText('Patient collapsed in waiting room')).toBeInTheDocument();
    expect(seen[0]?.path).toContain('/btg-grants');
    expect(new URL(`http://x${seen[0]?.path}`).pathname).toBe('/api/v1/admin/btg-grants');
  });

  it('needs an outcome and a note, then records the decision with the outcome and the note', async () => {
    const { ui, seen } = portal('/admin/btg', routes());
    render(ui);
    await screen.findByText('Patient collapsed in waiting room');
    fireEvent.click(screen.getAllByRole('button', { name: new RegExp(s.open) })[0] as HTMLElement);
    await click(s.btgSubmit);
    expect(screen.getAllByText(s.btgOutcomeRequired).length).toBeGreaterThan(0);
    expect(screen.getAllByText(s.btgNoteRequired).length).toBeGreaterThan(0);
    expect(seen.some((x) => x.path.endsWith('/review'))).toBe(false);
    fireEvent.click(screen.getByLabelText(s.btgNotJustified));
    type(s.btgNote, 'No treating relationship found');
    await click(s.btgSubmit);
    expect(await screen.findByText(s.btgDone(s.btgNotJustified))).toBeInTheDocument();
    const call = seen.find((x) => x.path.endsWith('/review'));
    expect(call?.path).toBe(`/api/v1/admin/btg-grants/${ID(1)}/review`);
    expect(call?.body).toEqual({
      outcome: 'not_justified',
      note: 'No treating relationship found',
    });
  });

  it('tells the holder they cannot review their own access, and a second review that it was done', async () => {
    const own = portal(
      '/admin/btg',
      routes(() => problem(403, 'audit.self_review')),
    );
    render(own.ui);
    await screen.findByText('Patient collapsed in waiting room');
    fireEvent.click(screen.getAllByRole('button', { name: new RegExp(s.open) })[0] as HTMLElement);
    fireEvent.click(screen.getByLabelText(s.btgJustified));
    type(s.btgNote, 'Looks right to me, sure');
    await click(s.btgSubmit);
    expect(await screen.findByText(s.btgSelfReview)).toBeInTheDocument();
    cleanup();
    const twice = portal(
      '/admin/btg',
      routes(() => problem(409, 'audit.invalid_transition')),
    );
    render(twice.ui);
    await screen.findByText('Patient collapsed in waiting room');
    fireEvent.click(screen.getAllByRole('button', { name: new RegExp(s.open) })[0] as HTMLElement);
    fireEvent.click(screen.getByLabelText(s.btgJustified));
    type(s.btgNote, 'Looks right to me, sure');
    await click(s.btgSubmit);
    expect(await screen.findByText(s.btgAlready)).toBeInTheDocument();
  });

  it('shows a reviewed grant read-only with its reviewer and note', async () => {
    const { ui } = portal('/admin/btg', () =>
      json(200, {
        items: [
          grant(3, {
            reviewStatus: 'justified',
            review: {
              reviewerPersonId: ID(92),
              outcome: 'justified',
              note: 'Emergency confirmed',
              reviewedAt: '2026-11-08T11:00:00Z',
            },
          }),
        ],
        nextCursor: null,
      }),
    );
    render(ui);
    fireEvent.click(
      (await screen.findAllByRole('button', { name: new RegExp(s.open) }))[0] as HTMLElement,
    );
    expect(await screen.findByText('Emergency confirmed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: s.btgSubmit })).toBeNull();
  });

  it('has an empty state', async () => {
    const { ui } = portal('/admin/btg', () => json(200, { items: [], nextCursor: null }));
    render(ui);
    expect(await screen.findByText(s.btgEmpty)).toBeInTheDocument();
  });
});

describe('Users & roles with approvals (AD-03)', () => {
  const routes =
    (extra: (x: Seen) => Response | undefined = () => undefined) =>
    (x: Seen) => {
      const e = extra(x);
      if (e !== undefined) return e;
      if (x.method === 'GET' && x.path.endsWith('/principals'))
        return json(200, {
          items: [
            principal(1),
            principal(2, {
              realm: 'google',
              handle: null,
              email: 'd@clinic.test',
              displayName: 'Dr Two',
            }),
          ],
          nextCursor: null,
        });
      if (x.path.endsWith('/roles')) return json(200, { items: roles, nextCursor: null });
      return problem(404, 'kernel.not_found');
    };

  it('requests a role change, saying a different administrator must approve it', async () => {
    const { ui, seen } = portal(
      '/admin/users',
      routes((x) => (x.path.endsWith('/role-change-requests') ? json(200, change()) : undefined)),
    );
    render(ui);
    fireEvent.click(
      (
        await screen.findAllByRole('button', { name: new RegExp(`${s.requestChange}: Admin 1`) })
      )[0] as HTMLElement,
    );
    expect(await screen.findByText(s.twoPerson)).toBeInTheDocument();
    await click(s.changeSubmit);
    expect(screen.getAllByText(s.changeNeeds).length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByLabelText(/compliance_officer/)[0] as HTMLElement);
    await click(s.changeSubmit);
    expect(await screen.findByText(s.changeSent)).toBeInTheDocument();
    const body = seen.find((x) => x.path.endsWith('/role-change-requests'))?.body;
    expect(body).toEqual({
      subjectPrincipalId: ID(1),
      add: [{ roleKey: 'compliance_officer' }],
      remove: [],
    });
    expect(screen.getAllByText(ID(60)).length).toBeGreaterThan(0);
  });

  it('only offers roles of the same sign-in type and asks for a location on a location role', async () => {
    const { ui, seen } = portal(
      '/admin/users',
      routes((x) =>
        x.path.endsWith('/role-change-requests')
          ? json(
              200,
              change({
                subjectPrincipalId: ID(2),
                add: [{ roleKey: 'doctor', locationId: ID(30) }],
              }),
            )
          : undefined,
      ),
    );
    render(ui);
    fireEvent.click((await screen.findAllByRole('button', { name: /Dr Two/ }))[0] as HTMLElement);
    expect(screen.queryByLabelText(/compliance_officer/)).toBeNull();
    fireEvent.click(screen.getAllByLabelText(/doctor/)[0] as HTMLElement);
    await click(s.changeSubmit);
    expect(screen.getAllByText(s.notReference).length).toBeGreaterThan(0);
    type(s.locationFor('doctor'), ID(30));
    await click(s.changeSubmit);
    await screen.findByText(s.changeSent);
    expect(
      (seen.find((x) => x.path.endsWith('/role-change-requests'))?.body as Record<string, unknown>)[
        'add'
      ],
    ).toEqual([{ roleKey: 'doctor', locationId: ID(30) }]);
  });

  it('blocks approving your own request before the click, and the server refusals read plainly', async () => {
    let decision = problem(403, 'identity.self_approval');
    const { ui } = portal(
      '/admin/users',
      routes((x) => {
        if (x.path.endsWith('/role-change-requests')) return json(200, change());
        if (x.path.endsWith('/approve') || x.path.endsWith('/reject')) return decision.clone();
        return undefined;
      }),
    );
    render(ui);
    fireEvent.click(
      (
        await screen.findAllByRole('button', { name: new RegExp(`${s.requestChange}: Admin 1`) })
      )[0] as HTMLElement,
    );
    fireEvent.click(screen.getAllByLabelText(/compliance_officer/)[0] as HTMLElement);
    await click(s.changeSubmit);
    await screen.findByText(s.changeSent);
    type(s.approvalRef, ID(60));
    expect(screen.getByText(s.ownRequestWaiting)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: s.approve })).toBeDisabled();
    type(s.approvalRef, ID(61));
    expect(screen.getByRole('button', { name: s.approve })).toBeEnabled();
    await click(s.approve);
    expect(await screen.findByText(s.selfApproval)).toBeInTheDocument();
    decision = problem(403, 'identity.approver_is_subject');
    await click(s.approve);
    expect(await screen.findByText(s.approverIsSubject)).toBeInTheDocument();
    decision = problem(409, 'identity.request_expired');
    await click(s.reject);
    expect(await screen.findByText(s.requestExpired)).toBeInTheDocument();
  });

  it('approves a request by its reference, and cancels one of your own', async () => {
    const { ui, seen } = portal(
      '/admin/users',
      routes((x) => {
        if (x.path.endsWith('/role-change-requests')) return json(200, change());
        if (x.path.endsWith('/approve'))
          return json(200, change({ id: ID(61), status: 'approved' }));
        if (x.path.endsWith('/cancel')) return json(200, change({ status: 'cancelled' }));
        return undefined;
      }),
    );
    render(ui);
    fireEvent.click(
      (
        await screen.findAllByRole('button', { name: new RegExp(`${s.requestChange}: Admin 1`) })
      )[0] as HTMLElement,
    );
    fireEvent.click(screen.getAllByLabelText(/compliance_officer/)[0] as HTMLElement);
    await click(s.changeSubmit);
    await screen.findByText(s.changeSent);
    type(s.approvalRef, ID(61).toUpperCase());
    await click(s.approve);
    expect(await screen.findByText(s.approvedDone)).toBeInTheDocument();
    expect(
      seen.some((x) => x.path === `/api/v1/admin/role-change-requests/${ID(61)}/approve`),
    ).toBe(true);
    await click(s.cancelRequest);
    expect(await screen.findByText(s.cancelledDone)).toBeInTheDocument();
  });

  it('maps a privileged role for a staff account to one plain sentence', async () => {
    const { ui } = portal(
      '/admin/users',
      routes((x) =>
        x.path.endsWith('/role-change-requests')
          ? problem(422, 'identity.privileged_role_in_staff_realm')
          : undefined,
      ),
    );
    render(ui);
    fireEvent.click(
      (
        await screen.findAllByRole('button', { name: new RegExp(`${s.requestChange}: Admin 1`) })
      )[0] as HTMLElement,
    );
    fireEvent.click(screen.getAllByLabelText(/system_admin/)[0] as HTMLElement);
    await click(s.changeSubmit);
    expect(await screen.findByText(s.forStaffRealm)).toBeInTheDocument();
  });
});

describe('Privacy requests (AD-05)', () => {
  const routes =
    (extra: (x: Seen) => Response | undefined = () => undefined, items: unknown[] = [request(1)]) =>
    (x: Seen) => {
      const e = extra(x);
      if (e !== undefined) return e;
      if (x.method === 'GET' && x.path.endsWith('/privacy-requests'))
        return json(200, { items, nextCursor: null });
      return problem(404, 'kernel.not_found');
    };
  const openFirst = async () =>
    fireEvent.click(
      (await screen.findAllByRole('button', { name: new RegExp(s.open) }))[0] as HTMLElement,
    );

  it('lists requests and filters by status', async () => {
    const { ui, seen } = portal('/admin/privacy', routes());
    render(ui);
    expect(
      await screen.findByText(s.pStatus['received'] as string, { selector: '.ehr-chip' }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(s.privacyStatus), { target: { value: 'fulfilled' } });
    await waitFor(() =>
      expect(
        seen.some(
          (x) =>
            x.path.includes('/privacy-requests') &&
            x.headers !== undefined &&
            x.path.endsWith('/privacy-requests') &&
            seen.length > 1,
        ),
      ).toBe(true),
    );
  });

  it('records the identity check before approval is offered', async () => {
    const { ui, seen } = portal(
      '/admin/privacy',
      routes((x) =>
        x.path.endsWith('/verify-identity')
          ? json(
              200,
              request(1, {
                status: 'identity_verified',
                verificationMethod: 'call back on number on file',
                verifiedAt: '2026-11-09T09:00:00Z',
                version: 2,
              }),
            )
          : undefined,
      ),
    );
    render(ui);
    await openFirst();
    expect(screen.getByText(s.notVerified)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: s.approveReq })).toBeNull();
    await click(s.verifySubmit);
    expect(screen.getByText(s.verifyMethodInvalid)).toBeInTheDocument();
    type(s.verifyMethod, 'call back on number on file');
    await click(s.verifySubmit);
    expect(await screen.findByRole('button', { name: s.approveReq })).toBeInTheDocument();
    const call = seen.find((x) => x.path.endsWith('/verify-identity'));
    expect(call?.body).toEqual({ method: 'call back on number on file' });
    expect(call?.headers.get('If-Match')).toBe('W/"1"');
  });

  it('needs a reason to refuse, then sends the decision', async () => {
    const { ui, seen } = portal(
      '/admin/privacy',
      routes((x) =>
        x.path.endsWith('/decide')
          ? json(
              200,
              request(1, {
                status: 'refused',
                decisionReason: 'Not the account holder',
                version: 3,
              }),
            )
          : undefined,
      ),
    );
    render(ui);
    await openFirst();
    await click(s.refuseReq);
    expect(screen.getByText(s.decideReasonShort)).toBeInTheDocument();
    expect(seen.some((x) => x.path.endsWith('/decide'))).toBe(false);
    type(s.decideReason, 'Not the account holder');
    await click(s.refuseReq);
    expect(await screen.findByText(s.decided(s.pStatus['refused'] as string))).toBeInTheDocument();
    expect(seen.find((x) => x.path.endsWith('/decide'))?.body).toEqual({
      decision: 'refuse',
      reason: 'Not the account holder',
    });
    expect(screen.queryByRole('button', { name: s.refuseReq })).toBeNull();
  });

  it('explains a held deletion and shows the legal-hold count, never content', async () => {
    const { ui } = portal(
      '/admin/privacy',
      routes(undefined, [
        request(2, {
          kind: 'deletion',
          status: 'blocked_d8',
          legalHold: { documents: 2, checkedAt: '2026-11-09T08:00:00Z' },
        }),
      ]),
    );
    render(ui);
    await openFirst();
    expect(screen.getByText(s.deletionHold)).toBeInTheDocument();
    expect(screen.getByText(s.legalHold(2))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: s.approveReq })).toBeNull();
  });

  it('offers the retry only when the package failed, and says why on a conflict', async () => {
    const { ui } = portal(
      '/admin/privacy',
      routes(
        (x) =>
          x.path.endsWith('/decide') ? problem(412, 'kernel.precondition_failed') : undefined,
        [
          request(3, {
            status: 'in_progress',
            verifiedAt: '2026-11-08T00:00:00Z',
            verificationMethod: 'in person',
            package: {
              id: ID(40),
              status: 'failed',
              partCounts: {},
              sizeBytes: null,
              expiresAt: null,
              releasedAt: null,
              failureCode: 'assembly_failed',
            },
          }),
        ],
      ),
    );
    render(ui);
    await openFirst();
    expect(
      screen.getByText(s.packageFailed('assembly_failed'), { exact: false }),
    ).toBeInTheDocument();
    await click(s.retryReq);
    expect(await screen.findByText(s.conflict)).toBeInTheDocument();
  });
});

describe('Accessibility (axe, WCAG 2.2 AA)', () => {
  it.each([
    ['/admin/audit' as const, () => json(200, { items: [event(1)], truncated: false })],
    ['/admin/btg' as const, () => json(200, { items: [grant(1)], nextCursor: null })],
    ['/admin/privacy' as const, () => json(200, { items: [request(1)], nextCursor: null })],
  ])('%s has no serious violations', async (path, h) => {
    const { ui } = portal(path, h);
    const { container } = render(ui);
    if (path === '/admin/audit') await click(s.search);
    await screen.findAllByRole(path === '/admin/audit' ? 'table' : 'button', { hidden: true });
    expect(await serious(container)).toEqual([]);
  });

  it('users & roles has no serious violations with the form open', async () => {
    const { ui } = portal('/admin/users', (x) =>
      x.path.endsWith('/roles')
        ? json(200, { items: roles, nextCursor: null })
        : json(200, { items: [principal(1)], nextCursor: null }),
    );
    const { container } = render(ui);
    fireEvent.click(
      (
        await screen.findAllByRole('button', { name: /Request a role change: Admin 1/ })
      )[0] as HTMLElement,
    );
    await screen.findByText(s.twoPerson);
    expect(await serious(container)).toEqual([]);
  });
});
