import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiClient } from '../api/client.js';
import { MaintenanceBanners } from './MaintenanceBanners.js';

afterEach(cleanup);

const apiWith = (respond: () => Response) =>
  createApiClient({
    baseUrl: 'http://portal.test',
    clientRelease: 'r10.aaaaaaaaaaaa',
    fetch: async () => respond(),
  });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('MaintenanceBanners', () => {
  it('shows each current banner message', async () => {
    const api = apiWith(() =>
      json({
        items: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            message: 'Planned maintenance tonight',
            startsAt: '2026-01-01T00:00:00Z',
            endsAt: '2026-12-31T00:00:00Z',
          },
        ],
        nextCursor: null,
      }),
    );
    render(<MaintenanceBanners api={api} />);
    expect(await screen.findByText('Planned maintenance tonight')).toBeTruthy();
  });

  it('shows nothing when there are none or the read fails', async () => {
    const empty = render(
      <MaintenanceBanners api={apiWith(() => json({ items: [], nextCursor: null }))} />,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(empty.container.textContent).toBe('');
    cleanup();
    const failed = render(
      <MaintenanceBanners api={apiWith(() => json({ code: 'auth.unauthenticated' }, 401))} />,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(failed.container.textContent).toBe('');
  });
});
