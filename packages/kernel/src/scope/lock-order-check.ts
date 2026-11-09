// Static checks (38.2 item 4, 21.3), source-text based so they need no compiler dependency:
//  - lock order: inside every `withScope(...)` / `withSignInScope(...)` call, the first call of a
//    `patient_scope_owner` function must come after `lockPatients(`; and no such call may sit outside a scope call;
//  - sign-in setter: `setAuthIdentity(` / `withSignInScope(` may be used only in the files the caller allows.
// Strings and comments are blanked first so a mention in a comment or message neither passes nor fails a file.

import { PATIENT_SCOPE_OWNER_FUNCTIONS } from './with-scope.js';

export interface Violation {
  file: string;
  line: number;
  rule: 'lock-order' | 'outside-scope' | 'signin-setter';
  message: string;
}

/** Blank comments; keep string contents (SQL names live in strings) but drop line/column shifts. */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (quote !== null) {
      out += c;
      if (c === '\\' && quote !== '`') {
        out += n ?? '';
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
    } else if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') {
        out += ' ';
        i++;
      }
    } else if (c === '/' && n === '*') {
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += '  ';
      i += 2;
    } else {
      if (c === '"' || c === "'" || c === '`') quote = c;
      out += c;
      i++;
    }
  }
  return out;
}

function lineOf(src: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (src[i] === '\n') line++;
  return line;
}

/** Span of the balanced parentheses that open at `open` (index of '('). Strings are skipped. */
function spanOfCall(src: string, open: number): [number, number] {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (quote !== null) {
      if (c === '\\' && quote !== '`') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return [open, i];
  }
  return [open, src.length];
}

const SCOPE_CALL = /\b(?:withScope|withSignInScope)\s*(?:<[^>()]*>)?\s*\(/g;

export function checkLockOrder(
  file: string,
  source: string,
  owners: readonly string[] = PATIENT_SCOPE_OWNER_FUNCTIONS,
): Violation[] {
  const src = stripComments(source);
  const out: Violation[] = [];
  const spans: [number, number][] = [];
  for (const m of src.matchAll(SCOPE_CALL)) spans.push(spanOfCall(src, m.index + m[0].length - 1));

  const ownerRe = new RegExp(
    `(?<![A-Za-z0-9_.])(${owners.map((o) => o.replace('.', '\\.')).join('|')})(?![A-Za-z0-9_])`,
    'g',
  );
  const ownerCalls = [...src.matchAll(ownerRe)];
  const spanOf = (idx: number): [number, number] | undefined =>
    spans.find(([a, b]) => idx > a && idx < b);

  for (const m of ownerCalls) {
    const span = spanOf(m.index);
    if (span === undefined) {
      out.push({
        file,
        line: lineOf(src, m.index),
        rule: 'outside-scope',
        message: `${m[1]} used outside a withScope callback`,
      });
    }
  }
  for (const [a, b] of spans) {
    const body = src.slice(a, b);
    const first = ownerCalls.find((m) => m.index > a && m.index < b);
    if (first === undefined) continue;
    const lock = body.search(/\b(?:lockPatients|lockReferralPatient|lockForReferral)\s*\(/);
    if (lock < 0 || a + lock > first.index) {
      out.push({
        file,
        line: lineOf(src, first.index),
        rule: 'lock-order',
        message: `${first[1]} is called before lockPatients (25.2 rule 1)`,
      });
    }
  }
  return out;
}

export function checkSignInCallSites(
  file: string,
  source: string,
  allowed: (file: string) => boolean,
): Violation[] {
  if (allowed(file)) return [];
  const src = stripComments(source);
  const out: Violation[] = [];
  for (const m of src.matchAll(/\b(setAuthIdentity|withSignInScope|applyAuthIdentity)\s*\(/g)) {
    out.push({
      file,
      line: lineOf(src, m.index),
      rule: 'signin-setter',
      message: `${m[1]} used outside the identity sign-in handlers (21.3)`,
    });
  }
  return out;
}
