export { ageOf, timeOf } from '../preconsult/format.js';
export const dateTimeOf = (iso: string): string => {
  const t = new Date(iso);
  return Number.isNaN(t.getTime())
    ? ''
    : t.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
};
