/** The one path this feature serves. It carries no record identifier. */
export const AVAILABILITY_PATHS = ['/availability'] as const;
export type AvailabilityPath = (typeof AVAILABILITY_PATHS)[number];
export const isAvailabilityPath = (path: string): path is AvailabilityPath =>
  (AVAILABILITY_PATHS as readonly string[]).includes(path);
