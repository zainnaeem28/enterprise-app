// Tiny argument and output helpers shared by the deploy CLIs.
import { appendFileSync } from 'node:fs';

export function args(argv, spec) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) throw new Error(`unexpected argument ${k}`);
    const name = k.slice(2);
    if (!(name in spec)) throw new Error(`unknown option ${k}`);
    if (spec[name] === 'flag') out[name] = true;
    else out[name] = argv[++i];
  }
  for (const [n, t] of Object.entries(spec))
    if (t === 'required' && !out[n]) throw new Error(`--${n} is required`);
  return out;
}

/** GitHub step outputs, plus stdout for logs. Values are never secrets (hashes, ARNs, numbers). */
export function setOutput(name, value) {
  const v = String(value);
  if (/[\r\n]/.test(v)) throw new Error(`output ${name} has a newline`);
  console.log(`${name}=${v}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${v}\n`);
}

export function main(fn) {
  Promise.resolve()
    .then(fn)
    .catch((e) => {
      console.error(`::error::${e.message}`);
      process.exit(1);
    });
}

import { pathToFileURL } from 'node:url';
/** True when the module is the process entry point (so tests can import pure helpers from a CLI file). */
export const isMain = (metaUrl) =>
  process.argv[1] && pathToFileURL(process.argv[1]).href === metaUrl;
