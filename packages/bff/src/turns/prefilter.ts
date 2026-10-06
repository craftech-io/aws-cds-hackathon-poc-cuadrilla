/// <reference path="../../sst-env.d.ts" />
// The G1 pre-filter of the worker (docs/architecture.md §9.1, docs/design-brief.md §5.5): before the
// Harness, the installer's untrusted text of the turn (a message or a transcript, already normalized
// and masked) goes through `ApplyGuardrail` with G1 and `source INPUT`. `action GUARDRAIL_INTERVENED` is
// not enough to block, because an anonymization alone also intervenes; the worker reads the assessments:
//
//   topicPolicy.topics[] BLOCKED                                  → block DENIED_TOPIC
//   contentPolicy.filters[] PROMPT_ATTACK BLOCKED                 → block PROMPT_INJECTION
//   sensitiveInformationPolicy CREDIT_DEBIT_CARD_NUMBER BLOCKED   → block OTHER "datos de tarjeta" (second layer)
//   only ANONYMIZED entries (CURP, RFC, CLABE regexes)            → no block: the turn goes on with
//                                                                   `outputs[0].text` (`GUARDRAIL_MASK`)
//   action NONE                                                   → no block, nothing audited
//
// A BLOCKED entry of any other policy still blocks, fail closed, as `UNLISTED` (case OTHER). The call
// fails closed too: an error of `ApplyGuardrail` fails the event, which SQS retries; the text never
// reaches the Harness without G1 having looked at it. A card that passed Luhn never gets here: the
// normalizer masked it and the worker blocked the turn before G1 (lib/mask.ts `prefilterBlock`).
import { ApplyGuardrailCommand, BedrockRuntimeClient, type ApplyGuardrailCommandInput, type ApplyGuardrailCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { z } from "zod";
import { CLIENT_TIMEOUTS, awsClientConfig } from "../lib/clients";
import { readLinked } from "../lib/resource";

const REGION = "us-east-1";

/** Which G1 policy blocked: it decides the case's reason. */
export const G1Policy = z.enum(["DENIED_TOPIC", "PROMPT_ATTACK", "CARD_DATA", "UNLISTED"]);
export type G1Policy = z.infer<typeof G1Policy>;

export type G1Verdict =
  | { readonly action: "NONE" }
  | { readonly action: "ANONYMIZED"; readonly text: string; readonly kinds: readonly string[] }
  | { readonly action: "BLOCKED"; readonly policy: G1Policy; readonly topics: readonly string[] };

export type G1Answer = Pick<ApplyGuardrailCommandOutput, "action" | "assessments" | "outputs">;

const CARD_ENTITY = "CREDIT_DEBIT_CARD_NUMBER";

function blockedPolicy(answer: G1Answer): { readonly policy: G1Policy; readonly topics: string[] } | undefined {
  const assessments = answer.assessments ?? [];
  const topics = assessments.flatMap((assessment) => (assessment.topicPolicy?.topics ?? []).filter((topic) => topic.action === "BLOCKED").map((topic) => topic.name ?? "topic"));
  if (topics.length > 0) return { policy: "DENIED_TOPIC", topics };
  const filters = assessments.flatMap((assessment) => assessment.contentPolicy?.filters ?? []).filter((filter) => filter.action === "BLOCKED");
  if (filters.some((filter) => filter.type === "PROMPT_ATTACK")) return { policy: "PROMPT_ATTACK", topics: [] };
  const pii = assessments.flatMap((assessment) => assessment.sensitiveInformationPolicy?.piiEntities ?? []).filter((entity) => entity.action === "BLOCKED");
  if (pii.some((entity) => entity.type === CARD_ENTITY)) return { policy: "CARD_DATA", topics: [] };
  const regexes = assessments.flatMap((assessment) => assessment.sensitiveInformationPolicy?.regexes ?? []).filter((regex) => regex.action === "BLOCKED");
  const words = assessments.flatMap((assessment) => [...(assessment.wordPolicy?.customWords ?? []), ...(assessment.wordPolicy?.managedWordLists ?? [])]).filter((word) => word.action === "BLOCKED");
  if (filters.length + pii.length + regexes.length + words.length > 0) return { policy: "UNLISTED", topics: [] };
  return undefined;
}

function anonymizedKinds(answer: G1Answer): string[] {
  const kinds = (answer.assessments ?? []).flatMap((assessment) => [
    ...(assessment.sensitiveInformationPolicy?.regexes ?? []).filter((regex) => regex.action === "ANONYMIZED").map((regex) => regex.name ?? "REGEX"),
    ...(assessment.sensitiveInformationPolicy?.piiEntities ?? []).filter((entity) => entity.action === "ANONYMIZED").map((entity) => entity.type ?? "PII"),
  ]);
  return [...new Set(kinds)].sort();
}

/** The worker's reading of a G1 answer on `text` (the table above). */
export function classifyG1(answer: G1Answer, text: string): G1Verdict {
  const blocked = blockedPolicy(answer);
  if (blocked !== undefined) return { action: "BLOCKED", ...blocked };
  const kinds = anonymizedKinds(answer);
  if (kinds.length === 0) return { action: "NONE" };
  const output = answer.outputs?.[0]?.text;
  return { action: "ANONYMIZED", text: typeof output === "string" && output.trim() !== "" ? output : text, kinds };
}

/** The case reason of a G1 block (docs/design-brief.md §5.8). */
export function caseReasonOf(policy: G1Policy): "DENIED_TOPIC" | "PROMPT_INJECTION" | "OTHER" {
  if (policy === "DENIED_TOPIC") return "DENIED_TOPIC";
  if (policy === "PROMPT_ATTACK") return "PROMPT_INJECTION";
  return "OTHER";
}

export interface G1Prefilter {
  check(text: string): Promise<G1Verdict>;
}

/** `Resource.GuardrailG1` (infra/guardrail.ts). */
export const GuardrailG1Link = z.object({ id: z.string().min(1), version: z.string().min(1) });
export type GuardrailG1Link = z.infer<typeof GuardrailG1Link>;

export type GuardrailSend = (input: ApplyGuardrailCommandInput) => Promise<G1Answer>;

export function createG1Prefilter(deps: { readonly link: () => GuardrailG1Link; readonly send: GuardrailSend }): G1Prefilter {
  return {
    async check(text) {
      const { id, version } = GuardrailG1Link.parse(deps.link());
      const answer = await deps.send({ guardrailIdentifier: id, guardrailVersion: version, source: "INPUT", content: [{ text: { text } }] });
      return classifyG1(answer, text);
    },
  };
}

let runtimeClient: BedrockRuntimeClient | undefined;

/** The pre-filter of the `InstallerWorker`, over `Resource.GuardrailG1` (`bedrock:ApplyGuardrail` on G1 only). */
export function linkedG1Prefilter(): G1Prefilter {
  return createG1Prefilter({
    link: () => readLinked("GuardrailG1", GuardrailG1Link),
    send: (input) => {
      runtimeClient ??= new BedrockRuntimeClient({ region: REGION, ...awsClientConfig(CLIENT_TIMEOUTS.guardrail) });
      return runtimeClient.send(new ApplyGuardrailCommand(input));
    },
  });
}
