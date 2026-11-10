import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SIGN_IN_FAILED_MESSAGE, SignInView } from './SignIn';

describe('SignInView', () => {
  it('shows an accessible generic alert when sign-in failed', () => {
    const html = renderToStaticMarkup(<SignInView failed />);
    expect(html).toContain('role="alert"');
    expect(html).toContain(SIGN_IN_FAILED_MESSAGE);
    expect(html).toContain('href="/api/users/oauth/google/start"');
  });
  it('shows no alert on a normal visit', () => {
    const html = renderToStaticMarkup(<SignInView failed={false} />);
    expect(html).not.toContain('role="alert"');
  });
  it('does not reveal why the denial happened', () => {
    expect(SIGN_IN_FAILED_MESSAGE).not.toMatch(/allow-?list|domain|expired|token/i);
  });
});
