// The simulated transport (docs/architecture-integrations.md §4.3, FL-082): what every synthetic
// identity receives, in every world, also after the stage gets the live transport. It validates the
// same Cloud API JSON with the same schemas as the live one, records it on the message (`simulated`,
// the phone simulator draws it), and emits synthetic `statuses[]` through the same code as Meta's:
// `sent` at once, `delivered` one second later, `read` when the simulator opens the thread. Templates
// leave only when the world's simulated state says `APPROVED` (`IspSettings.templateStatus`, so plan B
// is testable); `PostWhatsAppMessageMedia` is replaced by a reference to the object's key.
import type { TemplateName, TemplateStatus } from "@cuadrilla/shared";
import type { ConversationsPort, IspsPort } from "../../connector/ports";
import type { Message } from "../../domain/conversations";
import { type Clock, systemClock } from "../../lib/clock";
import { ulid } from "../../lib/crypto";
import { SIMULATED_DELIVERY_DELAY_MS } from "./config";
import { MetaMessage } from "./meta-messages";
import type { StatusUpdate } from "./payloads";
import { sendFailure } from "../adapter";
import { mediaIdOf, withMediaId } from "./render";
import { simulatorWamid } from "./sim-envelope";
import { type MediaBucket, type SendRequest, type WhatsAppChannelTransport, type WhatsAppSendResult, PENDING_MEDIA_ID, recordSent } from "./transport";

/** Media id of a simulated attachment: the object's key, which the simulator serves by a presigned GET. */
export function simulatedMediaReference(bucket: MediaBucket, key: string): string {
  return `sim-s3:${bucket}:${key}`;
}

export interface SimulatedTransportDeps {
  readonly conversations: Pick<ConversationsPort, "getMessage" | "updateMessage" | "listMessages">;
  readonly isps: Pick<IspsPort, "getSettings">;
  /** The status handler of events.ts (`applyStatuses`), bound to its dependencies. */
  readonly applyStatuses: (statuses: readonly StatusUpdate[]) => Promise<unknown>;
  readonly realClock?: Clock;
  /** Id generator of provider ids; ULIDs by default. */
  readonly newId?: (nowMs: number) => string;
}

export interface SimulatedTransport extends WhatsAppChannelTransport {
  /** The simulator opened the thread of `personId`: everything delivered to it is read (`read` statuses). */
  markThreadRead(personId: string): Promise<number>;
}

const epochSeconds = (ms: number): string => String(Math.floor(ms / 1000));

/**
 * Synthetic pricing: a template is `utility`, a message inside the window `service`; both billable,
 * because Meta prices both since 2026-10-01 and the demo values simulated traffic as if it were live.
 */
function syntheticPricing(payload: MetaMessage): NonNullable<StatusUpdate["pricing"]> {
  return { pricing_model: "PMP", category: payload.type === "template" ? "utility" : "service", billable: true };
}

/** The world's simulated state of a template; a template the world does not mention is approved. */
async function templateState(isps: SimulatedTransportDeps["isps"], ispId: string, name: TemplateName): Promise<TemplateStatus> {
  return (await isps.getSettings(ispId))?.templateStatus[name] ?? "APPROVED";
}

export function createSimulatedTransport(deps: SimulatedTransportDeps): SimulatedTransport {
  const realClock = deps.realClock ?? systemClock;
  const newId = deps.newId ?? ((nowMs: number) => ulid(nowMs));

  return {
    channel: "WHATSAPP",
    transport: "simulated",
    async send(request: SendRequest): Promise<WhatsAppSendResult> {
      const parsed = MetaMessage.safeParse(request.payload);
      if (!parsed.success) return sendFailure("INVALID", "PAYLOAD_INVALID");
      let payload = parsed.data;
      if (payload.type === "template" && (await templateState(deps.isps, request.ispId, payload.template.name)) !== "APPROVED") {
        return sendFailure("POLICY_DENIED", "TEMPLATE_NOT_APPROVED");
      }
      if (request.media !== undefined) {
        if (mediaIdOf(payload) !== PENDING_MEDIA_ID) return sendFailure("INVALID", "MEDIA_PLACEHOLDER");
        payload = withMediaId(payload, simulatedMediaReference(request.media.bucket, request.media.key));
      }
      const nowMs = (await realClock.now()).getTime();
      const providerMessageId = simulatorWamid(newId(nowMs));
      await recordSent(deps.conversations, request.message, { providerMessageId, payload, atReal: new Date(nowMs).toISOString() });
      const pricing = syntheticPricing(payload);
      await deps.applyStatuses([
        { id: providerMessageId, status: "sent", timestamp: epochSeconds(nowMs), pricing },
        { id: providerMessageId, status: "delivered", timestamp: epochSeconds(nowMs + SIMULATED_DELIVERY_DELAY_MS), pricing },
      ]);
      return { ok: true, providerMessageId, payload };
    },

    async markThreadRead(personId) {
      const messages = await deps.conversations.listMessages(personId);
      const unread = messages.filter((message: Message) => message.direction === "OUT" && message.simulated && message.providerMessageId !== undefined && (message.status === "SENT" || message.status === "DELIVERED"));
      if (unread.length === 0) return 0;
      const timestamp = epochSeconds((await realClock.now()).getTime());
      await deps.applyStatuses(unread.map((message) => ({ id: message.providerMessageId ?? "", status: "read" as const, timestamp })));
      return unread.length;
    },
  };
}
