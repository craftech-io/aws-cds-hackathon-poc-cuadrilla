// The decisions of a send before anything leaves (docs/design-brief.md §5.5 and §5.7):
//
//   policy        the fifteen `CP-*` rules over the message, its recipient and the facts of the
//                 records at the instant (policy/engine.ts); the text the content rules read is the
//                 one that would leave (the rendered template body for a template)
//   G3            over every template parameter: masked, then anonymized or blocked
//   G2            over the text the agent wrote (and a summary it wrote): grounded in the turn's tool
//                 results, relevant to the installer's question for a `REPLY` (agent/grounding.ts)
//   verification  facts, citations, sensitive asks, links and language (verify/) of what would leave
//
// Each step answers what it found; pipeline.ts turns a failure into the refusal, its audit and its log.
import type { Guardrail, ManualSectionId, MessageKind } from "@cuadrilla/shared";
import type { TurnResult } from "../domain/runtime";
import { g2RefusalRecord, type G2RefusalRecord } from "../agent/grounding";
import { type PolicyDecision, evaluate } from "../policy/engine";
import { policyInputAt } from "../policy/context";
import { consoleCaseUrl } from "../policy/rules-content";
import type { PolicyMessage } from "../policy/types";
import type { z } from "zod";
import { type SendContext, questionOf } from "./context";
import type { OutboundDeps } from "./deps";
import { GuardrailUnavailableError, groundingSourceOf, queryOf } from "./grounding";
import { maskParams } from "./g3";
import { authorKindOf } from "./persist";
import { displayTextOf, formOf } from "./render/whatsapp";
import { OUTBOUND_REASON, type EmailSendOutbound, type OutboundRequest, type WhatsAppSendRequest } from "./types";
import { type TextSource, type VerifyFailure, claimsPolicy, verifyContent } from "./verify/index";

export function textSourceOf(request: OutboundRequest): TextSource {
  if (request.textSource !== undefined) return request.textSource;
  const author = authorKindOf(request.author);
  return author === "AGENT" ? "MODEL" : author === "PERSON" ? "PERSON" : "CODE";
}

/** The text a send would leave with, as the content rules and the checks read it. */
export function outgoingTextOf(request: OutboundRequest): string | undefined {
  if (request.channel === "EMAIL") return `${request.subject}\n${request.text}`;
  // A template's parameters leave masked (G3's deterministic layer): the rules read them that way.
  if (request.template !== undefined) return displayTextOf({ ...request, template: { ...request.template, params: [...maskParams(request.template.params).texts] } });
  return displayTextOf(request);
}

function whatsAppPolicyMessage(request: WhatsAppSendRequest, text: string | undefined): z.input<typeof PolicyMessage> {
  const author = authorKindOf(request.author);
  return {
    kind: request.kind,
    channel: "WHATSAPP",
    form: formOf(request),
    author,
    ...(request.template === undefined ? {} : { templateName: request.template.name }),
    ...(request.notice === undefined ? {} : { notice: request.notice }),
    ...(text === undefined ? {} : { text }),
    citations: [...request.citations],
    claimsPolicy: author === "AGENT" && request.kind === "REPLY" && text !== undefined && claimsPolicy(text),
    inResponseToInbound: request.inResponseToInbound,
    ...(request.caseId === undefined ? {} : { caseId: request.caseId }),
    ...(request.workOrderId === undefined ? {} : { workOrderId: request.workOrderId }),
    ...(request.attachmentSha256 === undefined ? {} : { attachmentSha256: request.attachmentSha256 }),
  };
}

function emailPolicyMessage(request: EmailSendOutbound): z.input<typeof PolicyMessage> {
  return {
    kind: request.kind,
    channel: "EMAIL",
    form: "EMAIL",
    author: authorKindOf(request.author),
    text: `${request.subject}\n${request.text}`,
    workOrderId: request.workOrderId,
    ...(request.caseId === undefined ? {} : { caseId: request.caseId }),
    ...(request.attachment === undefined ? {} : { attachmentSha256: request.attachment.sha256 }),
  };
}

/** Step 4: the contact policy at the context's instant. */
export function decidePolicy(request: OutboundRequest, context: SendContext): PolicyDecision {
  if (request.channel === "EMAIL" && context.channel === "EMAIL") {
    return evaluate(policyInputAt(emailPolicyMessage(request), { kind: "EMAIL", role: request.toRole, fence: context.fence }, context.records, context.at));
  }
  if (request.channel === "WHATSAPP" && context.channel === "WHATSAPP") {
    return evaluate(policyInputAt(whatsAppPolicyMessage(request, outgoingTextOf(request)), { kind: "PERSON", route: context.policyRoute }, context.records, context.at));
  }
  throw new RangeError("the context does not belong to the request's channel");
}

// ---- G2 and the verification -------------------------------------------------------------------------

export type ContentOutcome =
  | { readonly ok: true; readonly guardrail?: Guardrail }
  | { readonly ok: false; readonly unavailable?: true; readonly guardrail?: Guardrail; readonly failures: readonly VerifyFailure[]; readonly g2?: G2RefusalRecord };

