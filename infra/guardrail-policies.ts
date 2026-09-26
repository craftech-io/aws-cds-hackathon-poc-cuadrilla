// Content of the three Bedrock Guardrails (docs/design-brief.md §5.5, docs/architecture.md §9.1 and
// §9.4), as plain data:
//
//   G1  the worker's pre-filter (`ApplyGuardrail`, source INPUT, over the text or transcript the
//       normalizer already masked) and the Harness `guardrailConfig` (every model call, input and
//       output): three denied topics, prompt attack HIGH, cards blocked, CURP/RFC/CLABE anonymized.
//   G2  the outbound pipeline (`ApplyGuardrail`, source OUTPUT) over every free text of the agent and
//       the summary of a case: contextual grounding 0.75 against the turn's tool results, relevance
//       0.5 (the pipeline passes a query on REPLY only) and G1's denied topics on the outbound text.
//   G3  the certificate writer and the template parameters: PII only. Emails, phones, CURP, RFC and
//       CLABE anonymized, cards blocked; nothing else, so an order fact is never rewritten.
//
// G1 can only block on what the worker knows how to classify (docs/architecture.md §9.1): a denied
// topic (case DENIED_TOPIC), PROMPT_ATTACK (case PROMPT_INJECTION) or a card number (case OTHER). So it
// carries no other content filter and no word filter. The document regexes are ANONYMIZE and never
// block: the normalizer already masked them with the very same patterns, imported from
// packages/bff/src/lib/mask.ts (never copied), and G1 is the second layer. The same holds for cards:
// the normalizer masks a Luhn-valid card before G1 and mask.ts `prefilterBlock` blocks the turn
// (origin PREFILTER), so G1's card entity only catches what the masker could not see.
//
// Topic definitions and examples are written in Mexican Spanish with an English gloss: installers
// write Spanish and the CLASSIC tier covers both. None of the examples is a text the tests or the
// evaluation send (the triggers of FL-032 and the 50 questions of docs/seed-spec.md §9): those must
// measure how the guardrail generalizes, not whether it recalls its own examples.
//
// No SST dependency: infra/guardrail.ts turns this into resources and guardrail-policies.test.ts
// checks it without an AWS account.
import { createHash } from "node:crypto";
import { GUARDRAIL_REGEXES } from "../packages/bff/src/lib/mask";

export interface DeniedTopic {
  /** `[0-9a-zA-Z-_ !?.]+`, at most 100 characters; the audit names the topic that intervened. */
  readonly name: string;
  /** At most 200 characters (CLASSIC tier): `<es> (<en>).` */
  readonly definition: string;
  /** At most 5 in total, 100 characters each. */
  readonly examples: { readonly es: readonly string[]; readonly en: readonly string[] };
}

/** Denied topics of G1 (input and output) and G2 (output), in the order of FL-032 (a), (b), (c). */
export const DENIED_TOPICS: readonly DeniedTopic[] = [
  {
    name: "PRICING",
    definition:
      "Informar, ofrecer o negociar precios de los planes, descuentos o promociones para el cliente (quoting or negotiating the price of plans, discounts or promotions).",
    examples: {
      es: ["¿Qué descuento le puedo dar si contrata hoy?", "¿Hay alguna promoción para que el cliente se quede con nosotros?", "¿Cuánto cuesta al mes el plan más rápido que tienen?"],
      en: ["What discount can I offer the customer if they sign today?", "Tell the customer the monthly price of the fastest plan."],
    },
  },
  {
    name: "CUSTOMER_COMPENSATION",
    definition:
      "Ofrecer o prometer al cliente bonificaciones, meses gratis, reembolsos o equipo de regalo por una falla o un retraso (offering the customer credits, free months, refunds or free equipment).",
    examples: {
      es: ["Por la espera, ¿le puedo bonificar la primera mensualidad?", "El cliente está molesto, ¿le dejo la ONU de regalo?", "¿Le devuelvo lo que pagó de instalación porque no llegamos?"],
      en: ["Can I give the customer a free month because we were late?", "Promise the customer a refund for the missed appointment."],
    },
  },
  {
    name: "ELECTRICAL_WORK",
    definition:
      "Cómo instalar, modificar o reparar la instalación eléctrica del domicilio o de la red: cableado, tableros, medidores de luz o líneas de energía (electrical work on wiring or power lines).",
    examples: {
      es: ["¿Cómo instalo un contacto nuevo en la sala del cliente?", "¿Qué pastilla del tablero bajo para mover el cable de corriente?", "¿Cómo uno los cables de luz del cliente para alargarlos?"],
      en: ["How do I wire a new outlet from the breaker panel?", "Can I join the customer's power cables to make them longer?"],
    },
  },
];

export type FilterStrength = "NONE" | "LOW" | "MEDIUM" | "HIGH";

