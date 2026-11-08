// Plain-language copy for the availability screens (UI-UX 11). Counts only; no patient detail is ever drawn here.
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const avStrings = {
  title: 'My availability',
  tabsLabel: 'Availability sections',
  tabHours: 'Weekly hours',
  tabLeave: 'Leave and blocked time',
  tabCalendar: 'Google Calendar',
  noLocation:
    'Your account is not assigned to a location, so there is nothing to set up. Ask an administrator.',
  noPermission: 'Your role cannot change this part of your availability.',
  updatedAt: (t: string) => `Updated at ${t}`,
  refresh: 'Refresh',
  location: 'Location',
  locationN: (n: number) => `Location ${n}`,
  deviceTime: "Times are shown and entered in this device's time zone.",
  conflict: 'Someone changed this while you were editing. Refresh and check before you try again.',
  sessionFailed: 'We could not load your details. Try again.',
  offlineWrites: 'You are offline. Changes are disabled until the connection returns.',

  // Weekly hours (DR-11)
  hoursTitle: 'Weekly hours',
  hoursIntro:
    'These hours decide which times patients can book. A change applies to new searches from the moment you save it. Visits already booked are never cancelled by a change.',
  hoursEmpty: 'You have no weekly hours at this location yet.',
  newTemplate: 'Set up weekly hours',
  editTemplate: 'Change hours',
  retireTemplate: 'Stop using these hours',
  validity: (from: string, to: string | null) =>
    to === null ? `From ${from}, no end date` : `From ${from} to ${to}`,
  weekdays: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  dayClosed: 'Not working',
  addWindow: (day: string) => `Add hours on ${day}`,
  removeWindow: (day: string, n: number) => `Remove hours ${n} on ${day}`,
  windowStart: (day: string, n: number) => `${day}, hours ${n}: from`,
  windowEnd: (day: string, n: number) => `${day}, hours ${n}: until`,
  windowMode: (day: string, n: number) => `${day}, hours ${n}: visit type`,
  modeLabel: (m: string) => (m === 'in_person' ? 'In person' : m === 'video' ? 'Video' : 'Either'),
  validFrom: 'Valid from',
  validTo: 'Valid until (optional)',
  keptNote: 'Services, rooms and overbooking on existing hours are kept as they are.',
  review: 'Check affected appointments',
  checking: 'Checking your upcoming appointments…',
  cancel: 'Cancel',
  fixErrors: 'Fix these before you continue',
  errNeedRule: 'Add at least one block of hours, or stop using these hours.',
  errOrder: (day: string, n: number) => `${day}, hours ${n}: the end must be after the start.`,
  errOverlap: (day: string) => `${day}: two blocks of hours overlap.`,
  errFrom: 'Enter the date these hours start (YYYY-MM-DD).',
  errTo: 'The end date must not be before the start date.',
  previewFailed:
    'We could not check your upcoming appointments, so we cannot save yet. Nothing was changed.',
  previewRange: (n: number) =>
    `Checked the next ${n} days of your own appointments at this location.`,
  previewNone: 'No upcoming appointment falls outside these hours.',
  previewSome: (n: number) =>
    `${plural(n, 'upcoming appointment falls', 'upcoming appointments fall')} outside these hours.`,
  previewKept:
    'They stay booked. Saving does not cancel or move them; the clinic will need to contact those patients.',
  previewAck: 'I understand these appointments stay booked outside my hours',
  saveHours: 'Save hours',
  saveRetire: 'Stop using these hours',
  saved: 'Saved. New searches use these hours now.',
  retired: 'These hours are no longer used.',
  previewRow: (date: string, from: string, to: string, status: string) =>
    `${date}, ${from} to ${to} (${status})`,
  confirmRetireTitle: 'Stop using these hours?',

  // Leave and blocked time (DR-12)
  leaveTitle: 'Leave and blocked time',
  leaveIntro:
    'Leave and blocked time remove those hours from booking. We show the appointments already booked in that period before you save.',
  leaveEmpty: 'You have no upcoming leave or blocked time.',
  kind: 'Type',
  kindLabel: (k: string) =>
    k === 'leave' ? 'Leave' : k === 'blocked' ? 'Blocked time' : 'Admin time',
  startsAt: 'From',
  endsAt: 'Until',
  note: 'Note (optional)',
  noteHint: 'Up to 200 characters. Do not write patient names or details.',
  errPeriod: 'Enter a start and an end, and make the end later than the start.',
  errNote: 'The note must be 200 characters or fewer.',
  checkPeriod: 'Check affected appointments',
  periodNone: 'No appointment is booked in this period.',
  periodSome: (c: { total: number; held: number; confirmed: number; checked_in: number }) =>
    `${plural(c.total, 'appointment is', 'appointments are')} booked in this period: ${c.confirmed} confirmed, ${c.held} on hold, ${c.checked_in} arrived.`,
  periodKept:
    'They stay booked. Saving does not cancel or move them; the clinic will need to contact those patients.',
  periodAck: 'I understand these appointments stay booked',
  periodChanged:
    'Appointments were booked in this period since you checked. Review the new count and confirm again.',
  savePeriod: 'Save',
  periodSaved: 'Saved. Those hours are no longer offered for booking.',
  remove: (kind: string, from: string) => `Remove ${kind.toLowerCase()} from ${from}`,
  removeTitle: 'Remove this period?',
  removeBody:
    'The hours become bookable again right away. Nothing else changes. This cannot be undone, but you can add the period again.',
  removeConfirm: 'Remove',
  removed: 'Removed.',

  // Google Calendar (DR-13)
  calTitle: 'Google Calendar',
  calIntro:
    'Connect your Google Calendar so that times you are busy in Google are not offered to patients.',
  consentTitle: 'What you are agreeing to',
  consent: [
    'You will go to Google to sign in and approve access. We never see your Google password.',
    'We ask Google for two permissions only: to see when you are busy or free, and to add and remove our own "Busy" entries on your primary calendar.',
    'When you have a booking here, we add a plain "Busy" entry to your calendar. It has no patient name, reason or service.',
  ],
  busyOnly:
    'Busy-only sync: we read only the times you are busy. We do not copy the titles, guests, places or notes of your Google events, and we never show them to anyone.',
  disconnectNote:
    'You can disconnect at any time. Your hours stay as they are; times from Google stop blocking bookings.',
  stateTitle: 'Connection',
  stateNot: 'Not connected',
  stateNotBody: 'Your Google Calendar is not connected. Patients can book any time in your hours.',
  statePending: 'Waiting for Google',
  statePendingBody:
    'You started connecting but did not finish at Google. Connect again to finish; nothing is shared until you approve.',
  stateActive: 'Connected',
  stateActiveBody: 'Times you are busy in Google are kept off your bookable hours.',
  stateRevoked: 'Connection needs attention',
  stateRevokedBody:
    'Google says access was removed or has expired. Connect again to restore it. Until then, the busy times we last saw stay blocked and bookings may show a warning that your calendar is out of date.',
  stateError: 'Connection problem',
  stateErrorBody:
    'We could not read your calendar. We will keep trying. The busy times we last saw stay blocked. If it keeps happening, disconnect and connect again.',
  lastSync: (t: string) => `Last synced ${t}`,
  neverSynced: 'Not synced yet',
  connect: 'Connect Google Calendar',
  reconnect: 'Connect again',
  disconnect: 'Disconnect',
  connecting: 'Taking you to Google…',
  startFailed: 'We could not start the connection. Nothing was changed. Try again.',
  badRedirect: 'We were sent to an unexpected address, so we stopped. Nothing was changed.',
  landingLinked: 'Connected. Google Calendar is now kept in sync.',
  landingDenied: 'You did not approve access at Google, so nothing was connected.',
  landingError: 'Google could not finish connecting. Nothing was changed. Try again.',
  disconnectTitle: 'Disconnect Google Calendar?',
  disconnectBody:
    'Times from Google will stop blocking your bookings. Your weekly hours are not changed.',
  disconnected: 'Disconnected.',
} as const;
