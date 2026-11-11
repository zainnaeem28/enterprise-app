// Shared axe-core runner for component tests (jsdom: no stylesheet, so colour-contrast and target-size run in e2e/).
import axe from 'axe-core';

export async function violations(root: HTMLElement = document.body): Promise<string[]> {
  const r = await axe.run(root, {
    runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  });
  return r.violations.map(
    (v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target).join(', ')}`,
  );
}
