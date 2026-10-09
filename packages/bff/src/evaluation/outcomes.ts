// The measurement set as the evaluation reads it (docs/seed-spec.md §9 and §10, docs/test-plan.md §5):
// the 50 questions of `EV-01` and the 60 photo labels of `EV-02`, from their `Reference` rows (the same
// rows `seed:load` writes from `scripts/seed/data/eval/`). A question names its accepted outcomes in a
// small grammar and the patterns that void any of them; a photo its verdict, reason and what else counts.
//
//   CITED_ANSWER(<section>[,<section>…])   an answer of the agent citing any of those sections
//   GUARDRAIL_BLOCK[(<topic>)]              G1 blocked the message (by that denied topic, or the attack filter)
//   CASE · OFFER_ESCALATION · REFUSAL · SAFETY_ROUTED
import { z } from "zod";
import { ManualSectionId, PhotoId, PhotoItem, QuestionId, RejectReason, Verdict } from "@cuadrilla/shared";
import type { EvalPhoto, EvalQuestion } from "../domain/reference";

/** G1's denied topics and its prompt-attack filter (infra/guardrail-policies.ts). */
export const GUARDRAIL_TOPICS = ["PRICING", "CUSTOMER_COMPENSATION", "ELECTRICAL_WORK", "PROMPT_ATTACK"] as const;
export type GuardrailTopic = (typeof GUARDRAIL_TOPICS)[number];

export type ExpectedOutcome =
  | { readonly kind: "CITED_ANSWER"; readonly sections: readonly string[] }
  | { readonly kind: "GUARDRAIL_BLOCK"; readonly topic?: GuardrailTopic }
  | { readonly kind: "CASE" }
  | { readonly kind: "OFFER_ESCALATION" }
  | { readonly kind: "REFUSAL" }
  | { readonly kind: "SAFETY_ROUTED" };

const BARE = ["CASE", "OFFER_ESCALATION", "REFUSAL", "SAFETY_ROUTED", "GUARDRAIL_BLOCK"] as const;
const WITH_ARGUMENTS = /^(?<name>CITED_ANSWER|GUARDRAIL_BLOCK)\((?<args>[A-Z0-9_,-]+)\)$/;

/** One accepted outcome of the grammar above; throws on anything else (the set is validated at seed time). */
export function readOutcome(spec: string): ExpectedOutcome {
  const bare = BARE.find((name) => name === spec);
  if (bare !== undefined) return { kind: bare };
  const groups = WITH_ARGUMENTS.exec(spec)?.groups;
  const args = (groups?.args ?? "").split(",");
  if (groups?.name === "GUARDRAIL_BLOCK" && args.length === 1) {
    const topic = GUARDRAIL_TOPICS.find((candidate) => candidate === args[0]);
    if (topic !== undefined) return { kind: "GUARDRAIL_BLOCK", topic };
  }
  if (groups?.name === "CITED_ANSWER" && args.every((section) => ManualSectionId.safeParse(section).success)) return { kind: "CITED_ANSWER", sections: args };
  throw new RangeError(`"${spec}" is not an outcome of docs/seed-spec.md §9`);
}

/** What voids an accepted outcome: a promise of policy, personal data, or an expression of the question's own. */
export const VoidingPattern = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("POLICY_PROMISE"), id: z.string() }),
  z.object({ kind: z.literal("PERSONAL_DATA"), id: z.string() }),
  z.object({ kind: z.literal("REGEX"), id: z.string(), pattern: z.string().min(1), flags: z.string().regex(/^[imsu]*$/).default("") }),
]);
export type VoidingPattern = z.infer<typeof VoidingPattern>;

/** A question of the set with what the scorer needs (`Reference` `REF#EVAL#QUESTIONS`). */
export const QuestionSpec = z.object({
  questionId: QuestionId,
  type: z.enum(["A", "R"]),
  text: z.string().min(1),
  expectedSections: z.array(ManualSectionId),
  acceptedOutcomes: z.array(z.string()).min(1),
  forbiddenPatterns: z.array(VoidingPattern).default([]),
  safety: z.enum(["NONE", "HAZARD_PRESENT", "LEXICON_NEGATIVE"]).default("NONE"),
});
export type QuestionSpec = z.infer<typeof QuestionSpec>;

/** A labelled photo of the set with what the scorer and the runner need (`REF#EVAL#PHOTOS`). */
export const PhotoLabel = z.object({
  photoId: PhotoId,
  item: PhotoItem,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  expectedVerdict: Verdict,
  expectedReason: RejectReason.optional(),
  acceptedReasons: z.array(RejectReason).default([]),
  acceptsUnsure: z.boolean().default(false),
  orderSerial: z.string().min(1),
  opticalClass: z.string().min(1),
  orchestratorRxDbm: z.number(),
});
export type PhotoLabel = z.infer<typeof PhotoLabel>;

export function questionSpecOf(row: EvalQuestion | Readonly<Record<string, unknown>>): QuestionSpec {
  const spec = QuestionSpec.parse(row);
  for (const outcome of spec.acceptedOutcomes) readOutcome(outcome);
  return spec;
}

export function photoLabelOf(row: EvalPhoto | Readonly<Record<string, unknown>>): PhotoLabel {
  return PhotoLabel.parse(row);
}
