// axe-core on the rendered shell in jsdom. Fallback for environments with no browser: jsdom applies no
// stylesheet or layout, so colour-contrast and target-size rules cannot run here. The Playwright spec in
// e2e/ runs the full rule set on the built bundle where Chromium is available (CI, DEVOPS-PLAN 5.1).
import { act, cleanup, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiClient, ReleaseStore } from '@ehr/app-shell';
import { App } from './App.js';
import type { Runtime } from './runtime.js';

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

function runtime(status: number, body: unknown): Runtime {
  const clientRelease = 'r5.bbbbbbbbbbbb';
  const releases = new ReleaseStore({
    clientRelease,
    fetchManifest: async () => ({ release_number: 9 }),
  });
  const api = createApiClient({
    clientRelease,
    baseUrl: 'http://portal.test',
    fetch: async () => new Response(JSON.stringify(body), { status }),
    onReleaseRefused: ({ requestId }) => releases.refuse(requestId),
  });
  return { clientRelease, releases, api };
}

describe('axe smoke on the shell (jsdom)', () => {
  it('shell with the non-blocking release bar', async () => {
    const rt = runtime(401, { code: 'auth.unauthenticated' });
    const { container } = render(<App runtime={rt} />);
    await screen.findByText(/You are not signed in/);
    await act(() => rt.releases.poll());
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(await violations(container)).toEqual([]);
  });

  it('shell with the blocking release dialog', async () => {
    const rt = runtime(400, { code: 'kernel.client_release_unsupported', requestId: 'q1' });
    const { container } = render(<App runtime={rt} />);
    await screen.findByRole('alertdialog');
    expect(await violations(container)).toEqual([]);
  });
});
