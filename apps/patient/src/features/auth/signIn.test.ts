import { describe, expect, it } from 'vitest';
import { probeSignIn, signInUrl } from './signIn.js';
import { json, runtimeWith } from '../../app/test-helpers.js';

describe('probeSignIn', () => {
  it('calls only getAuthSignIn with the checked returnTo and does not follow the redirect', async () => {
    const { runtime, calls } = runtimeWith(
      () => new Response(null, { status: 302, headers: { location: 'https://idp.example/x' } }),
    );
    const result = await probeSignIn(runtime.api, '/account');
    expect(result).toEqual({ kind: 'redirect' });
    expect(calls).toEqual(['GET /api/v1/auth/sign-in?returnTo=%2Faccount']);
  });

  it.each([
    [400, 'kernel.validation_failed'],
    [409, 'patient.merged'],
    [429, 'kernel.rate_limited'],
    [503, 'kernel.unavailable'],
    [504, 'kernel.timeout'],
  ])('maps %i to its own state', async (status, code) => {
    const { runtime } = runtimeWith(() => json(status, { code, requestId: 'req-1' }));
    expect(await probeSignIn(runtime.api, '/account')).toEqual({
      kind: 'problem',
      problem: { code, requestId: 'req-1' },
    });
  });

  it('shows the unavailable state when the network fails', async () => {
    const { runtime } = runtimeWith(() => {
      throw new TypeError('network');
    });
    expect(await probeSignIn(runtime.api, '/account')).toEqual({
      kind: 'problem',
      problem: { code: 'kernel.unavailable' },
    });
  });

  it('encodes returnTo in the URL it navigates to', () => {
    expect(signInUrl('/a b?x=1')).toBe('/api/v1/auth/sign-in?returnTo=%2Fa%20b%3Fx%3D1');
  });
});
