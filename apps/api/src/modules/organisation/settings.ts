import { OrganisationValidationError } from './errors.js';

/** The value shapes of kernel.setting.value_schema used by the organisation catalogue. */
export type SettingSchema =
  | 'int>=0'
  | 'int>=1'
  | 'hours'
  | 'hours[]'
  | 'cidr[]'
  | 'enum(refuse|flag)'
  | 'waitlist_offer'
  | 'grace_minutes';

const isInt = (v: unknown, min: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= 1_000_000_000;
const CIDR =
  /^([0-9]{1,3}\.){3}[0-9]{1,3}\/([0-9]|[12][0-9]|3[0-2])$|^[0-9a-f:]+\/([0-9]|[1-9][0-9]|1[01][0-9]|12[0-8])$/i;

/** True when `value` has the shape `schema` names. */
export function matchesSchema(schema: string, value: unknown): boolean {
  switch (schema) {
    case 'int>=0':
      return isInt(value, 0);
    case 'int>=1':
      return isInt(value, 1);
    case 'hours':
      return isInt(value, 1) && value <= 24 * 366;
    case 'hours[]':
      return Array.isArray(value) && value.length > 0 && value.every((x) => isInt(x, 1));
    case 'cidr[]':
      return Array.isArray(value) && value.every((x) => typeof x === 'string' && CIDR.test(x));
    case 'enum(refuse|flag)':
      return value === 'refuse' || value === 'flag';
    case 'waitlist_offer': {
      const o = value as { default?: unknown; within_24h?: unknown } | null;
      return typeof o === 'object' && o !== null && isInt(o.default, 1) && isInt(o.within_24h, 1);
    }
    case 'grace_minutes': {
      const o = value as { default?: unknown; video?: unknown } | null;
      return typeof o === 'object' && o !== null && isInt(o.default, 0) && isInt(o.video, 0);
    }
    default:
      return false;
  }
}

export function assertMatchesSchema(schema: string, value: unknown, field = 'value'): void {
  if (!matchesSchema(schema, value)) throw new OrganisationValidationError([field]);
}
