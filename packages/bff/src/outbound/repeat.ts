// The same send asked twice in one turn (ADR-0028, FL-093 (b)): the Harness runs the tools of an
// answer one after the other, and a model that repeats `send_whatsapp` with the same text (or the
// same template with the same parameters) would write the installer twice. The second request is
// answered from the first message, as a redelivered event is (`replayOf`), and nothing goes out
// again. Same turn, same channel, same recipient and the same content key; another text, another
// turn or another template goes out normally. A deferred send that fires keeps its turn and is never
// answered from its own `DEFERRED` message.
import { sha256Hex } from "../lib/crypto";
import type { Message } from "../domain/conversations";
import { FIRED_SUFFIX } from "./defer";
import type { WhatsAppSendRequest } from "./types";

/** `refs` field of an outbound message that keeps its content key. */
export const CONTENT_KEY_REF = "contentKey";

/** What makes two sends the same: the text, or the template with its parameters (as asked, before G3). */
export function contentKeyOf(request: Pick<WhatsAppSendRequest, "text" | "template" | "document" | "image" | "reaction" | "kind">): string {
  const content =
    request.template !== undefined
      ? ["TEMPLATE", request.template.name, ...request.template.params]
      : request.text !== undefined
        ? ["TEXT", request.text.trim()]
        : ["OTHER", request.kind, request.document?.media.key ?? request.image?.media.key ?? request.reaction?.wamid ?? "", request.reaction?.emoji ?? ""];
  return sha256Hex(JSON.stringify(content)).slice(0, 32);
}

/** Statuses of a message that went out, or will (a send that was refused can be asked again). */
const REPLAYABLE = new Set<Message["status"]>(["QUEUED", "SENT", "DELIVERED", "READ", "DEFERRED"]);

/** The message of this turn that already carries this content to this person, if any. */
export function repeatedInTurn(request: WhatsAppSendRequest, history: readonly Message[]): Message | undefined {
  if (request.turnId === undefined) return undefined;
  const key = contentKeyOf(request);
  return history.find(
    (message) =>
      message.direction === "OUT" &&
      message.channel === "WHATSAPP" &&
      message.personId === request.personId &&
      message.turnId === request.turnId &&
      `${message.messageId}${FIRED_SUFFIX}` !== request.messageId &&
      REPLAYABLE.has(message.status) &&
      message.refs?.[CONTENT_KEY_REF] === key,
  );
}
