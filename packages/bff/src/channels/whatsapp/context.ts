// What every deterministic step of an inbound message shares once the sender is identified as staff
// of the allow list: the world and its simulated time, the person, the stored `Message IN` and the
// event id its effects are idempotent by. Built by inbound.ts; read by keywords.ts and routing.ts.
import type { Connector } from "../../connector/ports";
import type { Message } from "../../domain/conversations";
import type { Person } from "../../domain/people";
import type { Logger } from "../../lib/log";
import type { SenderIdentity } from "./identity";
import type { NonceDeps } from "./nonces";
import type { ChannelActionInput, ChannelActions, EventQueue, NoticeKey, NoticeRequest, NoticeSender } from "./ports";

export interface StaffMessage {
  readonly sender: SenderIdentity;
  readonly clockId: string;
  readonly ispId: string;
  readonly person: Person;
  /** `wamid` of the inbound message. */
  readonly wamid: string;
  /** The stored `Message IN` (masked). */
  readonly message: Message;
  readonly eventId: string;
  readonly simNow: Date;
  readonly timeZone: string;
}

export interface StaffDeps {
  readonly connector: Pick<Connector, "people" | "cases" | "conversations" | "worlds" | "audit" | "runtime" | "workOrders">;
  readonly actions: ChannelActions;
  readonly notices: NoticeSender;
  readonly queue: EventQueue;
  readonly nonces: NonceDeps;
  readonly logger: Logger;
}

/** The input of a deterministic handler for this message (`caller CHANNEL`). */
export function actionInput(staff: StaffMessage): ChannelActionInput {
  return { clockId: staff.clockId, ispId: staff.ispId, personId: staff.person.personId, atSim: staff.simNow.toISOString(), sourceMessageId: staff.wamid, eventId: staff.eventId };
}

/** A fixed notice to the sender of this message, answering it. */
export function noticeTo(staff: StaffMessage, notice: NoticeKey, text: string, extra: Pick<NoticeRequest, "refs" | "list"> = {}): NoticeRequest {
  return {
    clockId: staff.clockId,
    ispId: staff.ispId,
    recipient: { personId: staff.person.personId, phone: staff.sender.phone, phoneHash: staff.sender.phoneHash, transport: staff.sender.transport },
    notice,
    text,
    replyToWamid: staff.wamid,
    ...extra,
  };
}

/** Reference of the stored inbound message (what queued events point at). */
export function messageRefOf(message: Message) {
  return { personId: message.personId, sentAtSim: message.sentAtSim, messageId: message.messageId };
}