const G2_DETAIL: Readonly<Record<G2RefusalRecord["reason"], string>> = {
  GROUNDING: "G2: the text is not grounded in this turn's tool results",
  RELEVANCE: "G2: the reply does not answer the installer's message",
  BLOCKED: "G2: the text touches a denied topic",
  TOO_LONG: "G2: the text is longer than G2 can check whole",
};

/** What G2 and the verification read of one text. */
export interface ContentInput {
  readonly kind: MessageKind;
  readonly source: TextSource;
  readonly text?: string;
  readonly templateParams?: readonly string[];
  /** Tool results of the turn (G2's grounding source, the facts' sources). */
  readonly results: readonly Pick<TurnResult, "tool" | "output">[];
  /** The installer's text a `REPLY` answers. */
  readonly question?: string;
  readonly citation?: { readonly cited: readonly ManualSectionId[]; readonly turnSections?: readonly string[] };
  readonly allowedUrls?: readonly string[];
}

async function runG2(deps: OutboundDeps, input: ContentInput, text: string): Promise<{ readonly guardrail?: Guardrail; readonly refused?: G2RefusalRecord; readonly unavailable?: true }> {
  const limits = deps.g2Limits();
  try {
    const verdict = await deps.g2.check({ kind: input.kind, text, groundingSource: groundingSourceOf(input.results, limits.groundingSourceMaxChars), query: queryOf(input.kind, input.question, limits.queryMaxChars) });
    const guardrail: Guardrail = { action: verdict.action, ...(verdict.groundingScore === undefined ? {} : { groundingScore: verdict.groundingScore }) };
    if (verdict.failure === undefined) return { guardrail };
    return { guardrail, refused: g2RefusalRecord({ ...verdict, reason: verdict.failure }) };
  } catch (error) {
    if (error instanceof GuardrailUnavailableError) return { unavailable: true };
    throw error;
  }
}

/** G2 over a text the model wrote, then the deterministic verification. */
export async function checkText(deps: OutboundDeps, input: ContentInput): Promise<ContentOutcome> {
  const { text } = input;
  let guardrail: Guardrail | undefined;
  if (input.source === "MODEL" && text !== undefined) {
    const g2 = await runG2(deps, input, text);
    if (g2.unavailable === true) return { ok: false, unavailable: true, failures: [] };
    guardrail = g2.guardrail;
    if (g2.refused !== undefined) return { ok: false, failures: [{ check: "FACTS", detail: G2_DETAIL[g2.refused.reason] }], g2: g2.refused, ...(guardrail === undefined ? {} : { guardrail }) };
  }
  const failures = verifyContent({
    textSource: input.source,
    ...(text === undefined ? {} : { text }),
    ...(input.templateParams === undefined ? {} : { templateParams: input.templateParams }),
    sources: input.results.map((result) => result.output),
    ...(input.citation === undefined ? {} : { citation: input.citation }),
    ...(input.allowedUrls === undefined ? {} : { allowedUrls: input.allowedUrls }),
  });
  if (failures.length > 0) return { ok: false, failures, ...(guardrail === undefined ? {} : { guardrail }) };
  return { ok: true, ...(guardrail === undefined ? {} : { guardrail }) };
}

/** Steps 6 and 7 of the pipeline for one send (after G3: the parameters as they would leave). */
export function checkContent(deps: OutboundDeps, request: OutboundRequest, context: SendContext): Promise<ContentOutcome> {
  const agentReply = request.channel === "WHATSAPP" && request.kind === "REPLY" && authorKindOf(request.author) === "AGENT";
  const question = request.channel === "WHATSAPP" && context.channel === "WHATSAPP" ? questionOf(request, context) : undefined;
  const text = request.channel === "EMAIL" ? request.text : request.template === undefined ? outgoingTextOf(request) : undefined;
  const caseId = request.caseId;
  return checkText(deps, {
    kind: request.kind,
    source: textSourceOf(request),
    ...(text === undefined ? {} : { text }),
    ...(request.channel === "WHATSAPP" && request.template !== undefined ? { templateParams: request.template.params } : {}),
    results: context.results,
    ...(question === undefined ? {} : { question }),
    ...(agentReply ? { citation: { cited: request.citations, ...(context.records.turnSections === undefined ? {} : { turnSections: context.records.turnSections }) } } : {}),
    allowedUrls: request.kind === "ZONE_CHIEF_ALERT" && caseId !== undefined ? [consoleCaseUrl(caseId)] : [],
  });
}

// ---- G3 -------------------------------------------------------------------------------------------------

export type ParamsOutcome = { readonly ok: true; readonly params?: readonly string[] } | { readonly ok: false; readonly reason: string; readonly unavailable?: true };

/** Step 5: every template parameter masked and through G3; a block refuses the message. */
export async function checkTemplateParams(deps: OutboundDeps, request: OutboundRequest): Promise<ParamsOutcome> {
  if (request.channel !== "WHATSAPP" || request.template === undefined || request.template.params.length === 0) return { ok: true };
  try {
    const result = await deps.g3.check(request.template.params);
    if (result.action === "BLOCKED") return { ok: false, reason: OUTBOUND_REASON.G3_BLOCKED };
    return { ok: true, params: result.texts };
  } catch (error) {
    if (error instanceof GuardrailUnavailableError) return { ok: false, reason: OUTBOUND_REASON.GUARDRAIL_UNAVAILABLE, unavailable: true };
    throw error;
  }
}

