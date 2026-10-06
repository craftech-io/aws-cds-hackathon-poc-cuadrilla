// The outbound pipeline (docs/tool-catalog.md, target `messaging`; docs/design-brief.md §5.5-§5.7;
// ADR-0012, ADR-0014, ADR-0028): the one path every message takes out of Cuadrilla. In order:
//
//   0. shape      the request (zod) and what the transports would refuse (render/whatsapp.ts); a
//                 request whose message already exists is answered from it, never sent twice
//   1. context    the recipient from the registry (`LAM-RECIPIENT`) and its route, the policy records
//                 at the instant, the turn's tool results and the person's thread (context.ts)
//   2. repeat     the same WhatsApp asked twice in one turn is answered from the first (repeat.ts)
//   3. bridge     `LAM-BRIDGE`: with a case `TAKEN` on the order the agent does not write
//   4. policy     the fifteen `CP-*` rules (checks.ts); a denial is audited and, but for the agent's own
//                 text, kept in the thread as `DENIED`
//   5. G3         over every template parameter (masked, then anonymized or blocked)
//   6. G2         over the agent's text (and a summary it wrote); a refusal logs `outbound.g2_refused`
//                 and audits its reason, scores and thresholds, never the text
//   7. verify     facts, citations, sensitive asks, links and language (verify/) of what would leave
//   8. deferral   a time rule that deferred the send: `TIMER#DEFERRED_SEND` and the message `DEFERRED`
//   9. delivery   the `ALLOW`, the message `QUEUED`, the transport of the route or the SES client with
//                 its fence (deliver.ts)
//
// Nothing here throws to the caller for a refusal: the result says SENT, DEFERRED or REFUSED with the
// tool error (`{code, message, reason}`) the send tools answer. Only an unexpected failure throws.
import { ToolError, type ToolFailure, fail, type RuleId } from "@cuadrilla/shared";
import { localDateOf } from "../services/business-hours/zoned-time";
import type { Message } from "../domain/conversations";
import type { Timer } from "../domain/timers";
import type { PolicyDecision } from "../policy/engine";
import { errorCodeOf, toMessagePolicy } from "../policy/result";
import { type ContentOutcome, checkContent, checkTemplateParams, decidePolicy } from "./checks";
import { type SendContext, type WhatsAppContext, loadEmailContext, loadWhatsAppContext } from "./context";
import { deferSend, firedRequest } from "./defer";
import type { OutboundDeps } from "./deps";
import { deliverEmail, deliverWhatsApp } from "./deliver";
import { appendOutMessage, auditPolicyDecision, auditRefusal, authorKindOf } from "./persist";
import { shapeOf } from "./render/whatsapp";
import { contentKeyOf, repeatedInTurn } from "./repeat";
import { OUTBOUND_REASON, OutboundRequest, type OutboundCall, type OutboundInput, type OutboundRefused, type OutboundResult, type WhatsAppSendRequest } from "./types";

export const BRIDGE_RULE = "LAM-BRIDGE";

const SENT_STATUSES = new Set<Message["status"]>(["QUEUED", "SENT", "DELIVERED", "READ"]);

/** The answer of a request whose message already exists (redelivered event, or a repeat in the turn). */
export function replayOf(message: Message): OutboundResult {
  const { messageId } = message;
  if (message.status === "DEFERRED") {
    const nextAllowedAt = typeof message.refs?.nextAllowedAt === "string" ? message.refs.nextAllowedAt : message.sentAtSim;
    const timerKey = typeof message.refs?.timerKey === "string" ? message.refs.timerKey : "";
    return { status: "DEFERRED", messageId, replayOf: messageId, nextAllowedAt, timerKey };
  }
  if (SENT_STATUSES.has(message.status)) return { status: "SENT", messageId, replayOf: messageId, ...(message.providerMessageId === undefined ? {} : { providerMessageId: message.providerMessageId }) };
  return { status: "REFUSED", messageId, failure: fail("CONFLICT", "this message was already decided and did not go out", OUTBOUND_REASON.SEND_FAILED), ruleIds: [...(message.policy?.ruleIds ?? [])] };
}

function refused(failure: ToolFailure, ruleIds: readonly RuleId[], extra: Omit<OutboundRefused, "status" | "failure" | "ruleIds"> = {}): OutboundRefused {
  return { status: "REFUSED", failure, ruleIds, ...extra };
}

