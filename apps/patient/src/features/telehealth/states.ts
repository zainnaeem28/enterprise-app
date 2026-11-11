// The states a patient can pick from come from deployment configuration (`VITE_OPERATING_STATES`), never from a list in the code.
// Format: comma-separated `CODE=Name` pairs, e.g. `AA=State A,BB=State B`. The server stays authoritative on which are operating
// and licensed states (TL-1); this list only fills the dropdown. Empty or unset: the page asks for the two-letter code instead.
export type StateOption = readonly [code: string, name: string];

export function parseStates(raw: string | undefined): StateOption[] {
  if (raw === undefined) return [];
  const out: StateOption[] = [];
  for (const part of raw.split(',')) {
    const [code, ...name] = part.split('=');
    const c = code?.trim().toUpperCase() ?? '';
    if (/^[A-Z]{2}$/.test(c)) out.push([c, name.join('=').trim() || c]);
  }
  return out;
}

export const configuredStates = (): StateOption[] =>
  parseStates(import.meta.env['VITE_OPERATING_STATES'] as string | undefined);
