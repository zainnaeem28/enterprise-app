# Requested change outside BE-13's allowed paths (for the Integrator)

The registry takes one merge participant per module. BE-13 adds `registerSchedulingFlowParticipants` (flow/index.ts), which covers
`scheduling.slot_reservation` (delegated to BE-11's logic) AND the four flow tables. Once migrations 1300-1303 exist, any test that runs
a patient merge with only BE-11's participant fails with `patient.merge_participant_missing` (observed, 3 tests of
`scheduling/core/concurrency.dbtest.ts`: "item 11", "the participant is registered ...", "38.2 item 1, confirm first").

Needed (tests/composition only):

1. `scheduling/core/testkit.ts` and `patient/merge/{testkit,merge.dbtest,concurrency.dbtest}.ts`: register
   `registerSchedulingFlowParticipants` instead of `registerSchedulingParticipants`.
2. `scheduling/core/concurrency.dbtest.ts` lines ~311-317 and ~400: use the flow registration instead of `schedulingMergeParticipant`
   (the "already registered" assertion stays valid).
3. `db/tools/catalog-lists.mjs`: see `catalog-lists.requested.patch` (definer inventory and patient guard functions).
4. Production composition: define SCHEDULING_FLOW_JOBS and register the flow handlers (see flow/index.ts header).