async function refusePolicy(deps: OutboundDeps, call: OutboundCall, request: OutboundRequest, context: SendContext, decision: PolicyDecision, messageId: string): Promise<OutboundRefused> {
  const decisionId = await auditPolicyDecision(deps, call, request, context, decision, { messageId });
  if (request.channel === "WHATSAPP" && context.channel === "WHATSAPP") {
    // The agent's own text stays out of the thread when it was refused; a system message keeps its place.
    const keepText = authorKindOf(request.author) !== "AGENT" ? request.text : undefined;
    await appendOutMessage(deps, request, context, { messageId, status: "DENIED", content: request.template === undefined ? "TEXT" : "TEMPLATE", ...(keepText === undefined ? {} : { text: keepText }), policy: toMessagePolicy(decision, decisionId) });
  }
  call.log.warn("outbound.refused", { messageId, rule: decision.deniedBy, reason: decision.reason });
  const code = errorCodeOf(decision) ?? "POLICY_DENIED";
  const message = code === "TEMPLATE_REQUIRED" ? "the 24-hour window is closed: nothing was sent" : `the contact policy held the message back (${decision.reason ?? "denied"})`;
  return refused(fail(code, message, decision.deniedBy), decision.ruleIds, { messageId, decision, ...(decision.deniedBy === "CP-WA-24H" ? { window: "TEMPLATE_REQUIRED" as const } : {}) });
}

async function refuseContent(deps: OutboundDeps, call: OutboundCall, request: OutboundRequest, context: SendContext, decision: PolicyDecision, outcome: Exclude<ContentOutcome, { ok: true }>, messageId: string): Promise<OutboundRefused> {
  const guardrail = outcome.guardrail === undefined ? {} : { guardrail: outcome.guardrail };
  if (outcome.unavailable === true) {
    await auditRefusal(deps, call, request, context, { ruleIds: ["G2"], reason: OUTBOUND_REASON.GUARDRAIL_UNAVAILABLE, messageId });
    return refused(fail("UNAVAILABLE", "the output guardrail is not available; try again later", OUTBOUND_REASON.GUARDRAIL_UNAVAILABLE), ["G2"], { messageId, decision });
  }
  const ruleIds: RuleId[] = outcome.g2 !== undefined ? ["G2"] : outcome.failures.some((failure) => failure.check === "CITATION") ? ["CP-CITATION"] : [];
  if (outcome.g2 !== undefined) call.log.warn("outbound.g2_refused", { messageId, kind: request.kind, ...outcome.g2 });
  const checks = outcome.failures.map((failure) => failure.check);
  await auditRefusal(deps, call, request, context, {
    ruleIds,
    reason: OUTBOUND_REASON.GROUNDING_FAIL,
    messageId,
    detail: { checks, failures: outcome.failures.map((failure) => failure.detail), ...(outcome.g2 === undefined ? {} : { g2: { ...outcome.g2 } }) },
  });
  if (outcome.g2 === undefined) call.log.warn("outbound.refused", { messageId, checks });
  const message = `the text cannot go out: ${outcome.failures.map((failure) => failure.detail).join("; ")}. Use only values a tool returned in this turn and cite the manual, or offer to escalate.`;
  return refused(fail("GROUNDING_FAIL", message.slice(0, 900), OUTBOUND_REASON.GROUNDING_FAIL), ruleIds, { messageId, decision, ...guardrail });
}

function bridgeActive(request: WhatsAppSendRequest, context: WhatsAppContext): boolean {
  return request.workOrderId !== undefined && (context.records.cases ?? []).some((item) => item.status === "TAKEN" && item.workOrderId === request.workOrderId);
}

