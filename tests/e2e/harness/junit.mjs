// Minimal JUnit XML writer and reader used by the harness (no dependency). Escapes everything it writes.
const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

/**
 * @param {{name: string, properties?: Record<string,string>, cases: {classname: string, name: string, time?: number, status: 'passed'|'failed'|'error'|'skipped', message?: string}[]}} suite
 */
export function junitXml(suite) {
  const c = suite.cases;
  const count = (s) => c.filter((x) => x.status === s).length;
  const props = Object.entries(suite.properties ?? {})
    .map(([k, v]) => `    <property name="${esc(k)}" value="${esc(v)}"/>`)
    .join('\n');
  const body = c
    .map((x) => {
      const inner =
        x.status === 'failed'
          ? `<failure message="${esc(x.message ?? '')}"/>`
          : x.status === 'error'
            ? `<error message="${esc(x.message ?? '')}"/>`
            : x.status === 'skipped'
              ? '<skipped/>'
              : '';
      return `  <testcase classname="${esc(x.classname)}" name="${esc(x.name)}" time="${(x.time ?? 0).toFixed(3)}">${inner}</testcase>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
<testsuite name="${esc(suite.name)}" tests="${c.length}" failures="${count('failed')}" errors="${count('error')}" skipped="${count('skipped')}">
  <properties>
${props}
  </properties>
${body}
</testsuite>
</testsuites>
`;
}

/** Counts from a JUnit file, by element, not from the root attributes (a tool may write them wrongly). */
export function junitCounts(xml) {
  const n = (re) => (xml.match(re) ?? []).length;
  const tests = n(/<testcase\b/g);
  const failures = n(/<failure\b/g);
  const errors = n(/<error\b/g);
  const skipped = n(/<skipped\b/g);
  return { tests, failures, errors, skipped, passed: tests - failures - errors - skipped };
}

/** Throws unless the file has at least `minTests` executed cases and no failure, error or skip. Returns the counts. */
export function assertJunitGreen(xml, { minTests = 1, allowSkipped = false } = {}) {
  const c = junitCounts(xml);
  const problems = [];
  if (c.tests < minTests)
    problems.push(`${c.tests} test case(s) < required ${minTests} (an empty run fails)`);
  if (c.failures + c.errors > 0) problems.push(`${c.failures + c.errors} failing case(s)`);
  if (!allowSkipped && c.skipped > 0) problems.push(`${c.skipped} skipped case(s)`);
  if (problems.length) throw new Error(problems.join('; '));
  return c;
}
