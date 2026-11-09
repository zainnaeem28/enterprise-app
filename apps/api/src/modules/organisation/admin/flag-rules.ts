// Value rules for feature flags (ARCHITECTURE 29.4: "validated against their JSON schema"). A rule here is part of the flag's
// schema, so the route contract does not change. INT03-F17 condition 1(c) (decision log HEAAA-384): in R1, `patient_messaging`
// can be turned OFF or have its row removed, but never turned ON, organisation-wide or per location. The refusal is lifted
// only by the deferred patient-messaging design change and its G2 delta, which edits this table.
export interface FlagRule {
  /** `false`: a write that sets `enabled: true` is refused with `400 kernel.validation_failed`. */
  enabledAllowed: boolean;
  /** Names the rule in the audit row of the refused attempt. */
  rule: string;
}

export const FLAG_RULES: Readonly<Record<string, FlagRule>> = {
  patient_messaging: { enabledAllowed: false, rule: 'patient_messaging_off_in_r1' },
};
