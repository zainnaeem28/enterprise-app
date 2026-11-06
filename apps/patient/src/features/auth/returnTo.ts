/** Where a signed-in patient lands when no other place was asked for. */
export const DEFAULT_RETURN_TO = '/account';

/**
 * `returnTo` must be a relative path on this host (`getAuthSignIn`). Anything else becomes the default; the API
 * applies the same rule again, this check only keeps a bad value from being sent at all.
 */
export function checkedReturnTo(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512)
    return DEFAULT_RETURN_TO;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\'))
    return DEFAULT_RETURN_TO;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return DEFAULT_RETURN_TO;
  try {
    const u = new URL(value, 'https://placeholder.invalid');
    if (u.origin !== 'https://placeholder.invalid') return DEFAULT_RETURN_TO;
  } catch {
    return DEFAULT_RETURN_TO;
  }
  return value;
}
