// A send the policy deferred (quiet hours, docs/design-brief.md §5.7: "una denegación por horario no
// descarta el mensaje"): `TIMER#DEFERRED_SEND#<messageId>` at `nextAllowedAt` in the partition of its
// order, case or person (docs/architecture.md §8), with the request in its payload, and the `Message`
// `DEFERRED` in the person's thread. When the timer fires (the clock reaches it, a schedule, or "Avanzar
// al próximo evento"), `fireDeferredSend` runs the whole pipeline again at the firing instant under a
// derived id, so the policy decides with the records of that moment and the deferred row keeps its
// place in the timeline. A deferral measured on the real clock (a real phone of the live world) is
// placed on the world's clock at the same distance from now.
import { z } from "zod";
import { ToolError } from "@cuadrilla/shared";
import { timerRefKey } from "../connector/keys";
import type { Timer, TimerHome } from "../domain/timers";
import type { PolicyDecision } from "../policy/engine";
import { toMessagePolicy } from "../policy/result";
import type { SendContext } from "./context";
import type { OutboundDeps } from "./deps";
import { appendOutMessage, auditPolicyDecision } from "./persist";
import { MessageIdSchema, OUTBOUND_REASON, OutboundRequest, type OutboundCall, type OutboundDeferred, type OutboundInput } from "./types";

/** What a `TIMER#DEFERRED_SEND` carries: the request as it was asked and the id of its deferred message. */
export const DeferredPayload = z.strictObject({ version: z.literal(1), messageId: MessageIdSchema, request: z.record(z.string(), z.unknown()) });
export type DeferredPayload = z.infer<typeof DeferredPayload>;

/** Suffix of the message a deferred send becomes when its timer fires. */
export const FIRED_SUFFIX = ".fired";

function homeOf(request: OutboundRequest): TimerHome {
  if (request.workOrderId !== undefined) return { kind: "WORK_ORDER", id: request.workOrderId };
  if (request.caseId !== undefined) return { kind: "CASE", id: request.caseId };
  if (request.channel === "WHATSAPP") return { kind: "PERSON", id: request.personId };
  throw new ToolError("INVALID", "an email is always about a work order", OUTBOUND_REASON.CONTENT_INVALID);
}

/** `nextAllowedAt` on the world's clock: a real-clock deferral keeps its distance from real now. */
export function dueAtSimOf(decision: PolicyDecision): string {
  const next = decision.nextAllowedAt;
  if (next === undefined) throw new RangeError("a deferral needs nextAllowedAt");
  if (decision.nextAllowedClock !== "REAL") return new Date(Date.parse(next)).toISOString();
  const ahead = Math.max(0, Date.parse(next) - Date.parse(decision.at.real));
  return new Date(Date.parse(decision.at.sim) + ahead).toISOString();
}

export interface DeferInput {
  readonly asked: OutboundInput;
  readonly request: OutboundRequest;
  readonly context: SendContext;
  readonly decision: PolicyDecision;
  readonly messageId: string;
}

/** Arms the timer, writes the deferred message and audits the `DEFER`. */
export async function deferSend(deps: OutboundDeps, call: OutboundCall, input: DeferInput): Promise<OutboundDeferred> {
  const { request, context, decision, messageId } = input;
  const home = homeOf(request);
  const dueAtSim = dueAtSimOf(decision);
  const payload: DeferredPayload = { version: 1, messageId, request: JSON.parse(JSON.stringify(input.asked)) as Record<string, unknown> };
  const timer = await deps.timers.arm({ home, kind: "DEFERRED_SEND", timerId: messageId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80), clockId: context.clockId, dueAtSim, reason: decision.deniedBy ?? "DEFERRED", payload });
  const timerKey = timerRefKey({ home: timer.home, kind: timer.kind, timerId: timer.timerId });
  const decisionId = await auditPolicyDecision(deps, call, request, context, decision, { messageId, refs: { timerKey } });
  if (request.channel === "WHATSAPP" && context.channel === "WHATSAPP") {
    await appendOutMessage(deps, request, context, { messageId, status: "DEFERRED", content: request.template === undefined ? "TEXT" : "TEMPLATE", ...(request.text === undefined ? {} : { text: request.text }), policy: toMessagePolicy(decision, decisionId), extraRefs: { timerKey, nextAllowedAt: dueAtSim } });
  }
  call.log.info("outbound.deferred", { messageId, rule: decision.deniedBy, timerKey });
  return { status: "DEFERRED", messageId, nextAllowedAt: decision.nextAllowedAt ?? dueAtSim, timerKey, decision };
}

/** The request a fired `TIMER#DEFERRED_SEND` carries, re-dated to the firing instant under its derived id. */
export function firedRequest(timer: Pick<Timer, "kind" | "payload">, eventAtSim: string): OutboundInput {
  if (timer.kind !== "DEFERRED_SEND") throw new RangeError(`not a deferred send: ${timer.kind}`);
  const payload = DeferredPayload.parse(timer.payload);
  const asked = OutboundRequest.parse({ ...payload.request, eventAtSim, messageId: `${payload.messageId}${FIRED_SUFFIX}` });
  return asked as OutboundInput;
}
