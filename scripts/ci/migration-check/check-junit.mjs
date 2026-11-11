#!/usr/bin/env node
// Empty-suite guard for the database jobs. Reads JUnit XML (node:test --test-reporter=junit) from a directory and
// fails on: no report, a report with zero test cases, any failure/error, any skipped or todo test.
//   check-junit.mjs [--pins <tsv> --catalog <catalog-lists.mjs> [--report <file>]] <dir> <suiteName>...
//     every named suite must have <dir>/<suiteName>.xml
// Expected pin failures (HEAAA-739 Q1 (d), n-minus-1-pins.tsv): a previous-release test that asserts the literal size of
// the definer catalog is run, and its failure is accepted ONLY when it is exactly that assertion (strictEqual, expected =
// the recorded literal, actual = the candidate catalog size and greater, first stack frame in the test file = the recorded
// path:line). Any other failure of a listed test fails; so does a listed test that passes (stale entry).
// Schema-growth list pins (HEAAA-914, amends Q1 (d)): kind `growth:<name>,<name>...` in the literal column. The failure is accepted
// ONLY when it is one deepStrictEqual AssertionError at the recorded path:line whose actual and expected are lists of strings,
// where actual is expected plus exactly the pin's added names (nothing removed, nothing else added, order of the rest unchanged).
// GROWTH_ALLOWED limits growth pins to two named tests and the HEAAA-791 names; remove the pins and this table when the baseline
// tag advances past HEAAA-791.
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = {};
while (args[0]?.startsWith('--')) opt[args.shift().slice(2)] = args.shift();
const [dir, ...names] = args;
if (!dir || names.length === 0 || (opt.pins && !opt.catalog)) {
  console.error(
    'usage: check-junit.mjs [--pins <tsv> --catalog <catalog-lists.mjs> [--report <file>]] <dir> <suite>...',
  );
  process.exit(2);
}

const unesc = (s) =>
  s
    .replace(/&#(x[0-9a-fA-F]+|\d+);/g, (_, n) =>
      String.fromCodePoint(n[0] === 'x' ? parseInt(n.slice(1), 16) : Number(n)),
    )
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
const attr = (a, k) => {
  const m = new RegExp(`(?:^|\\s)${k}="([^"]*)"`).exec(a);
  return m ? unesc(m[1]) : '';
};

let pins = [];
let candidateSize = 0;
if (opt.pins) {
  candidateSize = (await import(pathToFileURL(opt.catalog).href)).definerInventory.length;
  pins = readFileSync(opt.pins, 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const [suite, name, loc, literal] = l.split('\t');
      const i = loc.lastIndexOf(':');
      const growth = literal.startsWith('growth:')
        ? literal.slice('growth:'.length).split(',')
        : null;
      return {
        suite,
        name,
        path: loc.slice(0, i),
        line: loc.slice(i + 1),
        literal,
        growth,
        used: false,
      };
    });
}

const GROWTH_ALLOWED = {
  'every identity table has ENABLE and FORCE row level security, a data class and no PUBLIC policy':
    ['proxy_invite_code'],
  'app_api has no UPDATE of identity columns beyond the 21.2 list; app_worker none on principal or person':
    ['accepted_at', 'ended_by', 'proxy_principal_id', 'scopes'],
};

// A node inspect list of strings -> the strings, or null when it holds anything else (numbers, objects, '... more items').
function stringList(body) {
  const rest = body.replace(/'((?:[^'\\]|\\.)*)'/g, '').replace(/[\s,]/g, '');
  if (rest !== '') return null;
  return [...body.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]);
}

function growthFailure(pin, body) {
  const allowed = GROWTH_ALLOWED[pin.name];
  const added = [...pin.growth].sort();
  if (!allowed || JSON.stringify(added) !== JSON.stringify([...allowed].sort())) {
    return `growth pin is not one of the allowed HEAAA-791 growth pins`;
  }
  const text = unesc(body);
  const cause = text.slice(text.indexOf('cause:'));
  if (!/cause: AssertionError/.test(cause)) return `not an AssertionError`;
  if (!/operator: 'deepStrictEqual'/.test(cause)) return `operator is not deepStrictEqual`;
  const lists = {};
  for (const k of ['actual', 'expected']) {
    const found = [...cause.matchAll(new RegExp(`\\n\\s+${k}: \\[([^\\]]*)\\],?\\n`, 'g'))];
    if (found.length !== 1) return `${k} is not exactly one list`;
    lists[k] = stringList(found[0][1]);
    if (!lists[k]) return `${k} is not a list of strings`;
  }
  const { actual, expected } = lists;
  const extra = actual.filter((x) => !expected.includes(x));
  if (JSON.stringify([...extra].sort()) !== JSON.stringify(added)) {
    return `added names [${extra}] are not exactly the pinned [${added}]`;
  }
  if (new Set(actual).size !== actual.length || new Set(expected).size !== expected.length)
    return `duplicate entries`;
  if (JSON.stringify(actual.filter((x) => expected.includes(x))) !== JSON.stringify(expected)) {
    return `an expected entry is missing or reordered`;
  }
  const frame = /\n\s+at [^\n]*?\(?(?:file:\/\/)?([^\s():]+):(\d+):\d+\)?/.exec(cause);
  if (!frame || !frame[1].endsWith(`/${pin.path}`) || frame[2] !== pin.line) {
    return `first frame ${frame ? `${frame[1]}:${frame[2]}` : '(none)'} is not ${pin.path}:${pin.line}`;
  }
  return null;
}