async function sendWhatsApp(deps: OutboundDeps, call: OutboundCall, asked: OutboundInput, request: WhatsAppSendRequest): Promise<OutboundResult> {
  if (request.messageId !== undefined) {
    const existing = await deps.connector.conversations.findMessage(request.personId, request.messageId);
    if (existing !== undefined) return replayOf(existing);
  }
  const context = await loadWhatsAppContext(deps, request);
  const messageId = request.messageId ?? `msg-${deps.newId()}`;
  const day = localDateOf(new Date(context.at.sim), context.settings.timezone);
  await shapeOf(request, { to: context.person.phone ?? "", personId: context.person.personId, phoneHash: context.person.phoneHash ?? "", clockId: context.clockId, messageId, day });
  const repeated = repeatedInTurn(request, context.history);
  if (repeated !== undefined) {
    call.log.warn("outbound.repeated_in_turn", { messageId: repeated.messageId, turnId: request.turnId });
    return replayOf(repeated);
  }
  if (authorKindOf(request.author) === "AGENT" && bridgeActive(request, context)) {
    await auditRefusal(deps, call, request, context, { ruleIds: [BRIDGE_RULE], reason: "BRIDGE_ACTIVE", messageId });
    return refused(fail("BRIDGE_ACTIVE", "a supervisor took the case of this order: the bridge speaks, not the agent", BRIDGE_RULE), [BRIDGE_RULE], { messageId });
  }
  return decideAndSend(deps, call, asked, request, context, messageId);
}

async function decideAndSend(deps: OutboundDeps, call: OutboundCall, asked: OutboundInput, request: OutboundRequest, context: SendContext, messageId: string): Promise<OutboundResult> {
  const decision = decidePolicy(request, context);
  if (decision.outcome === "DENY") return refusePolicy(deps, call, request, context, decision, messageId);
  const params = await checkTemplateParams(deps, request);
  if (!params.ok) {
    const ruleIds: RuleId[] = ["G3"];
    await auditRefusal(deps, call, request, context, { ruleIds, reason: params.reason, messageId });
    const failure = params.unavailable === true ? fail("UNAVAILABLE", "the template guardrail is not available; try again later", params.reason) : fail("POLICY_DENIED", "a template parameter carries data that may not leave", params.reason);
    return refused(failure, ruleIds, { messageId, decision });
  }
  // What leaves is what G3 let out: the verification reads the masked parameters.
  const checked: OutboundRequest = request.channel === "WHATSAPP" && request.template !== undefined && params.params !== undefined ? { ...request, template: { ...request.template, params: [...params.params] } } : request;
  const content = await checkContent(deps, checked, context);
  if (!content.ok) return refuseContent(deps, call, checked, context, decision, content, messageId);
  if (decision.outcome === "DEFER") return deferSend(deps, call, { asked, request, context, decision, messageId });
  const guardrail = content.guardrail === undefined ? {} : { guardrail: content.guardrail };
  if (checked.channel === "EMAIL" && context.channel === "EMAIL") return deliverEmail(deps, call, { request: checked, context, decision, messageId, ...guardrail });
  if (checked.channel === "WHATSAPP" && request.channel === "WHATSAPP" && context.channel === "WHATSAPP") {
    return deliverWhatsApp(deps, call, { request: checked, context, decision, messageId, contentKey: contentKeyOf(request), ...guardrail });
  }
  throw new RangeError("the context does not belong to the request's channel");
}

/** The pipeline for one send. */
export async function sendOutbound(deps: OutboundDeps, asked: OutboundInput, call: OutboundCall): Promise<OutboundResult> {
  const parsed = OutboundRequest.safeParse(asked);
  if (!parsed.success) {
    call.log.warn("outbound.invalid", { issues: parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".")}: ${issue.message}`) });
    return refused(fail("INVALID", "the message is not valid", OUTBOUND_REASON.CONTENT_INVALID), []);
  }
  const request = parsed.data;
  const scoped: OutboundCall = { ...call, log: call.log.child({ service: "outbound", channel: request.channel, kind: request.kind }) };
  try {
    if (request.channel === "WHATSAPP") return await sendWhatsApp(deps, scoped, asked, request);
    const context = await loadEmailContext(deps, request);
    return await decideAndSend(deps, scoped, asked, request, context, request.messageId ?? `mail-${deps.newId()}`);
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    scoped.log.warn("outbound.refused", { code: error.code, reason: error.reason });
    return refused(error.toFailure(), []);
  }
}

/** A `TIMER#DEFERRED_SEND` that fired: the same request decided again at the firing instant. */
export function fireDeferredSend(deps: OutboundDeps, timer: Pick<Timer, "kind" | "payload">, eventAtSim: string, call: OutboundCall): Promise<OutboundResult> {
  return sendOutbound(deps, firedRequest(timer, eventAtSim), call);
}
