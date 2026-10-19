// Agent cases the local model cannot pass whatever the product does, each with what its trace proved. On a
// local model they are skipped (and listed as skipped by the run); on a billed model (`agent-test run
// --model opus --max-usd <n> --yes`) they run like any other case and are the product's to pass. A case
// enters here only with the trace of a run where the prompt, the tools and the policy already said what the
// model did not do; a product or oracle bug is fixed, never listed.
import { parseModel } from "@craftech/agent-testkit";

export const LOCAL_LIMITS = {
  "SC-04/15.a":
    "qwen3.8:27b-nvfp4 validates a photo nobody asked for under a guessed item, then asks which item it was for: 3 of 3 runs on 2026-10-14, with the system prompt and the item of validate_install_photo both saying never to guess",
  "SC-02/2-3":
    "qwen3.8:27b-nvfp4 cannot write a tool call Ollama's parser reads in the vn-02 turn (the ONU online, ONU_ONLINE and the message with every pending photo item): 'element <parameter> closed by </function>' on every attempt, at temperature 0 and on each retry at 0.4, until the 300 s turn deadline; 3 of 3 runs on 2026-10-18 (Ollama's log), so the turn never reaches the Gateway. The vn-01 turn runs locally as SC-02/2",
} as const satisfies Readonly<Record<string, string>>;

/** Whether the run's model is a local one, for which the case `id` is a known limit. */
export function localLimit(id: keyof typeof LOCAL_LIMITS): boolean {
  return LOCAL_LIMITS[id] !== undefined && parseModel(process.env.AGENT_TEST_MODEL).kind === "local";
}
