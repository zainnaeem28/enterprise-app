// X-Client-Release: r<releaseNumber>.<sha12> (ARCHITECTURE 28.6, DEVOPS-PLAN 6.2).
export const CLIENT_RELEASE_HEADER = 'X-Client-Release';
export const RELEASE_REFUSED_CODE = 'kernel.client_release_unsupported';

const RE = /^r([1-9][0-9]{0,9})\.[0-9a-f]{12}$/;

/** `r142.3f9a1c2b7d10` -> 142, or undefined when malformed (the API would refuse it). */
export function parseClientRelease(value: string): number | undefined {
  const m = RE.exec(value);
  if (m === null) return undefined;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : undefined;
}

export function assertClientRelease(value: string): string {
  if (parseClientRelease(value) === undefined) {
    throw new Error(`Malformed client release "${value}", expected r<number>.<sha12>`);
  }
  return value;
}

/** The poll reads `{"release_number": n, ...}` from release.json (DEVOPS-PLAN 6.2). */
export function releaseNumberFromManifest(body: unknown): number | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const n = (body as { release_number?: unknown }).release_number;
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : undefined;
}
