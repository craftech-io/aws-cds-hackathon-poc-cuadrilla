// The destruction of a guest's current generation for `GuestAccountDeletion` (ADR-0025 §6): its items
// in the demo's tables, its `guest/<seg>/` prefixes in `Media` and `Evidence` and its Memory. The world
// lifecycle lives in worlds/guest-lifecycle.ts (the minimal world factory of the wave, WP-58); this
// adapter only binds the deletion's port (`GenerationDestroyer`, leads/deletion.ts) to it, so the
// deletion never duplicates what a world is made of. It destroys only a generation of the own sign-up,
// idempotently, and throws when it could not, so the account and the lead stay for the retry.
import { defaultSignupGenerationDestroyer } from "../worlds/destroyer";
import type { GenerationDestroyer } from "./deletion";

export function worldDestroyer(): GenerationDestroyer {
  return {
    async destroyGeneration(account) {
      await defaultSignupGenerationDestroyer().destroyGeneration(account);
    },
  };
}
