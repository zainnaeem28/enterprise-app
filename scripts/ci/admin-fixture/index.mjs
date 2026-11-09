// CI-only admin-realm WebAuthn fixture (INT04-F21). Lets a headless Chromium complete the REAL admin enrolment and sign-in against the
// real API, database and built staff app, without weakening the production configuration:
//   * a per-run synthetic attestation root + leaf is created IN MEMORY (apps/api/src/ci-fixture/attestation-ca.ts);
//   * the API is started with the normal variables EHR_ADMIN_ATTESTATION_ROOTS_PEM / EHR_ADMIN_ALLOWED_AAGUIDS holding only the
//     PUBLIC root certificate and the fixture AAGUID, plus EHR_ENV=ci and EHR_ADMIN_CI_FIXTURE=1 (`adminFixtureEnv`);
//   * in the browser, navigator.credentials.create/get are answered by a software authenticator whose keys live in this Node process
//     (`installAuthenticator`). Its attestations are signed by the fixture leaf, so the API's unchanged chain verifier accepts them.
// The API refuses these values unless EHR_ENV=ci AND EHR_ADMIN_CI_FIXTURE=1 (apps/api/src/admin-env.ts). Private keys are never
// written to disk, logged or put in the environment. Needs `pnpm build` first (it loads apps/api/dist).
import { randomBytes } from 'node:crypto';
import { createAttestationFixture } from '../../../apps/api/dist/src/ci-fixture/attestation-ca.js';
import { SoftKey } from '../../../apps/api/dist/src/modules/identity/admin/softkey.js';

const refuse = (why) => {
  throw new Error(`admin CI fixture refused: ${why}`);
};

/** Creates the per-run fixture. Refuses unless the caller is a CI run that asked for it by name. */
export function createAdminFixture(env = process.env) {
  if (env.CI !== 'true' && env.EHR_ADMIN_CI_FIXTURE_LOCAL !== '1') refuse('not a CI run (CI=true)');
  if (env.EHR_ENV !== undefined && env.EHR_ENV !== 'ci')
    refuse(`EHR_ENV=${env.EHR_ENV}, only ci is allowed`);
  if (env.EHR_ADMIN_CI_FIXTURE !== '1') refuse('EHR_ADMIN_CI_FIXTURE=1 is not set');
  const ca = createAttestationFixture();
  const keys = new Map(); // credential id (base64url) -> SoftKey; lives only in this process

  return {
    /** Public values for the API process. Safe to put in an environment; contains no private key. */
    adminFixtureEnv() {
      return {
        EHR_ENV: 'ci',
        EHR_ADMIN_CI_FIXTURE: '1',
        EHR_ADMIN_ATTESTATION_ROOTS_PEM: ca.rootPem,
        EHR_ADMIN_ALLOWED_AAGUIDS: ca.aaguid,
        EHR_ADMIN_DECOY_KEY: randomBytes(32).toString('hex'),
      };
    },
    /**
     * Software authenticator for one page. `origin` and `rpId` must be the exact staff origin and host the API was configured with.
     * Works on every navigation of the context (init script) and for popups of the same context.
     */
    async installAuthenticator(context, { origin, rpId }) {
      await context.exposeBinding('__ciAuthCreate', (_src, options) => {
        const key = new SoftKey();
        const response = key.create(options, {
          origin,
          rpId,
          aaguid: ca.aaguid,
          attestation: { x5c: ca.x5c, key: ca.leafKey },
        });
        keys.set(key.id, key);
        return response;
      });
      await context.exposeBinding('__ciAuthGet', (_src, options) => {
        const ids = (options.allowCredentials ?? []).map((c) => c.id);
        const key = ids.map((id) => keys.get(id)).find((k) => k !== undefined);
        if (key === undefined) return null; // an unknown or decoy credential: behaves like "no matching key"
        return key.assert(options, { origin, rpId });
      });
      await context.addInitScript(() => {
        const b64 = (s) =>
          Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
            .buffer;
        const u = (buf) =>
          btoa(String.fromCharCode(...new Uint8Array(buf)))
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
        const toJson = (pk) => ({
          ...pk,
          challenge: u(pk.challenge),
          ...(pk.allowCredentials
            ? { allowCredentials: pk.allowCredentials.map((c) => ({ ...c, id: u(c.id) })) }
            : {}),
        });
        const cred = (r, response) => ({
          id: r.id,
          type: 'public-key',
          rawId: b64(r.rawId),
          authenticatorAttachment: 'cross-platform',
          getClientExtensionResults: () => ({}),
          response,
        });
        navigator.credentials.get = async ({ publicKey }) => {
          const r = await globalThis.__ciAuthGet(toJson(publicKey));
          if (r === null) throw new DOMException('no matching credential', 'NotAllowedError');
          return cred(r, {
            clientDataJSON: b64(r.response.clientDataJSON),
            authenticatorData: b64(r.response.authenticatorData),
            signature: b64(r.response.signature),
            userHandle: null,
          });
        };
        navigator.credentials.create = async ({ publicKey }) => {
          const r = await globalThis.__ciAuthCreate(toJson(publicKey));
          return cred(r, {
            clientDataJSON: b64(r.response.clientDataJSON),
            attestationObject: b64(r.response.attestationObject),
            getTransports: () => r.response.transports,
          });
        };
      });
    },
    /** Enrols a key without a browser (the same attestation the browser path produces), for seeding a principal over HTTP. */
    createKeyAttestation(options, { origin, rpId }) {
      const key = new SoftKey();
      const response = key.create(options, {
        origin,
        rpId,
        aaguid: ca.aaguid,
        attestation: { x5c: ca.x5c, key: ca.leafKey },
      });
      keys.set(key.id, key);
      return response;
    },
  };
}
