// What the pipeline writes: the outbound `Message` of the person's thread (`Conversations`, what the
// console's timeline and the simulator draw) and one `AuditLog` row per decision (`ALLOW` with the
// message id and every rule evaluated, which `PolicyAudit` re-checks; `DENY` with the rule or check
// that refused; `DEFER` with its timer). Texts never go to the audit: ids, rules and scores only.
import type { RuleId } from "@cuadrilla/shared";
import type { AuditRefs } from "../domain/audit";
import type { Actor, JsonObject } from "../domain/common";
import type { Message, MessageContent, MessagePolicy } from "../domain/conversations";
import { type PolicyDecision } from "../policy/engine";
import { toDecisionInput } from "../policy/result";
import type { AuthorKind } from "../policy/types";
import type { OutboundDeps } from "./deps";
import type { WhatsAppContext } from "./context";
import { CONTENT_KEY_REF, contentKeyOf } from "./repeat";
import { OUTBOUND_ACTION, type OutboundCall, type OutboundRequest, type WhatsAppSendRequest } from "./types";

/** The policy's author of an actor: the agent, a person on the bridge, or code. */
export function authorKindOf(author: Actor): AuthorKind {
  if (author === "AGENT") return "AGENT";
  return author.startsWith("PERSON:") ? "PERSON" : "SYSTEM";
}

/** `Message.author`: `AGENT`, `PERSON:<id>`, or `SYSTEM` for every other code path. */
export function messageAuthorOf(author: Actor): string {
  return authorKindOf(author) === "SYSTEM" ? "SYSTEM" : author;
}

export function actionOf(request: Pick<OutboundRequest, "channel">): string {
  return request.channel === "EMAIL" ? OUTBOUND_ACTION.EMAIL : OUTBOUND_ACTION.WHATSAPP;
}

/** The message's own references: what it talks about (ids only) and its content key (repeat guard). */
export function messageRefsOf(request: WhatsAppSendRequest): JsonObject {
  return {
    ...(request.refs ?? {}),
    ...(request.citations.length === 0 ? {} : { citations: [...request.citations] }),
    ...(request.notice === undefined ? {} : { notice: request.notice }),
    ...(request.replyToWamid === undefined ? {} : { replyTo: request.replyToWamid }),
    [CONTENT_KEY_REF]: contentKeyOf(request),
  };
}

export interface OutMessage {
  readonly messageId: string;
  readonly status: Message["status"];
  readonly content: MessageContent;
  readonly text?: string;
  readonly templateParams?: readonly string[];
  readonly interactive?: JsonObject;
  readonly media?: { readonly kind: "IMAGE" | "DOCUMENT"; readonly s3Key: string; readonly mime: string; readonly sha256?: string };
  readonly policy?: MessagePolicy;
  readonly extraRefs?: JsonObject;
}

/** Appends the outbound message to the person's thread. */
export async function appendOutMessage(deps: Pick<OutboundDeps, "connector">, request: WhatsAppSendRequest, context: WhatsAppContext, out: OutMessage): Promise<Message> {
  return deps.connector.conversations.appendMessage({
    messageId: out.messageId,
    personId: context.person.personId,
    ispId: context.ispId,
    clockId: context.clockId,
    direction: "OUT",
    channel: "WHATSAPP",
    content: out.content,
    kind: request.kind,
    ...(request.workOrderId === undefined ? {} : { workOrderId: request.workOrderId }),
    ...(request.caseId === undefined ? {} : { caseId: request.caseId }),
    ...(out.text === undefined ? {} : { text: out.text.slice(0, 4096) }),
    ...(request.template === undefined ? {} : { templateName: request.template.name, templateParams: [...(out.templateParams ?? request.template.params)] }),
    ...(out.interactive === undefined ? {} : { interactive: out.interactive }),
    ...(out.media === undefined ? {} : { media: { ...out.media } }),
    status: out.status,
    ...(out.policy === undefined ? {} : { policy: out.policy }),
    author: messageAuthorOf(request.author),
    ...(request.turnId === undefined ? {} : { turnId: request.turnId }),
    simulated: context.route.transport === "simulated",
    transport: context.route.transport,
    sentAtSim: context.at.sim,
    refs: { ...messageRefsOf(request), ...(out.extraRefs ?? {}) },
  });
}

/** The references every decision row of a send carries. */
export function decisionRefs(call: OutboundCall, request: OutboundRequest, extra: AuditRefs = {}): AuditRefs {
  return {
    ...(call.refs ?? {}),
    ...(request.workOrderId === undefined ? {} : { workOrderId: request.workOrderId }),
    ...(request.caseId === undefined ? {} : { caseId: request.caseId }),
    ...(request.turnId === undefined ? {} : { turnId: request.turnId }),
    kind: request.kind,
    ...extra,
  };
}

/** The audit row of a policy decision (`ALLOW`, `DENY` or `DEFER`), with every rule evaluated. */
export async function auditPolicyDecision(
  deps: Pick<OutboundDeps, "connector">,
  call: OutboundCall,
  request: OutboundRequest,
  context: { readonly ispId: string; readonly clockId: string },
  decision: PolicyDecision,
  extra: { readonly messageId?: string; readonly refs?: AuditRefs } = {},
): Promise<string> {
  const row = await deps.connector.audit.append(
    toDecisionInput(decision, {
      ispId: context.ispId,
      clockId: context.clockId,
      action: actionOf(request),
      actor: call.actor,
      ...(extra.messageId === undefined ? {} : { messageId: extra.messageId }),
      ...(request.trigger === undefined ? {} : { trigger: request.trigger }),
      refs: decisionRefs(call, request, extra.refs),
    }),
  );
  return row.decisionId;
}

/** The audit row of a refusal that is not the policy's (G2, G3, the verification, a transport failure). */
export async function auditRefusal(
  deps: Pick<OutboundDeps, "connector">,
  call: OutboundCall,
  request: OutboundRequest,
  context: { readonly ispId: string; readonly clockId: string; readonly at: { readonly sim: string } },
  refusal: { readonly ruleIds: readonly RuleId[]; readonly reason: string; readonly messageId?: string; readonly detail?: JsonObject },
): Promise<void> {
  await deps.connector.audit.append({
    ispId: context.ispId,
    clockId: context.clockId,
    atSim: context.at.sim,
    decision: "DENY",
    action: actionOf(request),
    ruleIds: [...refusal.ruleIds],
    actor: call.actor,
    ...(refusal.messageId === undefined ? {} : { messageId: refusal.messageId }),
    ...(request.trigger === undefined ? {} : { trigger: request.trigger }),
    refs: decisionRefs(call, request),
    reason: refusal.reason.slice(0, 200),
    ...(refusal.detail === undefined ? {} : { detail: refusal.detail }),
  });
}
