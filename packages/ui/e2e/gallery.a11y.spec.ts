// Full-browser axe run (WCAG 2.0/2.1/2.2 A and AA tags, including colour-contrast and target-size) over the gallery
// at desktop and phone widths, for every portal accent and every dialog; also writes candidate screenshots.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const PORTALS = ['doctor', 'patient', 'pre-consultation', 'pharmacy', 'admin'];
const DIALOGS = ['confirm', 'sign', 'btg', 'session-warning', 'session-ended', 'passkey', 'reauth'];
const VIEWPORTS = [
  { name: 'desktop', width: 1360, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

async function scan(page: import('@playwright/test').Page) {
  const r = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return r.violations.map(
    (v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
  );
}

for (const vp of VIEWPORTS) {
  test.describe(vp.name, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });
    for (const portal of PORTALS) {
      test(`gallery, ${portal} accent`, async ({ page }) => {
        await page.goto(`/?portal=${portal}`);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        expect(await scan(page)).toEqual([]);
        await page.screenshot({
          path: `dist-reports/screens/${vp.name}-${portal}.png`,
          fullPage: true,
        });
      });
    }
    for (const d of DIALOGS) {
      test(`dialog ${d}`, async ({ page }) => {
        await page.goto(`/?portal=doctor&dialog=${d}`);
        await expect(page.getByRole('alertdialog')).toBeVisible();
        expect(await scan(page)).toEqual([]);
        await page.screenshot({ path: `dist-reports/screens/${vp.name}-dialog-${d}.png` });
      });
    }
  });
}

test('focus is visible and not removed on a keyboard tab stop', async ({ page }) => {
  await page.goto('/?portal=doctor');
  await page.keyboard.press('Tab');
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle);
  expect(outline).not.toBe('none');
});

test('reflows at 320 px without horizontal page scroll (1.4.10)', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto('/?portal=doctor');
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