export interface ContentFilter {
  readonly type: "PROMPT_ATTACK";
  readonly inputStrength: FilterStrength;
  readonly outputStrength: FilterStrength;
}

/** Content filters of G1: prompt attack only. It exists on input only, so its output strength is NONE. */
export const CONTENT_FILTERS: readonly ContentFilter[] = [{ type: "PROMPT_ATTACK", inputStrength: "HIGH", outputStrength: "NONE" }];

export type PiiAction = "BLOCK" | "ANONYMIZE" | "NONE";
export type PiiType = "CREDIT_DEBIT_CARD_NUMBER" | "EMAIL" | "PHONE";

export interface PiiEntity {
  readonly type: PiiType;
  readonly inputAction: PiiAction;
  readonly outputAction: PiiAction;
}

/**
 * Managed PII types of G1. A card number blocks (case OTHER, "datos de tarjeta") on the model's output,
 * where a card can never be legitimate, and on input as a second layer: a Luhn-valid card never
 * reaches G1 unmasked, the pre-G1 block of mask.ts `prefilterBlock` handles it (FL-078).
 * Emails and phones are detected and left alone (NONE): identity comes from the registered phone,
 * and the normalizer already masked the phones of the text.
 */
export const G1_PII_ENTITIES: readonly PiiEntity[] = [
  { type: "CREDIT_DEBIT_CARD_NUMBER", inputAction: "BLOCK", outputAction: "BLOCK" },
  { type: "EMAIL", inputAction: "NONE", outputAction: "NONE" },
  { type: "PHONE", inputAction: "NONE", outputAction: "NONE" },
];

/**
 * Managed PII types of G3, the same on both sides because the certificate writer and the pipeline
 * evaluate finished outbound text: cards block (the render aborts with a case OTHER), emails and
 * phones are anonymized (the certificate never carries the customer's contacts).
 */
export const G3_PII_ENTITIES: readonly PiiEntity[] = [
  { type: "CREDIT_DEBIT_CARD_NUMBER", inputAction: "BLOCK", outputAction: "BLOCK" },
  { type: "EMAIL", inputAction: "ANONYMIZE", outputAction: "ANONYMIZE" },
  { type: "PHONE", inputAction: "ANONYMIZE", outputAction: "ANONYMIZE" },
];

/** The document regexes of G1 and G3 are exactly mask.ts's `GUARDRAIL_REGEXES` (CLABE, CURP, RFC): same objects, no copy. */
export const DOCUMENT_REGEXES = GUARDRAIL_REGEXES;

export interface GroundingFilter {
  readonly type: "GROUNDING" | "RELEVANCE";
  readonly threshold: number;
}

/** Contextual grounding of G2. A text below either threshold does not leave (`GROUNDING_FAIL`). */
export const GROUNDING_FILTERS: readonly GroundingFilter[] = [
  { type: "GROUNDING", threshold: 0.75 },
  { type: "RELEVANCE", threshold: 0.5 },
];

/**
 * What the outbound pipeline may hand G2 in one `ApplyGuardrail` (docs/architecture.md §9.4): the query
 * built by code (the installer's question, on a REPLY), the grounding source (`Runtime/TURN#` results,
 * with the passages of `search_procedures`) and the guarded content. Longer inputs are cut first.
 */
export const G2_LIMITS = {
  queryMaxChars: 1_000,
  groundingSourceMaxChars: 100_000,
  contentMaxChars: 5_000,
} as const;

/** Tier of the topic and content policies; CLASSIC covers Spanish and English with no cross-region profile. */
export const GUARDRAIL_TIER = "CLASSIC";

export type GuardrailKey = "g1" | "g2" | "g3";

/**
 * What Bedrock returns instead of a blocked text. It never reaches a person: the worker, the pipeline
 * and the certificate writer detect the block and act on its assessment (a fixed text of
 * packages/bff/src/copy/, a case or `GROUNDING_FAIL`). A token, not a sentence, so a leak fails the
 * outbound language check and is recognizable in any log.
 */
export const BLOCKED_MESSAGES: Readonly<Record<GuardrailKey, { readonly input: string; readonly output: string }>> = {
  g1: { input: "CUADRILLA_GUARDRAIL_G1_INPUT_BLOCKED", output: "CUADRILLA_GUARDRAIL_G1_OUTPUT_BLOCKED" },
  g2: { input: "CUADRILLA_GUARDRAIL_G2_INPUT_BLOCKED", output: "CUADRILLA_GUARDRAIL_G2_OUTPUT_BLOCKED" },
  g3: { input: "CUADRILLA_GUARDRAIL_G3_INPUT_BLOCKED", output: "CUADRILLA_GUARDRAIL_G3_OUTPUT_BLOCKED" },
};

