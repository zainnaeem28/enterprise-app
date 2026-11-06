/** `integration_core.connection.kind` (22.3 CHECK). R2+ kinds are added by migration. */
export const CONNECTION_KINDS = [
  'google_workspace_sso',
  'google_calendar',
  'email',
  'sms',
  'push',
  'video',
  'ocr',
  'malware_scan',
  'analytics_site',
] as const;
export type ConnectionKind = (typeof CONNECTION_KINDS)[number];

/** A key that looks like a credential. Non-secret settings never carry one (the table CHECK repeats this rule). */
export const SECRET_LIKE_KEY =
  /(secret|passw|token|api[_-]?key|private[_-]?key|credential|bearer|authorization|signature)/i;

export function hasSecretLikeKey(v: unknown, depth = 0): boolean {
  if (depth > 8) return true; // too deep to inspect is treated as unsafe
  if (Array.isArray(v)) return v.some((x) => hasSecretLikeKey(x, depth + 1));
  if (v !== null && typeof v === 'object')
    return Object.entries(v as Record<string, unknown>).some(
      ([k, x]) => SECRET_LIKE_KEY.test(k) || hasSecretLikeKey(x, depth + 1),
    );
  return false;
}
