// The configuration resources of BE-23 as ResourceScreen specs: fields, limits and columns follow the field tables of
// apps/api/src/modules/organisation/admin (service.ts). The server repeats every rule; a refusal is shown, never a stored value.
import { StatusChip } from '@ehr/ui';
import type { Field, Option, ResourceSpec, Values } from './ResourceScreen.js';
import { fmtTime } from './ResourceScreen.js';
import { configStrings as s } from './strings.js';
import { flag, text } from './types.js';
import type { Row } from './types.js';

const yesNo = (b: boolean) => (b ? s.yes : s.no);
const activeChip = (r: Row) => (
  <StatusChip tone={flag(r, 'active') ? 'success' : 'neutral'}>
    {flag(r, 'active') ? s.active : s.inactive}
  </StatusChip>
);
const labelOf = (refs: Record<string, Option[]>, path: string, id: string): string =>
  refs[path]?.find((o) => o.value === id)?.label ?? (id === '' ? s.anyLocation : s.none);
const activeField: Field = { name: 'active', label: s.active, type: 'bool', def: true };
const locationRef = (required: boolean): Field => ({
  name: 'locationId',
  label: 'Location',
  type: 'select',
  required,
  createOnly: true,
  ref: { path: 'locations', label: 'name', ...(required ? {} : { empty: s.anyLocation }) },
});

const zoneOk = (v: string): string | undefined => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: v });
    return undefined;
  } catch {
    return s.invalid;
  }
};

export const LOCATIONS: ResourceSpec = {
  path: 'locations',
  title: s.locations,
  empty: s.locationsEmpty,
  change: 'PATCH',
  removable: false,
  fields: [
    { name: 'name', label: 'Name', type: 'text', required: true, maxLength: 200 },
    {
      name: 'kind',
      label: 'Kind',
      type: 'select',
      required: true,
      options: [
        { value: 'clinic', label: 'Clinic' },
        { value: 'virtual', label: 'Virtual' },
      ],
    },
    {
      name: 'timeZone',
      label: 'Time zone',
      type: 'text',
      required: true,
      hint: 'For example America/New_York.',
      check: zoneOk,
    },
    {
      name: 'stateCode',
      label: 'State',
      type: 'text',
      required: true,
      hint: 'Two capital letters.',
      maxLength: 2,
      check: (v) => (/^[A-Z]{2}$/.test(v) ? undefined : s.invalid),
    },
    { name: 'phone', label: 'Phone', type: 'text', nullable: true, maxLength: 40 },
    activeField,
  ],
  columns: () => [
    { key: 'name', header: 'Name', render: (r) => text(r, 'name') },
    {
      key: 'kind',
      header: 'Kind',
      render: (r) => (text(r, 'kind') === 'virtual' ? 'Virtual' : 'Clinic'),
    },
    { key: 'state', header: 'State', render: (r) => text(r, 'stateCode') },
    { key: 'tz', header: 'Time zone', render: (r) => text(r, 'timeZone') },
    { key: 'active', header: s.active, render: activeChip },
  ],
  rowLabel: (r) => text(r, 'name'),
};

export const ROOMS: ResourceSpec = {
  path: 'rooms',
  title: s.rooms,
  empty: s.roomsEmpty,
  change: 'PATCH',
  fields: [
    locationRef(true),
    { name: 'name', label: 'Room name', type: 'text', required: true, maxLength: 100 },
    activeField,
  ],
  columns: (refs) => [
    { key: 'name', header: 'Room', render: (r) => text(r, 'name') },
    {
      key: 'loc',
      header: 'Location',
      render: (r) => labelOf(refs, 'locations', text(r, 'locationId')),
    },
    { key: 'active', header: s.active, render: activeChip },
  ],
  rowLabel: (r) => text(r, 'name'),
};

export const HOURS: ResourceSpec = {
  path: 'opening-hours',
  title: s.hours,
  empty: s.hoursEmpty,
  change: 'PATCH',
  removable: true,
  identity: (r) => ({ locationId: r['locationId'], weekday: r['weekday'], opens: r['opens'] }),
  fields: [
    locationRef(true),
    {
      name: 'weekday',
      label: 'Day',
      type: 'select',
      required: true,
      createOnly: true,
      asNumber: true,
      options: s.weekdays.map((label, i) => ({ value: String(i), label })),
    },
    { name: 'opens', label: 'Opens', type: 'time', required: true, createOnly: true },
    { name: 'closes', label: 'Closes', type: 'time', required: true },
  ],
  validate: (v: Values) =>
    typeof v['opens'] === 'string' &&
    typeof v['closes'] === 'string' &&
    v['opens'] !== '' &&
    v['closes'] !== '' &&
    v['opens'] >= v['closes']
      ? { closes: 'Closing time must be after opening time.' }
      : undefined,
  columns: (refs) => [
    {
      key: 'loc',
      header: 'Location',
      render: (r) => labelOf(refs, 'locations', text(r, 'locationId')),
    },
    { key: 'day', header: 'Day', render: (r) => s.weekdays[Number(r['weekday'])] ?? s.none },
    { key: 'opens', header: 'Opens', render: (r) => text(r, 'opens') },
    { key: 'closes', header: 'Closes', render: (r) => text(r, 'closes') },
  ],
  rowLabel: (r) => `${s.weekdays[Number(r['weekday'])] ?? ''} ${text(r, 'opens')}`.trim(),
};

