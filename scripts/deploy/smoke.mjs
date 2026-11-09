#!/usr/bin/env node
// Smoke checks after rollout (DEVOPS-PLAN 9.1, 11.4). Anonymous GETs only: liveness, readiness and the portal
// release.json. Never sends or reads patient data; the body of /readyz is checked for shape, not logged.
//   smoke.mjs --api-url https://staff.example --portal-url https://staff.example --release-number 23 [--retries 10]
import { args, isMain, main } from './lib/cli.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function check(name, fn, retries, delayMs) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try {
      await fn();
      console.log(`ok   ${name}`);
      return;
    } catch (e) {
      last = e;
      if (i < retries) await sleep(delayMs);
    }
  }
  throw new Error(`smoke check "${name}" failed: ${last.message}`);
}

export const expectReleaseJson = (j, releaseNumber) => {
  if (j?.release_number !== releaseNumber)
    throw new Error(`release.json says ${j?.release_number}, expected ${releaseNumber}`);
  if (typeof j.git_sha12 !== 'string') throw new Error('release.json has no git_sha12');
};

if (isMain(import.meta.url))
  main(async () => {
    const a = args(process.argv.slice(2), {
      'api-url': 'required',
      'portal-url': 'required',
      'release-number': 'required',
      retries: 'optional',
    });
    const n = Number(a['release-number']);
    const r = Number(a.retries ?? 10);
    const get = async (u) => {
      const res = await fetch(u, {
        redirect: 'manual',
        headers: { 'cache-control': 'no-cache' },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status !== 200) throw new Error(`${u} -> HTTP ${res.status}`);
      return res;
    };
    await check('liveness /healthz', () => get(`${a['api-url']}/healthz`), r, 15_000);
    await check(
      'readiness /readyz (deploy gating only)',
      async () => {
        const body = await (await get(`${a['api-url']}/readyz`)).text();
        if (body.length > 4096) throw new Error('readyz body unexpectedly large');
      },
      r,
      15_000,
    );
    await check(
      'portal release.json matches the manifest',
      async () => expectReleaseJson(await (await get(`${a['portal-url']}/release.json`)).json(), n),
      r,
      30_000,
    );
  });
