// The R1 template set of RA-R1-05 / TC-NT-01 as a generator: confirmation, the two reminders, reschedule, cancel, waitlist offer,
// consent request, pre-visit request. Every message is a log-in prompt and links, nothing else (BR-23, BR-36): no service,
// clinician, diagnosis, test or medicine, whatever the booking. It is DATA for an administrator to load through
// `TemplateService` (this ticket ships no migration data, 21.7); the test renders it for every configured language.
// The text below is English. Other languages are translated by people, not generated: `forLanguages` repeats this text
// under the requested codes only so the render check can be exercised, and says so in its name.
import type { DeclaredVariable } from './allowlist.js';
import type { NewTemplate } from './templates.js';
import type { Channel } from './render.js';

const v = (name: string, type: DeclaredVariable['type']): DeclaredVariable => ({ name, type });
const START = [v('start_at', 'datetime'), v('time_zone', 'timezone')];

interface Spec {
  key: string;
  vars: DeclaredVariable[];
  subject: string;
  text: string;
  sms: string;
  push: string;
  ics: boolean;
}

const SPECS: readonly Spec[] = [
  {
    key: 'appointment_confirmation',
    vars: [
      ...START,
      v('location_name', 'location_name'),
      v('portal_link', 'url'),
      v('event_uid', 'uid'),
      v('end_at', 'datetime'),
    ],
    subject: 'Your appointment is confirmed',
    text: 'Your appointment at {{location_name}} is confirmed for {{start_at}}. Sign in to your patient portal to see the details, or to confirm, reschedule or cancel: {{portal_link}}',
    sms: 'Appointment confirmed for {{start_at}}. Sign in to see details: {{portal_link}}',
    push: 'Your appointment is confirmed for {{start_at}}. Open the portal for details.',
    ics: true,
  },
  {
    key: 'appointment_reminder_48h',
    vars: [
      ...START,
      v('portal_link', 'url'),
      v('confirm_link', 'url'),
      v('reschedule_link', 'url'),
      v('cancel_link', 'url'),
    ],
    subject: 'Reminder: your appointment on {{start_at}}',
    text: 'This is a reminder of your appointment on {{start_at}}. Sign in to your patient portal: {{portal_link}}\nConfirm: {{confirm_link}}\nReschedule: {{reschedule_link}}\nCancel: {{cancel_link}}',
    sms: 'Reminder: appointment {{start_at}}. Confirm {{confirm_link}} Reschedule {{reschedule_link}} Cancel {{cancel_link}}',
    push: 'Reminder: your appointment is on {{start_at}}.',
    ics: false,
  },
  {
    key: 'appointment_reminder_4h',
    vars: [
      ...START,
      v('portal_link', 'url'),
      v('confirm_link', 'url'),
      v('reschedule_link', 'url'),
      v('cancel_link', 'url'),
    ],
    subject: 'Reminder: your appointment today at {{start_at}}',
    text: 'Your appointment is today at {{start_at}}. Sign in to your patient portal: {{portal_link}}\nConfirm: {{confirm_link}}\nReschedule: {{reschedule_link}}\nCancel: {{cancel_link}}',
    sms: 'Appointment today {{start_at}}. Confirm {{confirm_link}} Reschedule {{reschedule_link}} Cancel {{cancel_link}}',
    push: 'Your appointment is today at {{start_at}}.',
    ics: false,
  },
  {
    key: 'appointment_rescheduled',
    vars: [
      ...START,
      v('location_name', 'location_name'),
      v('portal_link', 'url'),
      v('event_uid', 'uid'),
      v('end_at', 'datetime'),
    ],
    subject: 'Your appointment has moved',
    text: 'Your appointment at {{location_name}} is now on {{start_at}}. Sign in to your patient portal for details: {{portal_link}}',
    sms: 'Your appointment moved to {{start_at}}. Details: {{portal_link}}',
    push: 'Your appointment moved to {{start_at}}.',
    ics: true,
  },
  {
    key: 'appointment_cancelled',
    vars: [v('portal_link', 'url')],
    subject: 'Your appointment was cancelled',
    text: 'Your appointment was cancelled. Sign in to your patient portal to book another time: {{portal_link}}',
    sms: 'Your appointment was cancelled. Book another time: {{portal_link}}',
    push: 'Your appointment was cancelled.',
    ics: false,
  },
  {
    key: 'waitlist_offer',
    vars: [
      v('start_at', 'datetime'),
      v('time_zone', 'timezone'),
      v('offer_expires_at', 'datetime'),
      v('portal_link', 'url'),
    ],
    subject: 'A time has opened up',
    text: 'A time on {{start_at}} is available. Sign in to your patient portal before {{offer_expires_at}} to accept or decline: {{portal_link}}',
    sms: 'A time opened on {{start_at}}. Respond before {{offer_expires_at}}: {{portal_link}}',
    push: 'A time opened on {{start_at}}. Respond in the portal.',
    ics: false,
  },
  {
    key: 'consent_request',
    vars: [v('portal_link', 'url')],
    subject: 'Please review and sign a form',
    text: 'There is a form waiting for you. Sign in to your patient portal to review and sign it: {{portal_link}}',
    sms: 'A form is waiting for you. Sign in: {{portal_link}}',
    push: 'A form is waiting for you in the portal.',
    ics: false,
  },
  {
    key: 'previsit_request',
    vars: [v('start_at', 'datetime'), v('time_zone', 'timezone'), v('portal_link', 'url')],
    subject: 'Please complete your pre-visit steps',
    text: 'Before your appointment on {{start_at}}, please sign in to your patient portal to complete your pre-visit steps: {{portal_link}}',
    sms: 'Please complete your pre-visit steps before {{start_at}}: {{portal_link}}',
    push: 'Please complete your pre-visit steps in the portal.',
    ics: false,
  },
];

