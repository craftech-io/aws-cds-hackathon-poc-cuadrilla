// Global cost ceiling of the stage per real day (ADR-0019, docs/build-plan.md WP-02).
//
// Every world that is not QA or evaluation shares these ceilings. They are reserved with a
// conditional `UpdateItem ADD` in `Runtime` BEFORE spending (packages/bff/src/ops/cost-caps.ts):
//
//   TURNCAP#GLOBAL#<realDay>     Harness turns                     (worker, before InvokeHarness)
//   VALCAP#GLOBAL#<realDay>      photo validations                 (ToolEvidence, before Converse)
//   TRANSCRIBE#GLOBAL#<realDay>  seconds of transcribed audio      (worker, before StartTranscriptionJob)
//
// QA and evaluation runs carry their own budget per run (docs/test-plan.md §4.4) and never consume
// these. Physical safety (classifier, fixed instruction, alerts) uses no model and is never capped.
// Exposed as a Linkable: Lambdas read it with `readLinked("CostCaps", …)`.

export const costCaps = {
  turnsPerDay: 1500,
  validationsPerDay: 400,
  transcribeSecondsPerDay: 5400,
} as const;

export const CostCaps = new sst.Linkable("CostCaps", {
  properties: costCaps,
});
