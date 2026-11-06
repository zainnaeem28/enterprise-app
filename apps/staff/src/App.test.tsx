import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App.js';
import { createRuntime } from './runtime.js';
import { createApiClient, ReleaseStore } from '@ehr/app-shell';

afterEach(cleanup);

function runtimeWith(respond: (r: Request) => Response) {
  const clientRelease = 'r5.bbbbbbbbbbbb';
  const releases = new ReleaseStore({ clientRelease, fetchManifest: async () => ({}) });
  const api = createApiClient({
    clientRelease,
    baseUrl: 'http://portal.test',
    fetch: async (r) => respond(r),
    onReleaseRefused: ({ requestId }) => releases.refuse(requestId),
  });
  return { clientRelease, releases, api } as ReturnType<typeof createRuntime>;
}

describe('staff shell', () => {
  it('marks the identity as placeholder and has a skip link and main landmark', async () => {
    render(<App runtime={runtimeWith(() => new Response('{}', { status: 401 }))} />);
    expect(screen.getByText('Placeholder identity')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveAttribute(
      'href',
      '#main',
    );
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(await screen.findByText(/You are not signed in/)).toBeInTheDocument();
  });

  it('opens the blocking dialog when the page call is refused for its release', async () => {
    const res = () =>
      new Response(JSON.stringify({ code: 'kernel.client_release_unsupported', requestId: 'q1' }), {
        status: 400,
        headers: { 'content-type': 'application/problem+json' },
      });
    render(<App runtime={runtimeWith(res)} />);
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('out of date');
  });
});
