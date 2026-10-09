// A safety message a lost invocation left behind (ADR-0016, docs/design-brief.md §5.9): the delivery
// writes the message `QUEUED` before its transport answers (deliver.ts), so an invocation that dies in
// between (a timeout or an out-of-memory while the transport retries) leaves a message nobody knows
// left. A redelivered event finds it and, as every other request, would replay it as sent.
//
// For the kinds where a missing message is worse than a repeated one (the §SEG-01 instruction to the
// installer and `alerta_seguridad` to the supervisor) an unconfirmed message (`QUEUED` or `FAILED`,
// without a provider id) is sent again under the next deterministic id (`<id>.r1`, `<id>.r2`…), at most
// `MAX_SAFETY_RESENDS` times. A message the transport confirmed (`SENT`, `DELIVERED`, `READ` or a
// provider id) or the policy decided (`DENIED`, `DEFERRED`) is replayed, never sent again, and every
// other kind keeps the replay of pipeline.ts.
import type { MessageKind } from "@cuadrilla/shared";
import type { Message } from "../domain/conversations";
import type { Connector } from "../connector/ports";
import type { Logger } from "../lib/log";
import type { WhatsAppSendRequest } from "./types";

export const RESENT_WHEN_UNCONFIRMED: ReadonlySet<MessageKind> = new Set<MessageKind>(["SAFETY_INSTRUCTION", "SAFETY_ALERT"]);

/** Resends of one safety message after the first, each under its own id. */
export const MAX_SAFETY_RESENDS = 3;

/** Nobody knows whether it left: written before the transport answered, or refused by it, with no provider id. */
export function unconfirmed(message: Message): boolean {
  return message.providerMessageId === undefined && (message.status === "QUEUED" || message.status === "FAILED");
}

/** The id of the `attempt`-th resend of a message. */
export function resendId(messageId: string, attempt: number): string {
  return `${messageId}.r${attempt}`;
}

export type Existing = { readonly replay: Message } | { readonly request: WhatsAppSendRequest };

/** The message a request with a fixed id must be answered from, or the request to send (under a resend id when its safety message is unconfirmed). */
export async function existingOrResend(connector: Pick<Connector, "conversations">, request: WhatsAppSendRequest, log: Logger): Promise<Existing> {
  const first = request.messageId;
  if (first === undefined) return { request };
  for (let attempt = 0; ; attempt += 1) {
    const messageId = attempt === 0 ? first : resendId(first, attempt);
    const existing = await connector.conversations.findMessage(request.personId, messageId);
    if (existing === undefined) return { request: attempt === 0 ? request : { ...request, messageId } };
    if (!RESENT_WHEN_UNCONFIRMED.has(request.kind) || !unconfirmed(existing) || attempt >= MAX_SAFETY_RESENDS) return { replay: existing };
    log.warn("outbound.unconfirmed_resend", { messageId, kind: request.kind, status: existing.status, attempt: attempt + 1 });
  }
}
