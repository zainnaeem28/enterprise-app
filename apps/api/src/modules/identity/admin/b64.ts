// base64url without padding (WebAuthn JSON encoding).
export const b64urlEncode = (b: Uint8Array): string => Buffer.from(b).toString('base64url');

const SHAPE = /^[A-Za-z0-9_-]*$/;
export function b64urlDecode(s: unknown, maxBytes: number): Buffer | undefined {
  if (typeof s !== 'string' || s.length === 0 || s.length > Math.ceil((maxBytes * 4) / 3) + 2)
    return undefined;
  if (!SHAPE.test(s)) return undefined;
  const b = Buffer.from(s, 'base64url');
  // Reject non-canonical encodings: the same bytes must round-trip to the same text.
  return b.toString('base64url') === s ? b : undefined;
}