export const HOLIDAYS: ResourceSpec = {
  path: 'holidays',
  title: s.holidays,
  empty: s.holidaysEmpty,
  change: 'PATCH',
  removable: true,
  fields: [
    locationRef(false),
    { name: 'date', label: 'Date', type: 'date', required: true },
    { name: 'name', label: 'Name', type: 'text', required: true, maxLength: 200 },
  ],
  columns: (refs) => [
    { key: 'date', header: 'Date', render: (r) => text(r, 'date') },
    { key: 'name', header: 'Name', render: (r) => text(r, 'name') },
    {
      key: 'loc',
      header: 'Applies to',
      render: (r) => labelOf(refs, 'locations', text(r, 'locationId')),
    },
  ],
  rowLabel: (r) => `${text(r, 'name')} ${text(r, 'date')}`,
};

const same = (a: unknown, b: unknown) =>
  typeof a === 'string' &&
  typeof b === 'string' &&
  a.trim().toLowerCase() === b.trim().toLowerCase();

/** What a patient is shown for a service (BR-23 extension): the neutral name when the service reveals a condition. */
export const SERVICES: ResourceSpec = {
  path: 'services',
  title: s.servicesTitle,
  empty: s.servicesEmpty,
  change: 'PATCH',
  fields: [
    { name: 'internalName', label: 'Internal name', type: 'text', required: true, maxLength: 200 },
    {
      name: 'conditionRevealing',
      label: 'The service name would reveal a condition',
      type: 'bool',
    },
    {
      name: 'patientDisplayName',
      label: 'Name patients see',
      type: 'text',
      hint: 'Shown to patients, in reminders and in e-mails. Leave empty to use the internal name.',
      maxLength: 200,
    },
    {
      name: 'durationMin',
      label: 'Length (minutes)',
      type: 'int',
      required: true,
      min: 5,
      max: 480,
    },
    { name: 'bufferMin', label: 'Buffer after (minutes)', type: 'int', min: 0, max: 120, def: '0' },
    {
      name: 'mode',
      label: 'How it is held',
      type: 'select',
      required: true,
      options: [
        { value: 'in_person', label: 'In person' },
        { value: 'video', label: 'Video' },
        { value: 'either', label: 'In person or video' },
      ],
    },
    {
      name: 'priceCents',
      label: 'Price (in cents)',
      type: 'int',
      nullable: true,
      min: 0,
      max: 1_000_000_000_000,
      hint: s.priceNote,
    },
    {
      name: 'currency',
      label: 'Currency',
      type: 'text',
      nullable: true,
      maxLength: 3,
      hint: 'Three capital letters, for example USD.',
      check: (v) => (/^[A-Z]{3}$/.test(v) ? undefined : s.invalid),
    },
    activeField,
  ],
  validate: (v) =>
    v['conditionRevealing'] === true &&
    (String(v['patientDisplayName']).trim() === '' ||
      same(v['patientDisplayName'], v['internalName']))
      ? { patientDisplayName: s.neutralRequired }
      : undefined,
  aside: (v) => (
    <>
      {v['conditionRevealing'] === true && <p>{s.neutralNote}</p>}
      <p>
        {s.patientSees(
          String(v['patientDisplayName']).trim() || String(v['internalName']).trim() || s.none,
        )}
      </p>
    </>
  ),
  columns: () => [
    { key: 'internal', header: 'Internal name', render: (r) => text(r, 'internalName') },
    {
      key: 'patient',
      header: 'Patients see',
      render: (r) => text(r, 'patientDisplayName') || text(r, 'internalName'),
    },
    {
      key: 'reveals',
      header: 'Reveals a condition',
      render: (r) => yesNo(flag(r, 'conditionRevealing')),
    },
    { key: 'length', header: 'Minutes', render: (r) => String(r['durationMin'] ?? s.none) },
    { key: 'active', header: s.active, render: activeChip },
  ],
  rowLabel: (r) => text(r, 'internalName'),
};

