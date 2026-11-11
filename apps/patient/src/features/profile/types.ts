// Shapes the profile screens read. The contract types these bodies as opaque objects (patient.yaml, identity.yaml), so each
// is checked here and a malformed answer becomes a server-error state. Field names follow apps/api patient `profileBody`,
// `PreferenceView`, `ContactView` and identity `ProxyGrantView`.
import { asRecord, str } from './lib/core.js';

export interface Address {
  line1: string;
  line2: string;
  city: string;
  postalCode: string;
}

export interface Contact {
  id: string;
  kind: 'emergency' | 'next_of_kin';
  name: string;
  relationship: string;
  phone: string;
  email: string;
  version: number;
}

export interface Profile {
  givenName: string;
  familyName: string;
  dateOfBirth: string;
  phone: string;
  email: string;
  address: Address;
  stateCode: string;
  preferredLanguage: string;
  pharmacyName: string;
  contacts: Contact[];
  version: number;
}

export const CHANNELS = ['email', 'sms', 'push', 'in_app'] as const;
export type Channel = (typeof CHANNELS)[number];
const isChannel = (v: unknown): v is Channel => CHANNELS.includes(v as Channel);

export interface QuietHours {
  start: string;
  end: string;
  timeZone: string;
}

export interface Preferences {
  channels: Channel[];
  reminderChannel: Channel | null;
  language: string;
  quietHours: QuietHours | null;
  /** `undefined` while nothing is stored: the first save then goes without `If-Match`. */
  version: number | undefined;
}

export type ProxyStatus = 'invited' | 'requested' | 'verified' | 'active' | 'revoked' | 'expired';
export const PROXY_SCOPES = ['appointments', 'messages', 'documents'] as const;
export type ProxyScope = (typeof PROXY_SCOPES)[number];
export const PROXY_RELATIONSHIPS = ['parent', 'guardian', 'carer', 'other'] as const;
export type ProxyRelationship = (typeof PROXY_RELATIONSHIPS)[number];

export interface ProxyGrant {
  id: string;
  relationship: ProxyRelationship;
  patientDisplayName: string;
  status: ProxyStatus;
  /** Granted scopes (the patient's choice). */
  scopes: ProxyScope[];
  /** Scopes in force today, after the age rules and validity. Can be fewer than `scopes`. */
  effectiveScopes: ProxyScope[];
  /** A guardian link is managed by staff: the patient cannot change its scopes. */
  guardian: boolean;
  /** Masked address of an open invitation. */
  inviteeHint: string | undefined;
  /** Last day of the grant (the age-out date), `YYYY-MM-DD`. */
  validUntil: string | undefined;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const STATUSES: readonly string[] = [
  'invited',
  'requested',
  'verified',
  'active',
  'revoked',
  'expired',
];

export function parseContact(v: unknown): Contact | undefined {
  const o = asRecord(v);
  const id = str(o['id']);
  const name = str(o['name']);
  const version = num(o['rowVersion']);
  if (id === undefined || name === undefined || version === undefined) return undefined;
  return {
    id,
    kind: o['kind'] === 'next_of_kin' ? 'next_of_kin' : 'emergency',
    name,
    relationship: str(o['relationship']) ?? '',
    phone: str(o['phone']) ?? '',
    email: str(o['email']) ?? '',
    version,
  };
}

export function parseProfile(data: unknown, version: number | undefined): Profile | undefined {
  const o = asRecord(data);
  const given = str(o['givenName']);
  const family = str(o['familyName']);
  const v = version ?? num(o['version']);
  if (given === undefined || family === undefined || v === undefined) return undefined;
  const a = asRecord(o['address']);
  const contacts = Array.isArray(o['contacts'])
    ? o['contacts'].map(parseContact).filter((c): c is Contact => c !== undefined)
    : [];
  return {
    givenName: given,
    familyName: family,
    dateOfBirth: str(o['dateOfBirth']) ?? '',
    phone: str(o['phone']) ?? '',
    email: str(o['email']) ?? '',
    address: {
      line1: str(a['line1']) ?? '',
      line2: str(a['line2']) ?? '',
      city: str(a['city']) ?? '',
      postalCode: str(a['postalCode']) ?? '',
    },
    stateCode: str(o['stateCode']) ?? '',
    preferredLanguage: str(o['preferredLanguage']) ?? '',
    pharmacyName: str(asRecord(o['preferredPharmacy'])['name']) ?? '',
    contacts,
    version: v,
  };
}

export function parsePreferences(
  data: unknown,
  version: number | undefined,
): Preferences | undefined {
  const o = asRecord(data);
  if (!Array.isArray(o['channels'])) return undefined;
  const channels = o['channels'].filter(isChannel);
  const q = asRecord(o['quietHours']);
  const quiet =
    str(q['start']) !== undefined && str(q['end']) !== undefined
      ? { start: q['start'] as string, end: q['end'] as string, timeZone: str(q['timeZone']) ?? '' }
      : null;
  return {
    channels,
    reminderChannel: isChannel(o['reminderChannel']) ? o['reminderChannel'] : null,
    language: str(o['language']) ?? 'en',
    quietHours: quiet,
    version,
  };
}

export function parseProxy(v: unknown): ProxyGrant | undefined {
  const o = asRecord(v);
  const id = str(o['id']);
  const status = str(o['status']);
  if (id === undefined || status === undefined || !STATUSES.includes(status)) return undefined;
  const rel = str(o['relationship']);
  const scopesOf = (v: unknown): ProxyScope[] =>
    Array.isArray(v)
      ? v.filter((x): x is ProxyScope => PROXY_SCOPES.includes(x as ProxyScope))
      : [];
  const scopes = scopesOf(o['scopes']);
  return {
    id,
    relationship: PROXY_RELATIONSHIPS.includes(rel as ProxyRelationship)
      ? (rel as ProxyRelationship)
      : 'other',
    patientDisplayName: str(o['patientDisplayName']) ?? '',
    status: status as ProxyStatus,
    scopes: scopes.length > 0 ? scopes : ['appointments'],
    effectiveScopes: scopesOf(o['effectiveScopes']),
    guardian: o['guardian'] === true,
    inviteeHint: str(o['inviteeHint']),
    validUntil: str(o['validUntil']),
  };
}

export function parseList<T>(data: unknown, parse: (v: unknown) => T | undefined): T[] | undefined {
  const items = asRecord(data)['items'];
  if (!Array.isArray(items)) return undefined;
  const out = items.map(parse);
  return out.every((x) => x !== undefined) ? (out as T[]) : undefined;
}
