/** The one brand source for every app: the organisation name (optional) and the neutral product title used when no name is set. */
export interface BrandConfig {
  name?: string | null | undefined;
}

/** The organisation name when one is entered; otherwise the neutral product title. Never an invented name. */
export function resolveBrandName(name: string | null | undefined, fallbackTitle: string): string {
  const trimmed = name?.trim();
  return trimmed === undefined || trimmed === '' ? fallbackTitle : trimmed;
}

/** A text wordmark of the configured brand name, in the current accessible palette. */
export function BrandWordmark({ name }: { name: string }) {
  return <span className="ehr-brand-wordmark">{name}</span>;
}
