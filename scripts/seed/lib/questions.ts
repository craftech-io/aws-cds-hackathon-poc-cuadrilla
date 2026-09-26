// Shape of the evaluation set of `EV-01` (docs/seed-spec.md §9, docs/test-plan.md §5): the file
// `eval/questions.json` and the `EVAL#QUESTIONS` rows. Each question lists its accepted outcomes in a
// small grammar the scorer parses (`parseOutcome`) and the patterns that void any accepted outcome.
import { z } from "zod";
import { ManualSectionId, QuestionId } from "@cuadrilla/shared";

/** G1 denied topics and the prompt-attack filter (docs/design-brief.md §5.5). */
export const GuardrailTopic = z.enum(["PRICING", "CUSTOMER_COMPENSATION", "ELECTRICAL_WORK", "PROMPT_ATTACK"]);
export type GuardrailTopic = z.infer<typeof GuardrailTopic>;

export type Outcome =
  | { readonly kind: "CITED_ANSWER"; readonly sections: readonly string[] }
  | { readonly kind: "GUARDRAIL_BLOCK"; readonly topic?: GuardrailTopic }
  | { readonly kind: "CASE" | "OFFER_ESCALATION" | "REFUSAL" | "SAFETY_ROUTED" };

const SIMPLE = new Set(["CASE", "OFFER_ESCALATION", "REFUSAL", "SAFETY_ROUTED", "GUARDRAIL_BLOCK"]);

/**
 * `CASE`, `OFFER_ESCALATION`, `REFUSAL`, `SAFETY_ROUTED`, `GUARDRAIL_BLOCK`, `GUARDRAIL_BLOCK(<topic>)`
 * or `CITED_ANSWER(<section>[,<section>…])` (a citation to any of the sections counts); `undefined`
 * for anything else.
 */
export function parseOutcome(value: string): Outcome | undefined {
  if (SIMPLE.has(value)) return { kind: value as "CASE" };
  const call = /^(CITED_ANSWER|GUARDRAIL_BLOCK)\(([A-Z0-9_,-]+)\)$/.exec(value);
  if (call === null) return undefined;
  const args = (call[2] ?? "").split(",");
  if (call[1] === "GUARDRAIL_BLOCK") {
    const topic = GuardrailTopic.safeParse(args[0]);
    return args.length === 1 && topic.success ? { kind: "GUARDRAIL_BLOCK", topic: topic.data } : undefined;
  }
  return args.every((section) => ManualSectionId.safeParse(section).success) ? { kind: "CITED_ANSWER", sections: args } : undefined;
}

export const AcceptedOutcome = z.string().refine((value) => parseOutcome(value) !== undefined, "expected an outcome of docs/seed-spec.md §9");

/**
 * What voids an answer: `POLICY_PROMISE` (copy/forbidden.ts `findPolicyPromise`: percentages, amounts,
 * promise verbs), `PERSONAL_DATA` (lib/mask.ts `containsSensitive`) or a regular expression of its own.
 */
export const ForbiddenPattern = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("POLICY_PROMISE"), id: z.literal("policy-promise") }).strict(),
  z.object({ kind: z.literal("PERSONAL_DATA"), id: z.literal("personal-data") }).strict(),
  z.object({ kind: z.literal("REGEX"), id: z.string().regex(/^[a-z0-9-]+$/), pattern: z.string().min(1), flags: z.string().regex(/^[imsu]*$/), description: z.string().min(1) }).strict(),
]);
export type ForbiddenPattern = z.infer<typeof ForbiddenPattern>;

/** How the safety lexicon should treat the question (docs/seed-spec.md §9). */
export const SafetyExpectation = z.enum(["NONE", "HAZARD_PRESENT", "LEXICON_NEGATIVE"]);
export type SafetyExpectation = z.infer<typeof SafetyExpectation>;

export const EvalQuestionDef = z
  .object({
    questionId: QuestionId,
    type: z.enum(["A", "R"]),
    text: z.string().trim().min(1).max(1000),
    expectedSections: z.array(ManualSectionId),
    acceptedOutcomes: z.array(AcceptedOutcome).min(1),
    forbiddenPatterns: z.array(ForbiddenPattern).min(1),
    safety: SafetyExpectation,
    notes: z.string().optional(),
  })
  .strict();
export type EvalQuestionDef = z.infer<typeof EvalQuestionDef>;

export const QuestionsFile = z
  .object({
    setVersion: z.literal("v001"),
    manualVersion: z.literal("v001"),
    generator: z.string().min(1),
    seed: z.literal(20260926),
    questions: z.array(EvalQuestionDef),
  })
  .strict();
export type QuestionsFile = z.infer<typeof QuestionsFile>;
