// Staging min_client_release floor (DEVOPS-PLAN 6.2, DPR-33). Staging has no previous-manifest rule; the floor comes
// from what is deployed there. Pure: the caller reads the SSM parameters and passes the values.
//   /deployed/release_number                    number currently on staging (written after smoke passes)
//   /deployed/min_client_release/<release_no>   the min_client_release each manifest was FIRST deployed with (33-b)
export function stagingMinClient({
  manifestNumber,
  deployedNumber,
  storedForManifest,
  rollbackRehearsal,
}) {
  if (deployedNumber == null)
    return { value: manifestNumber, reason: 'first staging deploy: its own number' };
  if (manifestNumber === deployedNumber) {
    if (storedForManifest == null)
      throw new Error(
        'redeploy of the manifest already on staging, but its stored min_client_release is missing: refused (33-b)',
      );
    return {
      value: storedForManifest,
      reason: 'redeploy: keeps the value it was first deployed with',
    };
  }
  if (manifestNumber < deployedNumber) {
    if (!rollbackRehearsal)
      throw new Error(
        `manifest number ${manifestNumber} is lower than ${deployedNumber} on staging and this is not a rollback rehearsal`,
      );
    if (storedForManifest == null)
      throw new Error(
        `rollback rehearsal of ${manifestNumber}: no stored min_client_release for it; refused`,
      );
    return {
      value: storedForManifest,
      reason: 'rollback rehearsal: restores the value that manifest was deployed with',
    };
  }
  return { value: deployedNumber, reason: 'the release number currently deployed to staging' };
}
