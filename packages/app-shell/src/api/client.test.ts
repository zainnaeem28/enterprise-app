import { describe, expect, it, vi } from 'vitest';
import { alertStreamUrl, createApiClient } from './client.js';

const RELEASE = 'r142.3f9a1c2b7d10';
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('createApiClient', () => {
  it('sends X-Client-Release on a relative same-origin URL', async () => {
    const fetch = vi.fn(async (request: Request) => json(200, { url: request.url }));
    const api = createApiClient({ clientRelease: RELEASE, baseUrl: 'http://portal.test', fetch });
    await api.GET('/api/v1/me', { params: { header: api.header } });
    const req = fetch.mock.calls[0]![0];
    expect(req.headers.get('X-Client-Release')).toBe(RELEASE);
    expect(new URL(req.url).pathname).toBe('/api/v1/me');
    expect(req.credentials).toBe('same-origin');
  });

  it('notifies on 400 kernel.client_release_unsupported with the requestId', async () => {
    const onReleaseRefused = vi.fn();
    const fetch = async () =>
      json(400, { code: 'kernel.client_release_unsupported', requestId: 'r-1' });
    const api = createApiClient({
      clientRelease: RELEASE,
      baseUrl: 'http://portal.test',
      fetch,
      onReleaseRefused,
    });
    const { response } = await api.GET('/api/v1/me', { params: { header: api.header } });
    expect(response.status).toBe(400);
    expect(onReleaseRefused).toHaveBeenCalledWith({ requestId: 'r-1' });
  });

  it('does not notify for other 400s or non-JSON bodies', async () => {
    const onReleaseRefused = vi.fn();
    let n = 0;
    const fetch = async () =>
      n++ === 0
        ? json(400, { code: 'kernel.validation_failed' })
        : new Response('nope', { status: 400 });
    const api = createApiClient({
      clientRelease: RELEASE,
      baseUrl: 'http://portal.test',
      fetch,
      onReleaseRefused,
    });
    await api.GET('/api/v1/me', { params: { header: api.header } });
    await api.GET('/api/v1/me', { params: { header: api.header } });
    expect(onReleaseRefused).not.toHaveBeenCalled();
  });

  it('rejects a malformed release at construction', () => {
    expect(() => createApiClient({ clientRelease: 'v1' })).toThrow(/Malformed/);
    expect(() => createApiClient({ clientRelease: 'r0.3f9a1c2b7d10' })).toThrow(/Malformed/);
  });

  it('puts the release in the alert stream query string', () => {
    expect(alertStreamUrl(RELEASE)).toBe(`/api/v1/alerts/stream?clientRelease=${RELEASE}`);
  });
});
