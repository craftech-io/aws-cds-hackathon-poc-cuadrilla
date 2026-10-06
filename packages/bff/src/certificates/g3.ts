/// <reference path="../../sst-env.d.ts" />
// Guardrail G3 over the text of the certificate (docs/design-brief.md §5.5, docs/architecture.md §11):
// PII only, cards BLOCK, emails, phones, CURP, RFC and CLABE ANONYMIZE. One `ApplyGuardrail` call per
// certificate: the fields travel as one text joined by a separator line no anonymization touches, so
// the text units billed are those of the certificate, not one minimum per field, and come back split
// in the same order (any other shape is a failure, never a guess). Timeouts and retries with backoff
// are lib/clients.ts's `guardrail` budget; the guardrail is the linked `GuardrailG3` (never `process.env`).
import { ApplyGuardrailCommand, type ApplyGuardrailCommandOutput, BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { z } from "zod";
import { ToolError } from "@cuadrilla/shared";
import { CLIENT_TIMEOUTS, awsClientConfig } from "../lib/clients";
import { readLinked } from "../lib/resource";

export type G3Outcome =
  | { readonly action: "NONE" | "ANONYMIZED"; readonly texts: readonly string[] }
  /** A blocked entity (a card number): the certificate is not written. */
  | { readonly action: "BLOCKED"; readonly entities: readonly string[] };

export interface G3Port {
  apply(texts: readonly string[]): Promise<G3Outcome>;
}

/** Between two fields: no PII pattern and no anonymization marker can reach across it. */
export const G3_SEPARATOR = "\n|||\n";

const GuardrailResource = z.object({ id: z.string().min(1), version: z.string().min(1) });
export type GuardrailRef = z.infer<typeof GuardrailResource>;

function blockedEntities(output: ApplyGuardrailCommandOutput): string[] {
  const entities: string[] = [];
  for (const assessment of output.assessments ?? []) {
    const policy = assessment.sensitiveInformationPolicy;
    for (const entity of policy?.piiEntities ?? []) if (entity.action === "BLOCKED") entities.push(entity.type ?? "PII");
    for (const regex of policy?.regexes ?? []) if (regex.action === "BLOCKED") entities.push(regex.name ?? "REGEX");
  }
  return entities;
}

/** The outcome of one response for the joined `texts`. */
export function g3OutcomeOf(output: ApplyGuardrailCommandOutput, texts: readonly string[]): G3Outcome {
  if (output.action !== "GUARDRAIL_INTERVENED") return { action: "NONE", texts };
  const blocked = blockedEntities(output);
  if (blocked.length > 0) return { action: "BLOCKED", entities: blocked };
  const joined = (output.outputs ?? []).map((part) => part.text ?? "").join("");
  const split = joined.split(G3_SEPARATOR);
  if (split.length !== texts.length) throw new ToolError("UNAVAILABLE", "G3 returned the certificate text in another shape", "G3_SHAPE");
  return { action: "ANONYMIZED", texts: split };
}

let runtime: BedrockRuntimeClient | undefined;

/** G3 through `ApplyGuardrail` (source `OUTPUT`: the text leaves the system). */
export function bedrockG3(client?: Pick<BedrockRuntimeClient, "send">, guardrail: () => GuardrailRef = () => readLinked("GuardrailG3", GuardrailResource)): G3Port {
  return {
    async apply(texts) {
      if (texts.length === 0) return { action: "NONE", texts };
      if (texts.some((text) => text.includes(G3_SEPARATOR))) throw new ToolError("INVALID", "a certificate field carries the G3 separator");
      const { id, version } = guardrail();
      const sender = client ?? (runtime ??= new BedrockRuntimeClient(awsClientConfig(CLIENT_TIMEOUTS.guardrail)));
      let output: ApplyGuardrailCommandOutput;
      try {
        output = await sender.send(
          new ApplyGuardrailCommand({ guardrailIdentifier: id, guardrailVersion: version, source: "OUTPUT", outputScope: "FULL", content: [{ text: { text: texts.join(G3_SEPARATOR) } }] }),
        );
      } catch (error) {
        throw new ToolError("UNAVAILABLE", "G3 is not available right now", error instanceof Error ? error.name : "G3_ERROR", { cause: error });
      }
      return g3OutcomeOf(output, texts);
    },
  };
}
