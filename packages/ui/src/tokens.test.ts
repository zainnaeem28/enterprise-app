// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = fileURLToPath(new URL('.', import.meta.url));
const read = (f: string) => readFileSync(dir + f, 'utf8');
const tokensCss = read('tokens.css');

/** Value of a custom property inside a rule whose selector contains `selector`. */
function tokenIn(selector: string, name: string): string | undefined {
  for (const m of tokensCss.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const sel = (m[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (selector === ':root' ? sel !== ':root' : !sel.includes(selector)) continue;
    const hit = new RegExp(`--${name}:\\s*([^;]+);`).exec(m[2] ?? '');
    if (hit) return hit[1]?.trim();
  }
  return undefined;
}
const root = (n: string) => {
  const v = tokenIn(':root', n);
  if (v === undefined) throw new Error(`token --${n} missing`);
  return v;
};

function lum(hex: string) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [
    number,
    number,
    number,
  ];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function ratio(a: string, b: string) {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('tokens meet WCAG 2.2 AA (1.4.3, 1.4.11)', () => {
  const text: Array<[string, string]> = [
    ['ink', 'bg'],
    ['ink', 'surface'],
    ['muted', 'bg'],
    ['muted', 'surface'],
    ['danger', 'surface'],
    ['danger', 'danger-tint'],
    ['warning', 'warning-tint'],
    ['success', 'success-tint'],
    ['info', 'info-tint'],
    ['on-accent', 'danger'],
    ['on-accent', 'realm-admin'],
    ['disabled-ink', 'disabled-bg'],
    ['ink', 'accent-tint'],
  ];
  it.each(text)('text %s on %s >= 4.5:1', (fg, bg) => {
    const value = (n: string) =>
      n === 'accent-tint' ? tokenIn("[data-portal='doctor']", n)! : root(n);
    expect(ratio(value(fg), value(bg))).toBeGreaterThanOrEqual(4.5);
  });

  const nonText: Array<[string, string]> = [
    ['border-control', 'surface'],
    ['border-control', 'bg'],
    ['focus', 'surface'],
    ['focus', 'bg'],
  ];
  it.each(nonText)('UI component %s on %s >= 3:1', (fg, bg) => {
    expect(ratio(root(fg), root(bg))).toBeGreaterThanOrEqual(3);
  });

  const portals = ['patient', 'brand', 'pre-consultation', 'doctor', 'pharmacy', 'admin'];
  it.each(portals)(
    'portal %s accent: white on accent >= 4.5, accent on tint >= 4.5, accent on surface >= 3',
    (p) => {
      const sel = `[data-portal='${p}']`;
      const accent = tokenIn(sel, 'accent')!;
      const tint = tokenIn(sel, 'accent-tint')!;
      expect(ratio(root('on-accent'), accent)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(accent, tint)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(accent, root('surface'))).toBeGreaterThanOrEqual(3);
    },
  );

  it('portal accents are distinct from each other (except brand/patient) and from danger', () => {
    const accents = portals
      .filter((p) => p !== 'brand')
      .map((p) => tokenIn(`[data-portal='${p}']`, 'accent'));
    expect(new Set(accents).size).toBe(accents.length);
    expect(accents).not.toContain(root('danger'));
  });
});

describe('swapping tokens needs no component change', () => {
  const sources = readdirSync(dir).filter(
    (f) => /\.(tsx|css)$/.test(f) && !/(tokens|test)/.test(f),
  );
  it.each(sources)('%s has no literal colour values', (f) => {
    const src = read(f).replace(/\/\*[\s\S]*?\*\//g, '');
    expect(src.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g) ?? []).toEqual([]);
  });
  it('the focus ring is not removed anywhere', () => {
    for (const f of sources) expect(read(f)).not.toMatch(/outline:\s*(none|0)\b/);
  });
});

describe('contrast helper', () => {
  it('matches known values', () => {
    expect(ratio('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(ratio('#1b2430', '#ffffff')).toBeCloseTo(15.65, 1);
  });
});