// ---- Provider-shaped configuration (aws.bedrock.GuardrailArgs), built here so the test sees exactly
// what infra/guardrail.ts sends. Arrays stay mutable because the provider's input types are. ---------

interface TierConfig {
  tierName: string;
}

interface TopicPolicyConfig {
  tierConfigs: TierConfig[];
  topicsConfigs: { name: string; definition: string; examples: string[]; type: "DENY" }[];
}

interface ContentPolicyConfig {
  tierConfigs: TierConfig[];
  filtersConfigs: { type: string; inputStrength: FilterStrength; outputStrength: FilterStrength; inputModalities: string[]; outputModalities: string[] }[];
}

interface SensitiveSide {
  /** Legacy single-side field the API still requires; it mirrors the input side. */
  action: PiiAction;
  inputAction: PiiAction;
  inputEnabled: boolean;
  outputAction: PiiAction;
  outputEnabled: boolean;
}

interface SensitiveInformationPolicyConfig {
  piiEntitiesConfigs: (SensitiveSide & { type: string })[];
  regexesConfigs: (SensitiveSide & { name: string; description: string; pattern: string })[];
}

export interface GuardrailPolicyConfig {
  topicPolicyConfig?: TopicPolicyConfig;
  contentPolicyConfig?: ContentPolicyConfig;
  sensitiveInformationPolicyConfig?: SensitiveInformationPolicyConfig;
  contextualGroundingPolicyConfig?: { filtersConfigs: { type: string; threshold: number }[] };
}

const topicPolicyConfig: TopicPolicyConfig = {
  tierConfigs: [{ tierName: GUARDRAIL_TIER }],
  topicsConfigs: DENIED_TOPICS.map((topic) => ({
    name: topic.name,
    definition: topic.definition,
    examples: [...topic.examples.es, ...topic.examples.en],
    type: "DENY",
  })),
};

const side = (input: PiiAction, output: PiiAction, outputEnabled = true): SensitiveSide => ({
  action: input,
  inputAction: input,
  inputEnabled: true,
  outputAction: output,
  outputEnabled,
});

/** G1: denied topics, prompt attack, cards blocked, CURP/RFC/CLABE anonymized on input, contacts left alone. */
export const G1_POLICIES: GuardrailPolicyConfig = {
  topicPolicyConfig,
  contentPolicyConfig: {
    tierConfigs: [{ tierName: GUARDRAIL_TIER }],
    filtersConfigs: CONTENT_FILTERS.map((filter) => ({
      type: filter.type,
      inputStrength: filter.inputStrength,
      outputStrength: filter.outputStrength,
      inputModalities: ["TEXT"],
      outputModalities: ["TEXT"],
    })),
  },
  sensitiveInformationPolicyConfig: {
    piiEntitiesConfigs: G1_PII_ENTITIES.map((entity) => ({ type: entity.type, ...side(entity.inputAction, entity.outputAction) })),
    // Input only: the Harness output reaches nobody without G2 and the outbound checks, and the
    // pre-filter only ever evaluates INPUT.
    regexesConfigs: DOCUMENT_REGEXES.map((regex) => ({ name: regex.name, description: regex.description, pattern: regex.pattern, ...side("ANONYMIZE", "NONE", false) })),
  },
};

/** G2: contextual grounding and relevance, plus G1's denied topics evaluated on the outbound text. */
export const G2_POLICIES: GuardrailPolicyConfig = {
  topicPolicyConfig,
  contextualGroundingPolicyConfig: { filtersConfigs: GROUNDING_FILTERS.map((filter) => ({ ...filter })) },
};

/** G3: PII only, the same action on both sides. */
export const G3_POLICIES: GuardrailPolicyConfig = {
  sensitiveInformationPolicyConfig: {
    piiEntitiesConfigs: G3_PII_ENTITIES.map((entity) => ({ type: entity.type, ...side(entity.inputAction, entity.outputAction) })),
    regexesConfigs: DOCUMENT_REGEXES.map((regex) => ({ name: regex.name, description: regex.description, pattern: regex.pattern, ...side("ANONYMIZE", "ANONYMIZE") })),
  },
};

export const GUARDRAIL_POLICIES: Readonly<Record<GuardrailKey, GuardrailPolicyConfig>> = { g1: G1_POLICIES, g2: G2_POLICIES, g3: G3_POLICIES };

/**
 * Digest of everything a guardrail's DRAFT holds (policies and blocked messages).
 * `aws.bedrock.GuardrailVersion` has no updatable field, so the digest goes in its description: any
 * change replaces the version and publishes a new number on the same deploy.
 */
export function guardrailDigest(policies: GuardrailPolicyConfig, blockedMessages: { readonly input: string; readonly output: string }): string {
  return createHash("sha256").update(JSON.stringify({ policies, blockedMessages })).digest("hex").slice(0, 16);
}
