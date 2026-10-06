// Guardrail G3 over every template parameter (docs/design-brief.md §5.5, FL-053): the parameters are
// built by code from the records, but a name or a note may still carry a phone, an email or a document
// number. Each parameter is masked first (lib/mask.ts, the same patterns as G1 and the logs) and then
// checked with `ApplyGuardrail` (G3: emails, phones, CURP, RFC and CLABE anonymized, cards blocked).
// What leaves is G3's output; a block refuses the whole message. One call per parameter, so each
// output maps to its parameter without guessing; a failed call fails closed.
import { ApplyGuardrailCommand, type BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { z } from "zod";
import { LOG_KINDS, maskText } from "../lib/mask";
import { readLinked } from "../lib/resource";
import { withRetry } from "../lib/retry";
import { GuardrailUnavailableError, isRetryableBedrock } from "./grounding";

/** `Resource.GuardrailG3` (infra/guardrail.ts): the published version. */
export const G3Config = z.object({ id: z.string().min(1), version: z.string().min(1) });
export type G3Config = z.infer<typeof G3Config>;

export function linkedG3Config(): G3Config {
  return readLinked("GuardrailG3", G3Config);
}

export interface G3Result {
  /** `NONE`: nothing found; `ANONYMIZED`: something was masked; `BLOCKED`: a card (nothing may leave). */
  readonly action: "NONE" | "ANONYMIZED" | "BLOCKED";
  /** The parameters as they may leave (masked, then as G3 returned them). */
  readonly texts: readonly string[];
}

export interface TemplateGuardrail {
  check(texts: readonly string[]): Promise<G3Result>;
}

/** The deterministic layer alone: the masker of lib/mask.ts (also what the local flows use as G3). */
export function maskParams(texts: readonly string[]): G3Result {
  const masked = texts.map((text) => maskText(text, LOG_KINDS));
  return { action: masked.some((text, index) => text !== texts[index]) ? "ANONYMIZED" : "NONE", texts: masked };
}

export interface BedrockG3Deps {
  readonly client: Pick<BedrockRuntimeClient, "send">;
  readonly config: () => G3Config;
  readonly sleep?: (ms: number) => Promise<void>;
}

export function createBedrockG3(deps: BedrockG3Deps): TemplateGuardrail {
  async function one(text: string, config: G3Config): Promise<{ readonly action: G3Result["action"]; readonly text: string }> {
    const command = new ApplyGuardrailCommand({ guardrailIdentifier: config.id, guardrailVersion: config.version, source: "OUTPUT", content: [{ text: { text } }] });
    let response;
    try {
      response = await withRetry(() => deps.client.send(command), { attempts: 2, shouldRetry: isRetryableBedrock, ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }) });
    } catch (error) {
      throw new GuardrailUnavailableError("ApplyGuardrail (G3) failed", { cause: error });
    }
    if (response.action !== "GUARDRAIL_INTERVENED") return { action: "NONE", text };
    const sensitive = (response.assessments ?? []).flatMap((assessment) => [...(assessment.sensitiveInformationPolicy?.piiEntities ?? []), ...(assessment.sensitiveInformationPolicy?.regexes ?? [])]);
    if (sensitive.some((finding) => finding.action === "BLOCKED")) return { action: "BLOCKED", text: "" };
    const output = (response.outputs ?? []).map((part) => part.text ?? "").join("");
    return { action: "ANONYMIZED", text: output.trim() === "" ? text : output };
  }

  return {
    async check(texts) {
      const config = deps.config();
      const masked = maskParams(texts);
      const results = [];
      for (const text of masked.texts) results.push(await one(text, config));
      if (results.some((result) => result.action === "BLOCKED")) return { action: "BLOCKED", texts: [] };
      const changed = masked.action === "ANONYMIZED" || results.some((result) => result.action === "ANONYMIZED");
      return { action: changed ? "ANONYMIZED" : "NONE", texts: results.map((result) => result.text) };
    },
  };
}
