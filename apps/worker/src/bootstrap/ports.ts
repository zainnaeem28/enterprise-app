// Ports of the run-once `bootstrap-admins` command (INT04-F02b, decision log section 4). Interfaces only: the AWS-backed
// implementations belong to DO-10 (HEAAA-138). The command never gets a general secret client; it gets the four operations it is
// allowed to use, so the task role's allowlist (decision log 4.1 item 3: CreateSecret with TagResource, DeleteSecret, and
// GenerateDataKey/Encrypt on the slot keys) is the whole of what an implementation may need.

/** What the approved record `/approved/bootstrap-<env>` carries for the command (decision log section 4 steps 1 and 1a). */
export interface BootstrapRecord {
  ticketRef: string;
  enrollees: [{ handle: string; displayName: string }, { handle: string; displayName: string }];
  /** Custodian `i` retrieves the token of enrollee `i`. Either a person who is not an enrollee or one of the enrollees (crossed). */
  custodians: [BootstrapCustodian, BootstrapCustodian];
  /** Written by the custodians after runbook step 0 (a test notice through the deployed worker, confirmed by the mailbox owner). */
  securityContactVerifiedAt: string | undefined;
  securityContactTestRef: string | undefined;
}
export type BootstrapCustodian =
  | { idpId: string; displayName: string; enrollee?: undefined }
  | { idpId: string; enrollee: 1 | 2; displayName?: undefined };

/** Reads the approved record. The agent identity cannot write it (DEVOPS-PLAN 7.4), so it cannot redirect a token to itself. */
export interface ApprovedRecordPort {
  read(env: string): Promise<unknown>;
}

/**
 * The token secrets `bootstrap/<env>/token/<slot>`, each encrypted with the customer-managed key of custodian slot `slot`. The task
 * can create and force-delete them and can read nothing back; read control is the slot key policy, set by the approved apply.
 */
export interface SecretStorePort {
  /** Creates the secret with the required `run_ref` tag. `value` is the token (UTF-8 bytes); the port must not keep a copy. */
  createTokenSecret(input: {
    env: string;
    slot: 1 | 2;
    runRef: string;
    value: Buffer;
  }): Promise<{ arn: string }>;
  /** Force-deletes without a recovery window. Resolves only once the provider confirms the secret is gone; rejects otherwise. */
  forceDeleteTokenSecret(input: { env: string; slot: 1 | 2 }): Promise<void>;
}

export interface BootstrapCallInput {
  orgId: string;
  runRef: string;
  ticketRef: string;
  enrollees: { handle: string; display_name: string }[];
  custodians: ({ idp_id: string; display_name: string } | { idp_id: string; enrollee: 1 | 2 })[];
  /** SHA-256 of the UTF-8 bytes of the 43-character token string (not of the 32 raw random bytes), slot order. */
  tokenHashes: Buffer[];
}
/** Calls `identity.bootstrap_admins` in one transaction as `app_bootstrap`. Returns the function's JSON. */
export interface BootstrapDbPort {
  call(input: BootstrapCallInput): Promise<unknown>;
}

/** The refusal codes of the function (DETAIL of PS001); `error` for anything else. Never row data. */
export const REFUSAL_CODES = [
  'caller',
  'bad_input',
  'reference_data',
  'latch_closed',
  'reissue_expired',
  'reissue_cap',
  'target_state',
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number] | 'error';

export class BootstrapRefusedError extends Error {
  constructor(readonly code: RefusalCode) {
    super(`bootstrap refused: ${code}`);
    this.name = 'BootstrapRefusedError';
  }
}
