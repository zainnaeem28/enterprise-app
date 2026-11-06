// What every result records (DEVOPS-PLAN 5.3): tool versions, candidate commit, environment name, command.
import { execFileSync } from 'node:child_process';

/** QA environment names of TEST-CASES 0.3. Only `ENV-INT/ci` is wired by this ticket; others are named so a result cannot claim a wrong binding. */
export const ENVIRONMENTS = {
  'ENV-INT/ci': { production: false, localOnly: true },
  'ENV-INT/staging': { production: false, localOnly: false },
  'ENV-INT/bootstrap': { production: false, localOnly: false },
  'ENV-LOAD': { production: false, localOnly: false },
  'ENV-DR': { production: false, localOnly: false },
  'ENV-A11Y': { production: false, localOnly: false },
};

export function requireEnvironment(name) {
  if (!name)
    throw new Error(
      'QA_ENVIRONMENT is required (for example ENV-INT/ci); "ENV-INT" alone is not a valid binding',
    );
  if (!(name in ENVIRONMENTS))
    throw new Error(
      `unknown QA environment ${JSON.stringify(name)}; valid: ${Object.keys(ENVIRONMENTS).join(', ')}`,
    );
  return name;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Refuses a target that the environment does not allow. `ENV-INT/ci` runs only against loopback or a CI service
 * container; nothing here may point at production (TEST-CASES 0.3, DEVOPS-PLAN 5.3). Production hosts are named by
 * QA_FORBIDDEN_HOSTS (comma-separated, set by the environment) as a second guard.
 */
export function assertTargetAllowed(environment, url, env = process.env) {
  requireEnvironment(environment);
  const host = new URL(url).hostname.toLowerCase();
  const forbidden = (env.QA_FORBIDDEN_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (forbidden.some((h) => host === h || host.endsWith(`.${h}`)))
    throw new Error(`target ${host} is a forbidden (production) host`);
  if (
    ENVIRONMENTS[environment].localOnly &&
    !LOOPBACK.has(host) &&
    env.QA_CI_SERVICE_HOSTS?.split(',')
      .map((h) => h.trim())
      .includes(host) !== true
  )
    throw new Error(
      `${environment} may only target loopback or hosts listed in QA_CI_SERVICE_HOSTS; got ${host}`,
    );
}

const sh = (cmd, args, opts = {}) => {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      ...opts,
    }).trim();
  } catch {
    return null;
  }
};

/** Version string of a tool, or null if it is not installed (the caller decides whether that is fatal). */
export const toolVersion = (cmd, args = ['--version']) => sh(cmd, args);

export function candidateCommit(env = process.env, cwd = process.cwd()) {
  const c = env.QA_CANDIDATE_COMMIT || env.GITHUB_SHA || sh('git', ['rev-parse', 'HEAD'], { cwd });
  if (!c || !/^[0-9a-f]{40}$/.test(c))
    throw new Error(
      'candidate commit unknown: set QA_CANDIDATE_COMMIT to the 40-character commit under test',
    );
  return c;
}

export function runMeta({ environment, command, tools, env = process.env, cwd = process.cwd() }) {
  return {
    environment: requireEnvironment(environment),
    candidateCommit: candidateCommit(env, cwd),
    command,
    node: process.version,
    tools,
    startedAt: new Date().toISOString(),
  };
}
