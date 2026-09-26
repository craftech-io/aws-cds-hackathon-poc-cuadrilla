// Read receipt with the typing indicator (FL-102, ADR-0020): as soon as an installer's message is
// queued for a turn, it is marked read and "escribiendo…" shows, so there is never half a minute of
// silence. Live: the Cloud API status payload (`status: read` + `typing_indicator`) through
// `SendWhatsAppMessage`; simulated: the simulator draws it from the message's `READ` status. It is not
// a message: it goes through no content policy, counts as no reply (`FirstReplyLatency` ignores it)
// and is never sent to an unknown number nor while the kill switch `KILL#ALL` is on. A failed receipt
// is logged and never fails the inbound message.
import type { ConversationsPort } from "../../connector/ports";
import type { Message } from "../../domain/conversations";
import { type Clock, systemClock } from "../../lib/clock";
import type { Logger } from "../../lib/log";
import type { KillStatus } from "../../ops/kill-switch";
import type { SocialMessagingPort } from "./client";
import { renderReadAck } from "./render";

export type AckOutcome = "ACKED" | "SKIPPED_UNKNOWN" | "SKIPPED_KILL" | "FAILED";

export interface AckDeps {
  readonly conversations: Pick<ConversationsPort, "updateMessage" | "appendMessageEvent">;
  /** Live only. */
  readonly social?: SocialMessagingPort;
  readonly logger: Logger;
  readonly realClock?: Clock;
}

export interface AckInput {
  /** The stored inbound message (`Message IN`); absent for an unknown number, which is never acknowledged. */
  readonly message: Message | undefined;
  readonly transport: "live" | "simulated";
  readonly kill: KillStatus;
}

export async function acknowledgeInbound(input: AckInput, deps: AckDeps): Promise<AckOutcome> {
  const message = input.message;
  if (message === undefined || message.direction !== "IN") return "SKIPPED_UNKNOWN";
  if (input.kill.all) return "SKIPPED_KILL";
  const wamid = message.providerMessageId ?? message.messageId;
  try {
    if (input.transport === "live") {
      if (deps.social === undefined) throw new Error("a live receipt needs the End User Messaging Social client");
      await deps.social.send(renderReadAck(wamid));
    }
    const atReal = (await (deps.realClock ?? systemClock).now()).toISOString();
    await deps.conversations.updateMessage({ personId: message.personId, sentAtSim: message.sentAtSim, messageId: message.messageId }, { status: "READ" });
    await deps.conversations.appendMessageEvent({ eventId: `ack-${message.messageId}`.slice(0, 200), personId: message.personId, clockId: message.clockId, messageId: message.messageId, status: "READ", atReal });
    return "ACKED";
  } catch (error) {
    deps.logger.warn("read receipt not sent", { messageId: message.messageId, error });
    return "FAILED";
  }
}
