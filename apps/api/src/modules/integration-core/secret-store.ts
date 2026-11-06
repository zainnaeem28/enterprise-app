// The narrow interfaces the API tier needs from infrastructure (BD-11). Both are implemented outside this module (Secrets
// Manager and KMS, planning names); tests use in-memory fakes. A secret VALUE appears in exactly two places in this module:
// the argument of `put`, and the plaintext handed to `seal`. Neither is returned, logged or stored.

/**
 * Writes a new version of an `outbound` secret. The API task role may write only under `<env>/integration/outbound/`
 * (SC-2); the store implementation builds the path from the connection ID and name, so a caller cannot choose another
 * prefix. `clientToken` makes the write idempotent: a retry with the same token returns the same version (25.9).
 */
export interface OutboundSecretStore {
  put(
    ref: { connectionId: string; name: string },
    value: string,
    clientToken: string,
  ): Promise<{ arn: string; versionId: string }>;
}

/**
 * Seals a byte string so that only the worker role can open it (SC-3: Encrypt/GenerateDataKey to the API role, Decrypt to
 * the worker role only; the encryption context binds the ciphertext and a wrong context fails to open):
 *   `inbound:<source>\n<event id>`  for a webhook body (DF-4),
 *   `secret_change:<request id>`    for an entered inbound-verification secret.
 */
export interface PayloadSealer {
  seal(plain: Buffer, context: string): Promise<Buffer>;
}

/**
 * Verification keys for incoming webhooks (29.5). The API fetches them from the secret store by their fixed name
 * (`<env>/integration/inbound/<source>`), NOT through `secret_ref`, so a webhook transaction reads no table before
 * verification. Returns the current key first, then the previous one (rotation window), each with its version label.
 */
export interface InboundKeyProvider {
  keys(source: string): Promise<readonly { version: string; key: Buffer }[]>;
}
