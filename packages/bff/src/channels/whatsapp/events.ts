// Statuses of what we sent (docs/architecture-integrations.md §4.2 and §4.4.1; FL-072, FL-092): Meta's
// `statuses[]` (live) or the synthetic ones of the simulated transport go through the same code.
//
//   - `sent` → `delivered` → `read` only move forward; `failed` is final. Each status is a
//     `MessageEvent` with its pricing: per conversation (`CBP`) or per message (`PMP`, with or without
//     `conversation`, `billable` also for service messages), valued later with the rate card.
//   - A template billed in a category other than `utility` raises `WhatsAppTemplateCategory`; the
//     alarm looks only at templates (a free text in the window is `service` by design).
//   - A live `failed` with the re-engagement error (131047) on a free text falls back ONCE to the
//     equivalent `UTILITY` template (`RELAY` → `respuesta_supervisor`, `ORDERS_DETAIL` →
//     `ordenes_del_dia`); any other kind waits for the next inbound. Both are audited `WINDOW_FALLBACK`.
//
// It also keeps the real clock of the 24 h window of a real phone: every live message updates
// `lastInboundAtReal` on its lease (a judge's phone) or on the person (the live world).
import { createHash } from "node:crypto";
import { ConnectorError, type TemplateName } from "@cuadrilla/shared";
import type { AuditPort, ConversationsPort, PeoplePort, RuntimePort, WorldRuntimePort } from "../../connector/ports";
import type { Message, MessageStatus } from "../../domain/conversations";
import type { Logger } from "../../lib/log";
import { REENGAGEMENT_ERROR_CODE } from "./config";
import type { SenderIdentity } from "./identity";
import { type StatusUpdate, metaTimestampToIso } from "./payloads";
import type { MetricSink } from "./ports";

const STATUS_OF: Readonly<Record<StatusUpdate["status"], MessageStatus | undefined>> = {
  sent: "SENT",
  delivered: "DELIVERED",
  read: "READ",
  failed: "FAILED",
  deleted: undefined,
};

const EVENT_OF: Readonly<Record<StatusUpdate["status"], "SENT" | "DELIVERED" | "READ" | "FAILED" | "DELETED">> = {
  sent: "SENT",
  delivered: "DELIVERED",
  read: "READ",
  failed: "FAILED",
  deleted: "DELETED",
};

const RANK: Readonly<Partial<Record<MessageStatus, number>>> = { QUEUED: 0, SENT: 1, DELIVERED: 2, READ: 3 };

/** Whether a message may move from `current` to `next` (never backwards; nothing after FAILED). */
export function isForward(current: MessageStatus, next: MessageStatus): boolean {
  if (current === "FAILED") return false;
  if (next === "FAILED") return current !== "READ";
  return (RANK[next] ?? -1) > (RANK[current] ?? -1);
}

/** The template a free text falls back to when Meta closes the window on it; `undefined` = wait for the next inbound. */
export const WINDOW_FALLBACK_TEMPLATE: Readonly<Partial<Record<NonNullable<Message["kind"]>, TemplateName>>> = {
  RELAY: "respuesta_supervisor",
  ORDERS_DETAIL: "ordenes_del_dia",
};

export interface WindowFallbackPort {
  /** Sends the equivalent template for a failed free text (the outbound pipeline, with its policy). */
  sendTemplate(original: Message, template: TemplateName): Promise<void>;
  /** Keeps any other failed message pending until the person writes again (the bridge's pending list). */
  holdForNextInbound(original: Message): Promise<void>;
}

export interface StatusDeps {
  readonly conversations: Pick<ConversationsPort, "findMessageByProviderId" | "updateMessage" | "appendMessageEvent">;
  readonly runtime: Pick<RuntimePort, "claimIdempotency">;
  readonly audit: Pick<AuditPort, "append">;
  readonly metrics: MetricSink;
  readonly fallback: WindowFallbackPort;
  readonly logger: Logger;
}

export type StatusOutcome = "APPLIED" | "STALE" | "UNKNOWN_MESSAGE" | "DUPLICATE";

function isTemplate(message: Message): boolean {
  return message.content === "TEMPLATE" || message.templateName !== undefined;
}

function isReengagementFailure(status: StatusUpdate): boolean {
  return status.status === "failed" && (status.errors ?? []).some((error) => error.code === REENGAGEMENT_ERROR_CODE);
}

