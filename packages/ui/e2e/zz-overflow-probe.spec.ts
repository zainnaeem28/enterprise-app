// Throwaway diagnosis probe (FE01-OR-R3-01): lists elements whose right edge exceeds the 320 px viewport.
import { test } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';

test('probe overflow at 320 px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto('/?portal=doctor');
  const data = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out: object[] = [];
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > vw + 0.5) {
        const cs = getComputedStyle(el);
        out.push({
          tag: el.tagName.toLowerCase(),
          cls: (el.getAttribute('class') ?? '').slice(0, 80),
          id: el.id,
          left: Math.round(r.left),
          right: Math.round(r.right),
          width: Math.round(r.width),
          display: cs.display,
          position: cs.position,
          minWidth: cs.minWidth,
          width_css: cs.width,
          overflowX: cs.overflowX,
          path: (() => {
            const p: string[] = [];
            let n: Element | null = el;
            while (n && p.length < 5) {
              p.push(n.tagName.toLowerCase() + (n.getAttribute('class') ? '.' + n.getAttribute('class')!.split(' ')[0] : ''));
              n = n.parentElement;
            }
            return p.join(' < ');
          })(),
          text: (el.textContent ?? '').trim().slice(0, 40),
        });
      }
    }
    return {
      vw,
      scrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      count: out.length,
      out,
    };
  });
  mkdirSync('dist-reports', { recursive: true });
  writeFileSync('dist-reports/overflow-probe.json', JSON.stringify(data, null, 2));
  console.log('PROBE ' + JSON.stringify(data));
});