export const POLICIES: ResourceSpec = {
  path: 'booking-policies',
  title: s.policiesTitle,
  empty: s.policiesEmpty,
  change: 'PATCH',
  fields: [
    {
      name: 'serviceId',
      label: 'Service',
      type: 'select',
      required: true,
      createOnly: true,
      ref: { path: 'services', label: 'internalName' },
    },
    locationRef(false),
    {
      name: 'cutoffHours',
      label: 'Change cut-off (hours before the visit)',
      type: 'int',
      min: 0,
      max: 8760,
      hint: 'Leave empty to use the organisation default.',
    },
    {
      name: 'lateChange',
      label: 'Changes inside the cut-off',
      type: 'select',
      required: true,
      def: 'block',
      options: (start) => [
        { value: 'block', label: s.blockOnly },
        ...(start['lateChange'] === 'fee' ? [{ value: 'fee', label: s.feeStored }] : []),
      ],
    },
    {
      name: 'leadTimeMin',
      label: 'Shortest notice to book (minutes)',
      type: 'int',
      min: 0,
      max: 525_600,
    },
    {
      name: 'maxFuturePerPatient',
      label: 'Future visits per patient',
      type: 'int',
      min: 1,
      max: 1000,
      hint: 'Leave empty to use the organisation default.',
    },
    { name: 'waitlistEnabled', label: 'Waitlist on', type: 'bool' },
    {
      name: 'overbookCapPerSession',
      label: 'Overbooking cap per session',
      type: 'int',
      min: 0,
      max: 1000,
    },
    {
      name: 'holdMinutes',
      label: 'Slot hold (minutes)',
      type: 'int',
      nullable: true,
      min: 1,
      max: 120,
    },
    {
      name: 'noShowGraceMin',
      label: 'No-show grace (minutes)',
      type: 'int',
      nullable: true,
      min: 0,
      max: 240,
    },
  ],
  aside: (v) => (
    <>
      <p>{s.blockNote}</p>
      {v['lateChange'] === 'fee' && <p>{s.feeConverted}</p>}
    </>
  ),
  columns: (refs) => [
    {
      key: 'service',
      header: 'Service',
      render: (r) => labelOf(refs, 'services', text(r, 'serviceId')),
    },
    {
      key: 'loc',
      header: 'Applies to',
      render: (r) => labelOf(refs, 'locations', text(r, 'locationId')),
    },
    { key: 'cutoff', header: 'Cut-off (hours)', render: (r) => String(r['cutoffHours'] ?? s.none) },
    {
      key: 'late',
      header: 'Changes inside the cut-off',
      render: (r) => (text(r, 'lateChange') === 'fee' ? s.feeStored : s.blockOnly),
    },
    { key: 'wait', header: 'Waitlist', render: (r) => yesNo(flag(r, 'waitlistEnabled')) },
  ],
  rowLabel: (r, refs) => labelOf(refs, 'services', text(r, 'serviceId')),
};

const PHI = /@|\d{9,}/;
export const BANNERS: ResourceSpec = {
  path: 'banners',
  title: s.banners,
  empty: s.bannersEmpty,
  change: 'PUT',
  removable: true,
  fields: [
    {
      name: 'surface',
      label: 'Where it shows',
      type: 'select',
      required: true,
      options: Object.entries(s.surfaces).map(([value, label]) => ({ value, label })),
    },
    {
      name: 'message',
      label: 'Notice',
      type: 'textarea',
      required: true,
      maxLength: 500,
      hint: s.bannerHint,
      check: (v) => (PHI.test(v) ? s.bannerPhi : undefined),
    },
    { name: 'startsAt', label: 'Starts', type: 'datetime', required: true },
    { name: 'endsAt', label: 'Ends', type: 'datetime', required: true },
  ],
  validate: (v) =>
    String(v['startsAt']) !== '' &&
    String(v['endsAt']) !== '' &&
    new Date(String(v['startsAt'])).getTime() >= new Date(String(v['endsAt'])).getTime()
      ? { endsAt: s.bannerOrder }
      : undefined,
  columns: () => [
    {
      key: 'surface',
      header: 'Where',
      render: (r) =>
        (s.surfaces as Record<string, string>)[text(r, 'surface')] ?? text(r, 'surface'),
    },
    { key: 'message', header: 'Notice', render: (r) => text(r, 'message') },
    { key: 'starts', header: 'Starts', render: (r) => fmtTime(text(r, 'startsAt')) },
    { key: 'ends', header: 'Ends', render: (r) => fmtTime(text(r, 'endsAt')) },
  ],
  rowLabel: (r) => text(r, 'message').slice(0, 40),
};