async function windowFallback(message: Message, deps: StatusDeps): Promise<void> {
  if (isTemplate(message)) return;
  if (!(await deps.runtime.claimIdempotency("wa-window-fallback", message.messageId))) return;
  const template = message.kind === undefined ? undefined : WINDOW_FALLBACK_TEMPLATE[message.kind];
  if (template === undefined) await deps.fallback.holdForNextInbound(message);
  else await deps.fallback.sendTemplate(message, template);
  deps.metrics.count("WhatsAppWindowFallback", { fallback: template ?? "HELD" });
  await deps.audit.append({
    ispId: message.ispId,
    clockId: message.clockId,
    decision: "ACTION",
    action: "WINDOW_FALLBACK",
    actor: "CHANNEL",
    ruleIds: ["CP-WA-24H"],
    messageId: message.messageId,
    refs: { ...(message.workOrderId === undefined ? {} : { workOrderId: message.workOrderId }), ...(message.caseId === undefined ? {} : { caseId: message.caseId }) },
    detail: { fallback: template ?? "HELD", errorCode: REENGAGEMENT_ERROR_CODE },
  });
}

async function applyStatus(status: StatusUpdate, deps: StatusDeps): Promise<StatusOutcome> {
  const message = await deps.conversations.findMessageByProviderId(status.id);
  if (message === undefined || message.direction !== "OUT") return "UNKNOWN_MESSAGE";
  const atReal = metaTimestampToIso(status.timestamp);
  const pricing = status.pricing;
  try {
    await deps.conversations.appendMessageEvent({
      eventId: `st-${createHash("sha256").update(`${status.id}\n${status.status}`, "utf8").digest("hex").slice(0, 40)}`,
      personId: message.personId,
      clockId: message.clockId,
      messageId: message.messageId,
      status: EVENT_OF[status.status],
      atReal,
      ...(status.errors?.[0] === undefined ? {} : { errorCode: String(status.errors[0].code), ...(status.errors[0].title === undefined ? {} : { errorTitle: status.errors[0].title }) }),
      ...(pricing === undefined ? {} : { pricing: { model: pricing.pricing_model, category: pricing.category, ...(pricing.billable === undefined ? {} : { billable: pricing.billable }) } }),
    });
  } catch (error) {
    if (error instanceof ConnectorError && error.code === "CONFLICT") return "DUPLICATE";
    throw error;
  }
  if (pricing !== undefined && isTemplate(message) && pricing.category.toLowerCase() !== "utility") {
    deps.metrics.count("WhatsAppTemplateCategory", { category: pricing.category.toLowerCase() });
    deps.logger.warn("template billed outside the utility category", { template: message.templateName ?? "unknown", category: pricing.category });
  }
  const next = STATUS_OF[status.status];
  const moved = next !== undefined && isForward(message.status, next);
  if (moved) await deps.conversations.updateMessage({ personId: message.personId, sentAtSim: message.sentAtSim, messageId: message.messageId }, { status: next });
  if (isReengagementFailure(status)) await windowFallback(message, deps);
  return moved ? "APPLIED" : "STALE";
}

/** Applies each status in order; a status of a message that is not ours or not outbound is ignored. */
export async function applyStatuses(statuses: readonly StatusUpdate[], deps: StatusDeps): Promise<StatusOutcome[]> {
  const outcomes: StatusOutcome[] = [];
  for (const status of statuses) outcomes.push(await applyStatus(status, deps));
  return outcomes;
}

export interface LiveInboundDeps {
  readonly worlds: Pick<WorldRuntimePort, "touchPhoneLease">;
  readonly people: Pick<PeoplePort, "recordInbound">;
}

/**
 * `lastInboundAtReal` of a real phone, from Meta's `timestamp` (ADR-0002): on the lease of a phone
 * bound to a judge's world, or on the person of the live world. The clock of `CP-WA-24H` for it.
 */
export async function recordLiveInbound(sender: SenderIdentity, metaTimestamp: string, deps: LiveInboundDeps): Promise<void> {
  if (sender.transport !== "live") return;
  const atReal = metaTimestampToIso(metaTimestamp);
  if (sender.lease !== undefined) {
    await deps.worlds.touchPhoneLease(sender.phoneHash, atReal);
    return;
  }
  if (sender.person !== undefined && sender.person.clockId === sender.clockId) await deps.people.recordInbound(sender.person.personId, { atReal });
}
