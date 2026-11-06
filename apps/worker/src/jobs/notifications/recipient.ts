// Recipient resolution (SHARED-BOUNDARIES 3.2 rule 7, ARCHITECTURE 22.13). `notifications.send` takes a recipient REFERENCE
// (`patient:<id>` or `principal:<id>`), never an address. The sending job asks the owner of the contact data at send time:
// `patient` registers a recipient-resolution contributor (patient contacts and `communication_preference`, BE-08), staff
// come from `identity` (push subscriptions belong to `identity`, 22.13). The answer is used to send and is never stored in
// `notifications` rows. Until those modules exist, the composition root injects the contributors; a missing one fails closed
// (the notification is suppressed `no_recipient`), it never falls back to an address in a row.
import type { Tx } from '@ehr/kernel';
import { isUuid } from './ids.js';

export type DeliveryChannel = 'email' | 'sms' | 'push' | 'in_app';
export const DELIVERY_CHANNELS: readonly DeliveryChannel[] = ['email', 'sms', 'push', 'in_app'];

export type WithheldReason = 'preference_off' | 'no_address';

export interface ChannelTarget {
  channel: DeliveryChannel;
  /** E-mail address, E.164 number or push subscription reference. Absent for `in_app`. Never logged, never stored. */
  address?: string;
}

export interface QuietHours {
  /** `HH:MM`, local to `timeZone`. A window that ends before it starts crosses midnight. */
  start: string;
  end: string;
  timeZone: string;
}

export interface ResolvedRecipient {
  /** False when the person can no longer be contacted (closed, deceased, disabled). */
  active: boolean;
  language: string;
  /** Channels the person may be reached on AFTER their preferences, with the address to use. */
  permitted: readonly ChannelTarget[];
  /** Channels that exist for the template but are withheld, and why (the notification is suppressed with that reason). */
  withheld: readonly { channel: DeliveryChannel; reason: WithheldReason }[];
  quietHours?: QuietHours;
}

export type RecipientRef = { kind: 'patient'; id: string } | { kind: 'principal'; id: string };

export function parseRecipientRef(ref: string): RecipientRef | undefined {
  const m = /^(patient|principal):([0-9a-fA-F-]{36})$/.exec(ref);
  if (m === null || !isUuid(m[2])) return undefined;
  return { kind: m[1] as 'patient' | 'principal', id: (m[2] as string).toLowerCase() };
}

/** Runs in the sending job's scope (audience `system`, narrowed to the patient). Returns undefined for an unknown recipient. */
export interface RecipientContributor {
  resolve(tx: Tx, id: string): Promise<ResolvedRecipient | undefined>;
}

export interface RecipientContributors {
  patient?: RecipientContributor;
  principal?: RecipientContributor;
}

/** The patient's stored preference (`patient.communication_preference`, 22.5/22.6), as the contributor reads it. */
export interface CommunicationPreference {
  /** Channels the patient allows. */
  channels: readonly DeliveryChannel[];
  /** When set, appointment reminders use this channel only. */
  reminderChannel?: DeliveryChannel;
  language: string;
  quietHours?: QuietHours;
}

export interface ContactPoints {
  email?: string;
  phone?: string;
  /** Opaque push subscription reference (from `identity.push_subscription`). */
  push?: string;
}

/**
 * The rule the `patient` contributor applies (TC-NT-08, TC-PR-01): a channel is permitted when the person allows it AND
 * an address exists for it. `in_app` needs no address and is always kept, so a failing provider never leaves the person
 * without the notice (TC-NT-04). `marketing_opt_in` is not read here: nothing in notifications sends marketing.
 * Whether security messages (sign-in codes) are exempt from the preference is PM-confirm-3 and is NOT decided here.
 */
export function applyCommunicationPreferences(
  contacts: ContactPoints,
  pref: CommunicationPreference,
  purpose: 'reminder' | 'other' = 'other',
): Pick<ResolvedRecipient, 'permitted' | 'withheld'> {
  const permitted: ChannelTarget[] = [];
  const withheld: { channel: DeliveryChannel; reason: WithheldReason }[] = [];
  const address: Record<DeliveryChannel, string | undefined> = {
    email: contacts.email,
    sms: contacts.phone,
    push: contacts.push,
    in_app: undefined,
  };
  for (const channel of DELIVERY_CHANNELS) {
    if (channel === 'in_app') {
      permitted.push({ channel });
      continue;
    }
    const allowed =
      pref.channels.includes(channel) &&
      (purpose !== 'reminder' ||
        pref.reminderChannel === undefined ||
        pref.reminderChannel === channel);
    if (!allowed) withheld.push({ channel, reason: 'preference_off' });
    else if (address[channel] === undefined || address[channel] === '')
      withheld.push({ channel, reason: 'no_address' });
    else permitted.push({ channel, address: address[channel] as string });
  }
  return { permitted, withheld };
}

/** True when `at` falls inside the window; and the instant the window ends (for rescheduling). */
export function quietHoursEnd(q: QuietHours, at: Date): Date | undefined {
  const parse = (s: string): number | undefined => {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s);
    return m === null ? undefined : Number(m[1]) * 60 + Number(m[2]);
  };
  const start = parse(q.start);
  const end = parse(q.end);
  if (start === undefined || end === undefined || start === end) return undefined;
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: q.timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    return undefined;
  }
  const minuteOfDay = (d: Date): number => {
    const parts = fmt.formatToParts(d);
    const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
    const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
    return h * 60 + m;
  };
  const inside = (m: number): boolean =>
    start < end ? m >= start && m < end : m >= start || m < end;
  if (!inside(minuteOfDay(at))) return undefined;
  // Walk forward minute by minute (at most 24 h) to the first minute outside the window. Exact across DST changes.
  const base = new Date(Math.floor(at.getTime() / 60000) * 60000);
  for (let i = 1; i <= 24 * 60; i++) {
    const d = new Date(base.getTime() + i * 60000);
    if (!inside(minuteOfDay(d))) return d;
  }
  return undefined;
}
