// `send_whatsapp` (docs/tool-catalog.md, target `messaging`; ADR-0014): the only way the agent speaks.
// The recipient is the installer of the session (`LAM-RECIPIENT`, never an id the model wrote); the
// orders and the case the model names in `refs` must be in the session's scope (`LAM-SCOPE`); the
// message is the agent's own words, so everything after this goes through the outbound pipeline:
// `LAM-BRIDGE`, the contact policy, G2 with the installer's message as its query (or the fixed status
// question for a greeting, ADR-0028), the deterministic verification, the transport of the installer's
// route, `Conversations` and `AuditLog`. A repeat of the same text in the turn is answered from the
// first message (outbound/repeat.ts). The message keeps as citations only the sections its text names
// (`refs.citations` the installer never sees are no citation). After `report_safety_hazard` in the same
// turn nothing else goes out: the fixed instruction of §SEG-01 is the answer, and the model never adds
// safety advice of its own (ADR-0016, `ON_HOLD_SAFETY`). The tool never throws: every refusal is
// `{ ok: false, error }`.
import { z } from "zod";
import { type PolicyResult, type ToolFailure, ToolError } from "@cuadrilla/shared";
import { sectionsCitedIn } from "../../policy/rules-content";
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

/** A `report_safety_hazard` of the turn that went through: its fixed instruction is out. */
const SafetyReported = z.object({ ok: z.literal(true), caseId: z.string() }).loose();

/** Refuses a message after this turn reported a hazard: the safety instruction already answered (ADR-0016). */
async function refuseAfterSafetyReport(ctx: ToolContext<MessagingRuntime>): Promise<void> {
  if (ctx.scope.turnId === undefined) return;
  const reports = await ctx.deps.connector.runtime.listTurnResults(ctx.scope.turnId, "report_safety_hazard");
  if (reports.some((result) => SafetyReported.safeParse(result.output).success)) {
    throw new ToolError("ON_HOLD_SAFETY", "the fixed safety instruction of report_safety_hazard already answered this turn: send nothing else and end with the internal note", "SAFETY_REPORTED");
  }
}

/** The sections of `refs.citations` the text names: what the installer reads cited. */
function citationsOf(args: SendArgs) {
  const named = new Set(sectionsCitedIn(args.text));
  return (args.refs?.citations ?? []).filter((section) => named.has(section));
}

async function requestOf(args: SendArgs, ctx: ToolContext<MessagingRuntime>): Promise<WhatsAppSendInput> {
  const { scope, identity } = ctx;
  if (identity.kind !== "HARNESS" || scope.installerId === undefined || scope.eventAtSim === undefined) {
    throw new ToolError("FORBIDDEN", "send_whatsapp speaks only for a turn of the agent", "LAM-RECIPIENT");
  }
  await refuseAfterSafetyReport(ctx);
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
    citations: citationsOf(args),
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
