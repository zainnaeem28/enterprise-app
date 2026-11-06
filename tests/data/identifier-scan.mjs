// TC-NFR-09: scan seed data for patterns that look like real identifiers. Synthetic values are allowed only in reserved
// ranges (NANP 555-01xx, `.invalid` / `.test` domains, no SSN-shaped numbers, Luhn-valid card numbers or real-looking IPs).
const luhn = (digits) => {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt && (d *= 2) > 9) d -= 9;
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
};

/** @returns {{rule: string, sample: string}[]} findings; a sample is truncated and never a full value. */
export function scanText(text) {
  const out = [];
  const add = (rule, m) => out.push({ rule, sample: `${m.slice(0, 4)}…(${m.length})` });
  for (const m of text.matchAll(/\b\d{3}-\d{2}-\d{4}\b/g)) add('ssn-shaped', m[0]);
  for (const m of text.matchAll(/\b(?:\d[ -]?){13,19}\b/g)) {
    const digits = m[0].replace(/[ -]/g, '');
    if (digits.length >= 13 && luhn(digits)) add('card-number', m[0]);
  }
  for (const m of text.matchAll(/(?:\+?1[-. ]?)?\(?\b(\d{3})\)?[-. ](\d{3})[-. ](\d{4})\b/g)) {
    if (!(m[2] === '555' && m[3].startsWith('01'))) add('phone-outside-reserved-range', m[0]);
  }
  for (const m of text.matchAll(/\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g)) {
    const host = m[1].toLowerCase();
    if (
      !/\.(invalid|test|example)$/.test(host) &&
      !['example.com', 'example.org', 'example.net'].includes(host)
    )
      add('email-on-real-domain', m[0]);
  }
  return out;
}

export const scanJson = (value) => scanText(JSON.stringify(value));
