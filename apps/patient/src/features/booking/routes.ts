export type BookingRoute =
  | { name: 'appointments' }
  | { name: 'detail'; id: string }
  | { name: 'change'; id: string }
  | { name: 'change-confirm'; id: string }
  | { name: 'cancel'; id: string }
  | { name: 'service' }
  | { name: 'doctor' }
  | { name: 'time' }
  | { name: 'confirm' }
  | { name: 'done'; id: string }
  | { name: 'waitlist' }
  | { name: 'offer'; id: string };

const ID = '([0-9a-fA-F-]{8,64})';
const TABLE: Array<[RegExp, (m: RegExpExecArray) => BookingRoute]> = [
  [/^\/appointments\/?$/, () => ({ name: 'appointments' })],
  [new RegExp(`^/appointments/${ID}/?$`), (m) => ({ name: 'detail', id: m[1] ?? '' })],
  [new RegExp(`^/appointments/${ID}/change/?$`), (m) => ({ name: 'change', id: m[1] ?? '' })],
  [
    new RegExp(`^/appointments/${ID}/change/confirm/?$`),
    (m) => ({ name: 'change-confirm', id: m[1] ?? '' }),
  ],
  [new RegExp(`^/appointments/${ID}/cancel/?$`), (m) => ({ name: 'cancel', id: m[1] ?? '' })],
  [/^\/book\/?$/, () => ({ name: 'service' })],
  [/^\/book\/doctor\/?$/, () => ({ name: 'doctor' })],
  [/^\/book\/time\/?$/, () => ({ name: 'time' })],
  [/^\/book\/confirm\/?$/, () => ({ name: 'confirm' })],
  [new RegExp(`^/book/done/${ID}/?$`), (m) => ({ name: 'done', id: m[1] ?? '' })],
  [/^\/waitlist\/join\/?$/, () => ({ name: 'waitlist' })],
  [new RegExp(`^/waitlist/offers/${ID}/?$`), (m) => ({ name: 'offer', id: m[1] ?? '' })],
];

/** Routes carry opaque ids only, never a name or a date of birth (UX-R4). */
export function matchBookingRoute(path: string): BookingRoute | undefined {
  for (const [re, make] of TABLE) {
    const m = re.exec(path);
    if (m !== null) return make(m);
  }
  return undefined;
}

export const isBookingPath = (path: string): boolean => matchBookingRoute(path) !== undefined;
