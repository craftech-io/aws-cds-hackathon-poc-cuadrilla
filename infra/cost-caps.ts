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
//
// Guests of the own sign-up (ADR-0025 §3) spend inside a sub-ceiling of the global one, so they can
// never use up the capacity of the invited guests. A SIGNUP world reserves in order world → account →
// sub-ceiling → global ceiling; `KILL#` stays above everything:
//
//   TURNCAP#GUESTUSER#<userId>#<realDay>     turns of one account a real day (a new generation keeps it)
//   VALCAP#GUESTUSER#<userId>#<realDay>      photo validations of one account a real day
//   TRANSCRIBE#GUESTUSER#<userId>#<realDay>  seconds of audio of one account a real day
//   COSTUSD#GUESTUSER#<userId>               micro-dollars one account spent, ever (no reset, no TTL)
//   TURNCAP#GUESTSIGNUP#<realDay>            turns of every sign-up world
//   VALCAP#GUESTSIGNUP#<realDay>             photo validations of every sign-up world
//   TRANSCRIBE#GUESTSIGNUP#<realDay>         seconds of audio of every sign-up world
//
// The spend of an account is reserved before the spend with the estimate of `spendEstimateMicroUsd`
// (a turn: above the USD 0.074-0.134 a turn costs by the verified rate card, docs/test-plan.md; a photo:
// above its USD 0.02; audio: the Transcribe list price of USD 0.024 a minute, above the seeded row) and
// a turn settles to its priced cost afterwards (cache tokens included). At USD 1 no more turns, photo
// validations or transcriptions open for that account.

export const costCaps = {
  turnsPerDay: 1500,
  validationsPerDay: 400,
  transcribeSecondsPerDay: 5400,
  guestSignup: {
    turnsPerDay: 600,
    validationsPerDay: 150,
    transcribeSecondsPerDay: 1800,
    perUserTurnsPerDay: 40,
    perUserValidationsPerDay: 25,
    perUserTranscribeSecondsPerDay: 600,
    perUserSpendMicroUsd: 1_000_000,
    spendEstimateMicroUsd: { turn: 150_000, validation: 30_000, transcribeSecond: 400 },
  },
} as const;

export const CostCaps = new sst.Linkable("CostCaps", {
  properties: costCaps,
});
