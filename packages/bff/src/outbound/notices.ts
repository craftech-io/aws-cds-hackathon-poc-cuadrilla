// The fixed notices of the channel and the worker through the pipeline (channels/whatsapp/ports.ts:
// `NoticeSender`, `InstallerNoticeSender`): a `SYSTEM_NOTICE` with the text of copy/ that answers an
// inbound message, so the contact policy decides it and the audit log records it like any other send.
// A person of the allow list goes through `sendOutbound` (thread, nonces of a list, transport of the
// person's route). A number outside the list has no thread: the policy decides the reply with the
// counters the gate already reserved (`CP-ALLOWLIST`, FL-004), the decision is audited and the reply
// goes back through the transport the inbound came by, without a `Message` row (nobody to file it under).
import { ToolError, normalizePhone } from "@cuadrilla/shared";
import type { InstallerNotice, InstallerNoticeSender, NoticeRequest, NoticeSender, WorldTimeReader } from "../channels/whatsapp/ports";
import { renderList, renderText } from "../channels/whatsapp/render";
import type { WhatsAppChannelTransport } from "../channels/whatsapp/transport";
import type { WhatsAppRoute } from "../channels/registry";
import type { Logger } from "../lib/log";
import { evaluate } from "../policy/engine";
import { toDecisionInput } from "../policy/result";
import type { OutboundDeps } from "./deps";
import { sendOutbound } from "./pipeline";
import type { OutboundCall, OutboundResult } from "./types";

export interface NoticeDeps {
  readonly outbound: OutboundDeps;
  /** The world's simulated now (channels/whatsapp/ports.ts `connectorWorldTime`). */
  readonly worldTime: WorldTimeReader;
  /** A transport that records nothing, for the reply to a number outside the allow list. */
  readonly unthreaded?: (route: WhatsAppRoute) => WhatsAppChannelTransport;
  readonly logger: Logger;
}

async function simNowOf(deps: NoticeDeps, clockId: string): Promise<string> {
  const world = await deps.worldTime(clockId);
  if (world === undefined) throw new ToolError("NOT_FOUND", "the world of the notice does not exist");
  return world.simNow.toISOString();
}

function callOf(deps: NoticeDeps, actor: OutboundCall["actor"], correlationId: string): OutboundCall {
  return { actor, correlationId, log: deps.logger };
}

function failedOf(result: OutboundResult, logger: Logger, notice: string): void {
  if (result.status === "REFUSED") logger.warn("outbound.notice_not_sent", { notice, code: result.failure.error.code, reason: result.failure.error.reason });
}

async function noticeToUnknown(deps: NoticeDeps, request: NoticeRequest): Promise<void> {
  const settings = await deps.outbound.connector.isps.getSettings(request.ispId);
  if (settings === undefined) throw new ToolError("NOT_FOUND", "the world of the notice has no settings");
  const now = { sim: await simNowOf(deps, request.clockId), real: (await deps.outbound.realClock.now()).toISOString() };
  const live = request.recipient.transport === "live";
  const decision = evaluate({
    message: { kind: "SYSTEM_NOTICE", channel: "WHATSAPP", form: request.list === undefined ? "TEXT" : "INTERACTIVE", author: "SYSTEM", notice: request.notice, text: request.text, inResponseToInbound: true },
    // The gate reserved this reply's counters (`RATE#…unknown-<day>`, `UNKNOWN#GLOBAL#<realDay>`) before asking.
    recipient: { kind: "UNKNOWN_NUMBER", route: live ? "LIVE_WORLD" : "SIMULATED", repliesToday: 0, globalRepliesToday: 0 },
    facts: { now, world: { clockId: settings.clockId, timezone: settings.timezone, quietHours: settings.quietHours } },
  });
  const messageId = `ntc-${deps.outbound.newId()}`;
  await deps.outbound.connector.audit.append(toDecisionInput(decision, { ispId: request.ispId, clockId: request.clockId, action: "SEND_WHATSAPP", actor: "CHANNEL", messageId, refs: { notice: request.notice } }));
  if (!decision.allowed || deps.unthreaded === undefined) return;
  const to = normalizePhone(request.recipient.phone);
  const payload = request.list === undefined ? renderText(to, request.text, { replyTo: request.replyToWamid }) : renderList(to, request.text, request.list.button, request.list.rows, { replyTo: request.replyToWamid });
  const route: WhatsAppRoute = { transport: request.recipient.transport, source: live ? "LIVE_WORLD" : "UNREGISTERED_PHONE" };
  const sent = await deps.unthreaded(route).send({ message: { personId: "unthreaded", sentAtSim: now.sim, messageId }, clockId: request.clockId, ispId: request.ispId, payload });
  if (!sent.ok) deps.logger.warn("outbound.notice_not_sent", { notice: request.notice, code: sent.code, reason: sent.reason });
}

/** `NoticeSender` of `InboundWhatsApp`: fixed replies to the sender of an inbound message. */
export function createNoticeSender(deps: NoticeDeps): NoticeSender {
  return {
    async send(request) {
      const personId = request.recipient.personId;
      if (personId === undefined) return noticeToUnknown(deps, request);
      const result = await sendOutbound(
        deps.outbound,
        {
          channel: "WHATSAPP",
          kind: "SYSTEM_NOTICE",
          author: "SYSTEM",
          personId,
          eventAtSim: await simNowOf(deps, request.clockId),
          notice: request.notice,
          text: request.text,
          inResponseToInbound: true,
          replyToWamid: request.replyToWamid,
          ...(request.list === undefined ? {} : { list: { button: request.list.button, rows: request.list.rows.map((row) => ({ ...row })) } }),
          ...(request.refs === undefined ? {} : { refs: request.refs }),
        },
        callOf(deps, "CHANNEL", request.replyToWamid),
      );
      failedOf(result, deps.logger, request.notice);
    },
  };
}

/** `InstallerNoticeSender` of the worker: a fixed reply to the installer of a queued event (no phone in the queue). */
export function createInstallerNoticeSender(deps: NoticeDeps): InstallerNoticeSender {
  return {
    async send(notice: InstallerNotice) {
      const result = await sendOutbound(
        deps.outbound,
        {
          channel: "WHATSAPP",
          kind: "SYSTEM_NOTICE",
          author: "SYSTEM",
          personId: notice.personId,
          eventAtSim: await simNowOf(deps, notice.clockId),
          notice: notice.notice,
          text: notice.text,
          inResponseToInbound: true,
          replyToWamid: notice.replyToWamid,
          ...(notice.refs === undefined ? {} : { refs: notice.refs }),
        },
        callOf(deps, "WORKER", notice.replyToWamid),
      );
      failedOf(result, deps.logger, notice.notice);
    },
  };
}
