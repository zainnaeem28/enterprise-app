/**
 * Minimal PostgreSQL lexical scanner for the migration rules.
 *
 * It does not parse SQL. It separates code from comments, string literals,
 * quoted identifiers and dollar-quoted bodies, so the rules in `rules.ts`
 * look at statement keywords and never at text inside a function body or a
 * string. A masked statement has the same length as its source text.
 */

export interface Statement {
  /** The statement as written, without the terminating semicolon. */
  readonly text: string;
  /** Comments, string contents, quoted identifiers and dollar bodies blanked. */
  readonly masked: string;
}

const blank = (s: string): string => s.replace(/[^\n]/g, ' ');

export function splitStatements(sql: string): Statement[] {
  const out: Statement[] = [];
  let text = '';
  let masked = '';
  let i = 0;
  const n = sql.length;

  const flush = (): void => {
    if (masked.trim() !== '') {
      const lead = masked.length - masked.trimStart().length;
      const len = masked.trim().length;
      out.push({ text: text.slice(lead, lead + len), masked: masked.slice(lead, lead + len) });
    }
    text = '';
    masked = '';
  };
  const take = (source: string, view: string = blank(source)): void => {
    text += source;
    masked += view;
  };

  while (i < n) {
    const c = sql[i] as string;
    const two = sql.slice(i, i + 2);

    if (two === '--') {
      const j = sql.indexOf('\n', i);
      const end = j < 0 ? n : j;
      take(sql.slice(i, end));
      i = end;
    } else if (two === '/*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql.startsWith('/*', j)) {
          depth++;
          j += 2;
        } else if (sql.startsWith('*/', j)) {
          depth--;
          j += 2;
        } else j++;
      }
      take(sql.slice(i, j));
      i = j;
    } else if (c === "'") {
      // E'..' strings treat a backslash as an escape; plain strings do not.
      const escape = /[eE]/.test(sql[i - 1] ?? '') && !/[A-Za-z0-9_$]/.test(sql[i - 2] ?? ' ');
      let j = i + 1;
      while (j < n) {
        if (escape && sql[j] === '\\') j += 2;
        else if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      const end = Math.min(j + 1, n);
      const source = sql.slice(i, end);
      take(source, "'" + blank(source.slice(1, -1)) + (source.length > 1 ? "'" : ''));
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '"' && sql[j + 1] === '"') j += 2;
        else if (sql[j] === '"') break;
        else j++;
      }
      const end = Math.min(j + 1, n);
      const source = sql.slice(i, end);
      // An identifier is replaced by a neutral word so it can never read as a keyword.
      take(source, 'x'.repeat(source.length));
      i = end;
    } else if (c === '$' && !/[A-Za-z0-9_]/.test(sql[i - 1] ?? ' ')) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
      if (m) {
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        const end = close < 0 ? n : close + tag.length;
        take(sql.slice(i, end), '$$' + blank(sql.slice(i + 2, end)));
        i = end;
      } else {
        take(c, c);
        i++;
      }
    } else if (c === ';') {
      flush();
      i++;
    } else {
      take(c, c);
      i++;
    }
  }
  flush();
  return out;
}
