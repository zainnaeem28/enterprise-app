import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { SimpleWebAuthnPort } from '../modules/identity/admin/webauthn.js';
import { SoftKey } from '../modules/identity/admin/softkey.js';
import { createAttestationFixture } from './attestation-ca.js';

const ORIGIN = 'https://staff.ci.example';
const RP = 'staff.ci.example';
const params = { rpId: RP, rpName: 'EHR admin', expectedOrigins: [ORIGIN] };

async function enrol(
  fx: ReturnType<typeof createAttestationFixture>,
  rootPem: string,
  aaguid = fx.aaguid,
) {
  const port = new SimpleWebAuthnPort(params, { mode: 'chain', rootCertificatesPem: [rootPem] });
  const challenge = randomBytes(32);
  const key = new SoftKey();
  const response = key.create(
    { challenge: challenge.toString('base64url') },
    { origin: ORIGIN, rpId: RP, aaguid, attestation: { x5c: fx.x5c, key: fx.leafKey } },
  );
  return { port, key, result: await port.verifyAttestation({ response, challenge }) };
}

describe('CI attestation fixture (INT04-F21)', () => {
  test('a packed attestation signed by the fixture leaf chains to the fixture root in the production verifier', async () => {
    const fx = createAttestationFixture();
    const { result } = await enrol(fx, fx.rootPem);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.key.aaguid, fx.aaguid);
      assert.equal(result.key.hasChain, true);
      assert.equal(result.key.fmt, 'packed');
    }
  });
  test('the enrolled key then signs in (assertion verifies with the stored public key)', async () => {
    const fx = createAttestationFixture();
    const { port, key, result } = await enrol(fx, fx.rootPem);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const challenge = randomBytes(32);
    const assertion = key.assert(
      { challenge: challenge.toString('base64url') },
      { origin: ORIGIN, rpId: RP },
    );
    const r = await port.verifyAssertion({
      assertion: {
        rawId: key.credentialId,
        response: { ...(assertion as object), clientExtensionResults: {} } as never,
      },
      challenge,
      publicKey: result.key.publicKey,
    });
    assert.equal(r.ok, true);
  });
  test("runs share nothing: another run's root does not validate this run's leaf", async () => {
    const a = createAttestationFixture();
    const b = createAttestationFixture();
    assert.notEqual(a.rootPem, b.rootPem);
    assert.equal((await enrol(a, b.rootPem)).result.ok, false);
  });
  test('without the chain the verifier refuses (self-attestation is not accepted in chain mode)', async () => {
    const fx = createAttestationFixture();
    const port = new SimpleWebAuthnPort(params, {
      mode: 'chain',
      rootCertificatesPem: [fx.rootPem],
    });
    const challenge = randomBytes(32);
    const response = new SoftKey().create(
      { challenge: challenge.toString('base64url') },
      { origin: ORIGIN, rpId: RP, aaguid: fx.aaguid },
    );
    assert.equal((await port.verifyAttestation({ response, challenge })).ok, false);
  });
  test('the module serialises no private key', () => {
    const fx = createAttestationFixture();
    assert.doesNotMatch(JSON.stringify({ ...fx, leafKey: undefined }), /PRIVATE KEY/);
    assert.match(fx.rootPem, /^-----BEGIN CERTIFICATE-----/);
  });
});
