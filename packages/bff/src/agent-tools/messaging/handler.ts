// `send_whatsapp` (docs/tool-catalog.md, target `messaging`; ADR-0014): the only way the agent speaks.
// The recipient is the installer of the session (`LAM-RECIPIENT`, never an id the model wrote); the
// orders and the case the model names in `refs` must be in the session's scope (`LAM-SCOPE`); the
// message is the agent's own words, so everything after this goes through the outbound pipeline:
// `LAM-BRIDGE`, the contact policy, G2 with the installer's message as its query (or the fixed status
// question for a greeting, ADR-0028), the deterministic verification, the transport of the installer's
// route, `Conversations` and `AuditLog`. A repeat of the same text in the turn is answered from the
// first message (outbound/repeat.ts). The tool never throws: every refusal is `{ ok: false, error }`.
import type { z } from "zod";
import { type PolicyResult, type ToolFailure, ToolError } from "@cuadrilla/shared";
import { toPolicyResult } from "../../policy/result";
import type { OutboundDeps } from "../../outbound/deps";
import { sendOutbound } from "../../outbound/pipeline";
import type { OutboundResult, WhatsAppSendInput } from "../../outbound/types";
import { type ToolContext, type ToolRuntime, implementTool } from "../common/context";
import { authorizeCase, authorizeWorkOrders } from "../common/scope";
import { sendWhatsappTool } from "./schema";

/** The target's dependencies: the tool runtime plus the pipeline of the Lambda. */
export interface MessagingRuntime extends ToolRuntime {
  readonly outbound: () => OutboundDeps;
}

type SendArgs = z.output<typeof sendWhatsappTool.args>;

/** Triggers whose turn answers a message of the installer (quiet hours exempt the reply). */
const ANSWERING_TRIGGERS = new Set(["INSTALLER_MESSAGE", "ORDERS_REQUESTED"]);

/** A Meta or simulator `wamid`: the only id a reply context may carry. */
const WAMID = /^wamid\.[A-Za-z0-9_.:=+/-]{1,240}$/;

const ALLOWED: PolicyResult = { allowed: true, ruleIds: [] };

async function requestOf(args: SendArgs, ctx: ToolContext<MessagingRuntime>): Promise<WhatsAppSendInput> {
  const { scope, identity } = ctx;
  if (identity.kind !== "HARNESS" || scope.installerId === undefined || scope.eventAtSim === undefined) {
    throw new ToolError("FORBIDDEN", "send_whatsapp speaks only for a turn of the agent", "LAM-RECIPIENT");
  }
  const orders = await authorizeWorkOrders(ctx, args.refs?.workOrderIds ?? []);
  if (args.refs?.caseId !== undefined) await authorizeCase(ctx, args.refs.caseId);
  const trigger = identity.session.trigger;
  const source = scope.sourceMessageId;
  const refs = {
    ...(orders.length === 0 ? {} : { workOrderIds: orders.map((order) => order.workOrderId) }),
    ...(args.refs?.items === undefined ? {} : { items: [...args.refs.items] }),
    ...(args.refs?.tipIds === undefined ? {} : { tipIds: [...args.refs.tipIds] }),
  };
  return {
    channel: "WHATSAPP",
    personId: scope.installerId,
    kind: args.kind,
    author: "AGENT",
    eventAtSim: scope.eventAtSim,
    trigger,
    ...(scope.turnId === undefined ? {} : { turnId: scope.turnId }),
    ...(scope.workOrderId === undefined ? {} : { workOrderId: scope.workOrderId }),
    ...(args.refs?.caseId === undefined ? {} : { caseId: args.refs.caseId }),
    inResponseToInbound: ANSWERING_TRIGGERS.has(trigger),
    ...(source !== undefined && WAMID.test(source) ? { replyToWamid: source } : {}),
    text: args.text,
    ...(args.buttons === undefined || args.buttons.length === 0 ? {} : { buttons: args.buttons.map((button) => ({ action: button.action, ...(button.item === undefined ? {} : { item: button.item }) })) }),
    citations: [...(args.refs?.citations ?? [])],
    ...(Object.keys(refs).length === 0 ? {} : { refs }),
  };
}

function answerOf(result: OutboundResult): ToolFailure | { ok: true; messageId: string; status: "SENT" | "DEFERRED"; windowState: "OPEN"; policyResult: PolicyResult; guardrail: { action: "NONE" | "BLOCKED"; groundingScore?: number } } {
  if (result.status === "REFUSED") return result.failure;
  return {
    ok: true,
    messageId: result.messageId,
    status: result.status,
    windowState: "OPEN",
    policyResult: result.decision === undefined ? ALLOWED : toPolicyResult(result.decision),
    guardrail: result.guardrail ?? { action: "NONE" },
  };
}

export const sendWhatsapp = implementTool(sendWhatsappTool, async (args, ctx: ToolContext<MessagingRuntime>) => {
  const request = await requestOf(args, ctx);
  const result = await sendOutbound(ctx.deps.outbound(), request, {
    actor: ctx.actor,
    correlationId: ctx.correlationId,
    log: ctx.logger,
    refs: { ...(ctx.scope.turnId === undefined ? {} : { turnId: ctx.scope.turnId }), tool: ctx.tool },
  });
  return answerOf(result);
});

export const MESSAGING_IMPLEMENTATIONS = [sendWhatsapp] as const;
