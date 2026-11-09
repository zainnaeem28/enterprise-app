// Self-test of the browser half WITHOUT a database: a local page asks the fixture authenticator to enrol and sign in, and the
// production verifier (SimpleWebAuthnPort in `chain` mode, rooted only at the fixture root) checks both answers.
// Usage (CI): CI=true EHR_ADMIN_CI_FIXTURE=1 node scripts/ci/admin-fixture/selftest.mjs   [needs the browser from install-browser.sh]
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { createAdminFixture } from './index.mjs';
import { SimpleWebAuthnPort } from '../../../apps/api/dist/src/modules/identity/admin/webauthn.js';

const { chromium } = createRequire(`${process.cwd()}/apps/staff/package.json`)('@playwright/test');
const fx = createAdminFixture();
const server = createServer((_q, r) => r.end('<!doctype html><title>fixture</title>'));
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const origin = `http://127.0.0.1:${server.address().port}`;
const port = new SimpleWebAuthnPort(
  { rpId: '127.0.0.1', rpName: 'EHR admin', expectedOrigins: [origin] },
  { mode: 'chain', rootCertificatesPem: [fx.adminFixtureEnv().EHR_ADMIN_ATTESTATION_ROOTS_PEM] },
);
const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  const ctx = await browser.newContext();
  await fx.installAuthenticator(ctx, { origin, rpId: '127.0.0.1' });
  const page = await ctx.newPage();
  await page.goto(origin);
  const enrolChallenge = randomBytes(32);
  const created = await page.evaluate(async (c) => {
    const b = (s) =>
      Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (x) => x.charCodeAt(0));
    const u = (buf) =>
      btoa(String.fromCharCode(...new Uint8Array(buf)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge: b(c),
        rp: { name: 'x', id: '127.0.0.1' },
        user: { id: b('AQID'), name: 'a', displayName: 'a' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      },
    });
    return {
      id: cred.id,
      rawId: u(cred.rawId),
      type: cred.type,
      response: {
        clientDataJSON: u(cred.response.clientDataJSON),
        attestationObject: u(cred.response.attestationObject),
        transports: cred.response.getTransports(),
      },
    };
  }, enrolChallenge.toString('base64url'));
  const enrolled = await port.verifyAttestation({ response: created, challenge: enrolChallenge });
  assert.equal(enrolled.ok, true, 'enrolment must verify against the fixture root');
  const signChallenge = randomBytes(32);
  const asserted = await page.evaluate(
    async ({ c, id }) => {
      const b = (s) =>
        Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (x) => x.charCodeAt(0));
      const u = (buf) =>
        btoa(String.fromCharCode(...new Uint8Array(buf)))
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '');
      const cred = await navigator.credentials.get({
        publicKey: {
          challenge: b(c),
          rpId: '127.0.0.1',
          allowCredentials: [{ type: 'public-key', id: b(id) }],
          userVerification: 'required',
        },
      });
      const r = cred.response;
      return {
        id: cred.id,
        rawId: u(cred.rawId),
        type: cred.type,
        response: {
          clientDataJSON: u(r.clientDataJSON),
          authenticatorData: u(r.authenticatorData),
          signature: u(r.signature),
        },
      };
    },
    { c: signChallenge.toString('base64url'), id: created.id },
  );
  const signed = await port.verifyAssertion({
    assertion: {
      rawId: Buffer.from(created.rawId, 'base64url'),
      response: { ...asserted, clientExtensionResults: {} },
    },
    challenge: signChallenge,
    publicKey: enrolled.key.publicKey,
  });
  assert.equal(signed.ok, true, 'sign-in must verify with the enrolled key');
  console.log(
    'admin CI fixture self-test: enrolment (chain to fixture root) and sign-in verified in headless Chromium',
  );
} finally {
  await browser.close();
  server.close();
}
