// The variable allowlist (SHARED-BOUNDARIES 8.3, BD-10; ARCHITECTURE 22.13). A template may bind only these names, each with
// its one type, and `send` accepts only values that pass that type's check. There is NO service, diagnosis, medicine, test
// or clinician field and no free-text field of another module: BQ-2 (clinician name) is open, and TC-NT-01 allows only a
// log-in prompt and links. Adding a name is a contract change (HEAAA-13) AND a migration edit of notifications.allowed_variable
// (0600); `allowlist.test.ts` compares both lists. This file is copied byte-for-byte to apps/worker/src/jobs/notifications.
export const VARIABLE_TYPES = [
  'datetime',
  'location_name',
  'url',
  'code',
  'timezone',
  'uid',
] as const;
export type VariableType = (typeof VARIABLE_TYPES)[number];

export const VARIABLE_ALLOWLIST: Readonly<Record<string, VariableType>> = Object.freeze({
  start_at: 'datetime',
  end_at: 'datetime',
  offer_expires_at: 'datetime',
  location_name: 'location_name',
  portal_link: 'url',
  sign_in_link: 'url',
  confirm_link: 'url',
  reschedule_link: 'url',
  cancel_link: 'url',
  code: 'code',
  time_zone: 'timezone',
  event_uid: 'uid',
});

export interface DeclaredVariable {
  name: string;
  type: VariableType;
}

export function isAllowedVariable(name: string, type: string): boolean {
  return (
    Object.prototype.hasOwnProperty.call(VARIABLE_ALLOWLIST, name) &&
    VARIABLE_ALLOWLIST[name] === type
  );
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Control characters, markup and template braces never belong in a display name.
// eslint-disable-next-line no-control-regex
const BAD_TEXT = /[\u0000-\u001f\u007f<>{}\\]/;

export function isTimeZone(v: string): boolean {
  if (!/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(v)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: v });
    return true;
  } catch {
    return false;
  }
}

export interface ValueOptions {
  /** When set, a link must be https on one of these hosts (the deployment's portal origins). */
  allowedLinkHosts?: readonly string[];
}

/** Returns the normalised value, or `undefined` when the value is not acceptable for the type. Never throws on input. */
export function normaliseValue(
  type: VariableType,
  value: unknown,
  opts: ValueOptions = {},
): string | undefined {
  if (typeof value !== 'string') return undefined;
  switch (type) {
    case 'datetime': {
      if (!ISO.test(value)) return undefined;
      const t = Date.parse(value);
      if (Number.isNaN(t)) return undefined;
      // Date.parse rolls 2030-02-31 over to March: the calendar date must survive a round trip.
      const [y, m, d] = value.slice(0, 10).split('-').map(Number) as [number, number, number];
      const probe = new Date(Date.UTC(y, m - 1, d));
      if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d)
        return undefined;
      return new Date(t).toISOString();
    }
    case 'location_name':
      return value.length >= 1 &&
        value.length <= 80 &&
        !BAD_TEXT.test(value) &&
        value === value.trim()
        ? value
        : undefined;
    case 'url': {
      // eslint-disable-next-line no-control-regex
      if (value.length > 500 || /[\s\u0000-\u001f<>"'\\]/.test(value)) return undefined;
      let u: URL;
      try {
        u = new URL(value);
      } catch {
        return undefined;
      }
      if (u.protocol !== 'https:' || u.username !== '' || u.password !== '') return undefined;
      if (
        opts.allowedLinkHosts !== undefined &&
        !opts.allowedLinkHosts.includes(u.hostname.toLowerCase())
      )
        return undefined;
      return u.toString();
    }
    case 'code':
      return /^[A-Za-z0-9]{4,12}$/.test(value) ? value : undefined;
    case 'timezone':
      return isTimeZone(value) ? value : undefined;
    case 'uid':
      return UUID.test(value) ? value.toLowerCase() : undefined;
  }
}

/** Representative values for the render check (RA-R1-05): harmless, valid for every type. */
export const SAMPLE_VALUES: Readonly<Record<VariableType, string>> = Object.freeze({
  datetime: '2030-01-15T14:30:00.000Z',
  location_name: 'Riverside Clinic',
  url: 'https://portal.example.test/appointments',
  code: 'A1B2C3',
  timezone: 'America/New_York',
  uid: '00000000-0000-4000-8000-000000000001',
});
