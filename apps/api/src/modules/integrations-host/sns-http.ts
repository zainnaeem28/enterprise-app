// The two outbound GETs of the SNS receipt route, both to the pinned `sns.<region>.amazonaws.com` host (the caller has already pinned the
// URL; these refuse anything else again). No redirect is followed, the answer is size-bounded and the call has a deadline.
import { isPinnedSnsUrl } from './sns-verify.js';

const TIMEOUT_MS = 5_000;
const MAX_CERT_BYTES = 16_384;

type Fetch = (url: string, init: { redirect: 'error'; signal: AbortSignal }) => Promise<Response>;

export function httpsFetchCertificate(
  region: string,
  f: Fetch = fetch,
): (url: string) => Promise<string> {
  return async (url) => {
    if (isPinnedSnsUrl(url, region) === undefined) throw new Error('certificate URL not pinned');
    const r = await f(url, { redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!r.ok) throw new Error(`certificate fetch failed: ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_CERT_BYTES) throw new Error('certificate too large');
    return buf.toString('utf8');
  };
}

export function httpsConfirmSubscription(
  region: string,
  f: Fetch = fetch,
): (url: string) => Promise<number> {
  return async (url) => {
    if (isPinnedSnsUrl(url, region) === undefined) throw new Error('subscribe URL not pinned');
    const r = await f(url, { redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
    await r.arrayBuffer().catch(() => undefined);
    return r.status;
  };
}
