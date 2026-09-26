// Rule ids and the two decision shapes of docs/tool-catalog.md ("Tipos compartidos": `PolicyResult`,
// `Guardrail`). Every decision the product records names the rules that decided it: contact policy
// `CP-*` (docs/design-brief.md §5.7), Cedar `CED-*` and Lambda fences `LAM-*` (§5.6), guardrails
// `G1`/`G2`/`G3` (§5.5), safety `SAFE-*` (§5.9), photo checks `VAL-*` (§5.10) and the ladder `LAD-*`
// (§5.8). The console shows them as chips and `PolicyAudit` reads them back.
import { z } from "zod";
import { IsoInstant } from "./dates";

/** Families of rule ids, in the order of docs/flows-catalog.md ("Reglas"). */
export const RULE_FAMILIES = ["CP", "CED", "LAM", "G", "SAFE", "VAL", "LAD"] as const;
export type RuleFamily = (typeof RULE_FAMILIES)[number];

const RULE_ID = /^(?:(?:CP|CED|LAM|SAFE|VAL|LAD)-[A-Z0-9]+(?:-[A-Z0-9]+)*|G[123])$/;

export const RuleId = z.string().regex(RULE_ID, "expected a rule id such as CP-WA-24H, LAM-SCOPE or G2");
export type RuleId = z.infer<typeof RuleId>;

export function ruleFamilyOf(ruleId: string): RuleFamily {
  const id = RuleId.parse(ruleId);
  return id.startsWith("G") && !id.includes("-") ? "G" : (id.slice(0, id.indexOf("-")) as RuleFamily);
}

/**
 * The fifteen contact policy rules in evaluation order (docs/design-brief.md §5.7): the first one
 * that denies stops the evaluation, so the order is part of the policy.
 */
export const ContactRule = z.enum([
  "CP-KIND-CHANNEL",
  "CP-ALLOWLIST",
  "CP-OPTIN",
  "CP-OPTOUT",
  "CP-BRIDGE",
  "CP-ROSTER",
  "CP-QUIET-HOURS",
  "CP-ONE-DAYSTART",
  "CP-WA-24H",
  "CP-TEMPLATE-APPROVED",
  "CP-RECIPIENT-FENCE",
  "CP-CERT-EVIDENCE",
  "CP-NO-SENSITIVE-ASK",
  "CP-NO-FOREIGN-LINKS",
  "CP-CITATION",
]);
export type ContactRule = z.infer<typeof ContactRule>;

/** Outcome of the contact policy for one message; `nextAllowedAt` only on a denial by time. */
export const PolicyResult = z
  .object({
    allowed: z.boolean(),
    ruleIds: z.array(RuleId),
    reason: z.string().min(1).optional(),
    nextAllowedAt: IsoInstant.optional(),
  })
  .strict()
  .refine((result) => !(result.allowed && result.nextAllowedAt !== undefined), {
    message: "an allowed message has no nextAllowedAt",
    path: ["nextAllowedAt"],
  });
export type PolicyResult = z.infer<typeof PolicyResult>;

/** What a guardrail did to an outbound text: nothing, or blocked it. */
export const GuardrailAction = z.enum(["NONE", "BLOCKED"]);
export type GuardrailAction = z.infer<typeof GuardrailAction>;

/** Guardrail outcome a tool returns; `groundingScore` is G2's contextual grounding score (0 to 1). */
export const Guardrail = z
  .object({
    action: GuardrailAction,
    groundingScore: z.number().min(0).max(1).optional(),
  })
  .strict();
export type Guardrail = z.infer<typeof Guardrail>;