// The failure is the pin when it is one AssertionError, strictEqual, expected literal, actual candidate size, at path:line.
function pinFailure(pin, body) {
  const text = unesc(body);
  const cause = text.slice(text.indexOf('cause:'));
  if (!/cause: AssertionError/.test(cause)) return `not an AssertionError`;
  // assert.strictEqual reports 'strictEqual'; assert.equal (I-10 at r206) reports '==', the same comparison for two integers.
  if (!/operator: '(strictEqual|==)'/.test(cause)) return `operator is neither strictEqual nor ==`;
  const exp = /expected: (\d+),/.exec(cause)?.[1];
  const act = /actual: (\d+),/.exec(cause)?.[1];
  if (exp !== pin.literal) return `expected ${exp} is not the recorded literal ${pin.literal}`;
  if (Number(act) !== candidateSize || candidateSize <= Number(pin.literal)) {
    return `actual ${act} is not the candidate catalog size ${candidateSize} (greater than ${pin.literal})`;
  }
  const frame = /\n\s+at [^\n]*?\(?(?:file:\/\/)?([^\s():]+):(\d+):\d+\)?/.exec(cause);
  if (!frame || !frame[1].endsWith(`/${pin.path}`) || frame[2] !== pin.line) {
    return `first frame ${frame ? `${frame[1]}:${frame[2]}` : '(none)'} is not ${pin.path}:${pin.line}`;
  }
  return null;
}

let bad = 0;
let total = 0;
for (const n of names) {
  const f = join(dir, `${n}.xml`);
  if (!existsSync(f)) {
    console.error(`::error::suite ${n}: report ${f} is missing (the suite did not run)`);
    bad++;
    continue;
  }
  const xml = readFileSync(f, 'utf8');
  const tests = (xml.match(/<testcase\b/g) ?? []).length;
  const skipped = (xml.match(/<skipped\b/g) ?? []).length;
  let failed = 0;
  let accepted = 0;
  for (const m of xml.matchAll(
    /<testcase\b((?:[^>"]|"[^"]*")*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g,
  )) {
    const body = m[2] ?? '';
    const name = attr(m[1], 'name');
    const file = attr(m[1], 'file');
    const pin = pins.find(
      (p) => p.suite === n && p.name === name && file.endsWith(`/${p.path}`) && !p.used,
    );
    const isFail = /<(failure|error)\b/.test(body);
    if (pin) pin.used = true;
    if (!isFail) {
      if (pin) {
        console.error(
          `::error::N-1 PIN is stale: [${n}] ${name} passes; remove it from n-minus-1-pins.tsv`,
        );
        bad++;
      }
      continue;
    }
    const why = !pin
      ? 'not a listed pin'
      : pin.growth
        ? growthFailure(pin, body)
        : pinFailure(pin, body);
    if (pin && !why) {
      accepted++;
      const found = pin.growth
        ? `candidate adds ${pin.growth.join(',')}`
        : `expected ${pin.literal}, actual ${candidateSize}`;
      console.log(
        `::notice::N-1 PIN (not a pass) [${n}] ${name} -- ${found} at ${pin.path}:${pin.line}`,
      );
      if (opt.report) {
        appendFileSync(
          opt.report,
          `${n}\t${name}\t${pin.path}:${pin.line}\t${pin.literal}\t${pin.growth ? pin.growth.join(',') : candidateSize}\n`,
        );
      }
    } else {
      failed++;
      if (pin) console.error(`::error::N-1 PIN does not match [${n}] ${name}: ${why}`);
    }
  }
  total += tests;
  console.log(
    `${n}: ${tests} test(s), ${failed} failure(s), ${skipped} skipped${accepted ? `, ${accepted} accepted pin failure(s)` : ''}`,
  );
  if (tests === 0) {
    console.error(`::error::suite ${n} ran zero tests (an empty suite fails)`);
    bad++;
  }
  if (failed > 0) {
    console.error(`::error::suite ${n} has ${failed} failing test(s)`);
    bad++;
  }
  if (skipped > 0) {
    console.error(`::error::suite ${n} skipped ${skipped} test(s) (a skipped test fails)`);
    bad++;
  }
}
for (const p of pins.filter((p) => !p.used && names.includes(p.suite))) {
  console.error(`::error::N-1 PIN was not run: [${p.suite}] ${p.name}`);
  bad++;
}
console.log(`database suites: ${names.length} suite(s), ${total} test(s)`);
process.exit(bad === 0 ? 0 : 1);