const ICS = (): string =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//EHR//Notifications//EN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    'UID:{{event_uid}}',
    'DTSTAMP:{{start_at}}',
    'DTSTART:{{start_at}}',
    'DTEND:{{end_at}}',
    'SUMMARY:Appointment',
    'LOCATION:{{location_name}}',
    'DESCRIPTION:Sign in to your patient portal for details: {{portal_link}}',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\n');

/** The names a row uses, plus `time_zone` whenever it prints a time (the renderer formats it in the location's zone). */
function declare(channel: Channel, vars: DeclaredVariable[], text: string): DeclaredVariable[] {
  const used = (n: string): boolean => new RegExp(`\\{\\{ ?${n} ?\\}\\}`).test(text);
  const out = vars.filter((x) => x.name !== 'time_zone' && used(x.name));
  const tz = vars.find((x) => x.name === 'time_zone');
  if (channel !== 'ics' && tz !== undefined && out.some((x) => x.type === 'datetime')) out.push(tz);
  return out;
}

export const R1_TEMPLATE_KEYS: readonly string[] = SPECS.map((s) => s.key);

/** The full set for the given language codes: email, SMS, push and in-app per key, plus .ics where an appointment exists. */
export function r1TemplatesForLanguages(languages: readonly string[]): NewTemplate[] {
  const out: NewTemplate[] = [];
  for (const language of languages)
    for (const s of SPECS) {
      const row = (
        channel: Channel,
        body: string,
        subject: string | null,
        vars: DeclaredVariable[],
      ): NewTemplate => ({
        key: s.key,
        channel,
        language,
        body,
        variables: declare(channel, vars, `${subject ?? ''}${body}`),
        ...(subject === null ? {} : { subject }),
      });
      out.push(row('email', s.text, s.subject, s.vars));
      out.push(row('sms', s.sms, null, s.vars));
      out.push(row('push', s.push, null, s.vars));
      out.push(row('in_app', s.push, null, s.vars));
      if (s.ics) out.push(row('ics', ICS(), null, s.vars));
    }
  return out;
}
