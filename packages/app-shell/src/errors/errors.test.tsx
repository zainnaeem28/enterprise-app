import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary, ForbiddenPage, NotFoundPage } from './ErrorPages.js';
import { problemView } from './problem.js';

afterEach(cleanup);
const res = (status: number, headers: Record<string, string> = {}) =>
  new Response(null, { status, headers });

describe('problemView', () => {
  it('maps statuses to the UI-UX 6 states', () => {
    expect(problemView(res(403), {})?.kind).toBe('forbidden');
    expect(problemView(res(404), {})?.kind).toBe('not-found');
    expect(problemView(res(412), {})?.kind).toBe('conflict');
    expect(problemView(res(503), { requestId: 'r-7' })).toEqual({
      kind: 'server',
      requestId: 'r-7',
    });
    expect(problemView(res(429, { 'Retry-After': '12' }), {})).toEqual({
      kind: 'rate-limited',
      retryAfterSeconds: 12,
    });
  });
  it('leaves 200, 400 and 401 to other handlers', () => {
    for (const s of [200, 400, 401]) expect(problemView(res(s), {})).toBeUndefined();
  });
  it('403 and 404 never echo server detail', () => {
    expect(JSON.stringify(problemView(res(404), { detail: 'patient 123 exists' }))).not.toContain(
      '123',
    );
  });
});

describe('pages', () => {
  it('404 and 403 are plain pages with an h1 and a way home', () => {
    render(<NotFoundPage homeHref="/home" />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      "We can't find this, or it isn't available to you.",
    );
    cleanup();
    render(<ForbiddenPage homeHref="/home" helpHref="/help" />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      "You don't have access to this.",
    );
    expect(screen.getByRole('link', { name: /home/i })).toHaveAttribute('href', '/home');
  });

  it('ErrorBoundary replaces a crash with "Your work is safe" and Retry, then recovers', () => {
    const onError = vi.fn();
    let boom = true;
    function Bad() {
      if (boom) throw new Error('secret detail');
      return <p>fine</p>;
    }
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary onError={onError}>
        <Bad />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/Your work is safe/);
    expect(document.body).not.toHaveTextContent('secret detail');
    expect(onError).toHaveBeenCalledOnce();
    boom = false;
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(screen.getByText('fine')).toBeInTheDocument();
  });
});
