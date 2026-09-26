// `Conversations` repository: each person's WhatsApp thread (messages, status events, turn notes),
// the operator's outbox of emails and the timeline of an order (`GSI2`, by simulated time). Messages
// are created once (`attribute_not_exists`); statuses and SES events update them in place.
import { ConnectorError } from "@cuadrilla/shared";
import { Message, MessageEvent, OutboundEmail, TurnNote } from "../../domain/conversations";
import { encodeRow } from "../codecs";
import { EVT_PREFIX, MAIL_PREFIX, MSG_PREFIX, NOTE_PREFIX, outboxPartition, personPartition, timelineKey } from "../keys";
import type { ConversationsPort, MailRef, MessageRef, TimelineEntry } from "../ports-runtime";
import { utcIso, type Item } from "../table-client";
import { createEntity, getEntity, listPrefix, parseRow, parseRows, patchEntity, patchRow, requireEntity, retryOnConflict, type RepoContext } from "./repo";

const TABLE = "Conversations";

function timelineEntry(item: Item): TimelineEntry {
  switch (item.entity) {
    case "Message":
      return parseRow(Message, item, TABLE);
    case "OutboundEmail":
      return parseRow(OutboundEmail, item, TABLE);
    case "TurnNote":
      return parseRow(TurnNote, item, TABLE);
    default:
      throw new ConnectorError("VALIDATION", `unexpected ${String(item.entity)} in a timeline`, TABLE);
  }
}

const messageRefFields = (ref: MessageRef) => ({ personId: ref.personId, sentAtSim: ref.sentAtSim, messageId: ref.messageId });
const mailRefFields = (ref: MailRef) => ({ ispId: ref.ispId, sentAtSim: ref.sentAtSim, mailId: ref.mailId });

export function conversationsRepo(ctx: RepoContext): ConversationsPort {
  const { client } = ctx;

  const byProviderId = async (providerMessageId: string, entity: "Message" | "OutboundEmail"): Promise<Item | undefined> => {
    const rows = await client.query(TABLE, { index: "GSI1", hashValue: providerMessageId, limit: 5 });
    return rows.find((row) => row.entity === entity);
  };

  return {
    appendMessage: (message) => createEntity(ctx, Message, "Message", message),
    getMessage: (ref) => getEntity(ctx, Message, "Message", messageRefFields(ref)),
    async findMessage(personId, messageId) {
      const messages = await listPrefix(ctx, TABLE, Message, personPartition(personId), MSG_PREFIX);
      return messages.find((message) => message.messageId === messageId);
    },
    async listMessages(personId, options = {}) {
      const from = options.fromSim === undefined ? MSG_PREFIX : `${MSG_PREFIX}${utcIso(options.fromSim)}`;
      const to = options.toSim === undefined ? `${MSG_PREFIX}￿` : `${MSG_PREFIX}${utcIso(options.toSim)}#￿`;
      const rows = await client.query(TABLE, {
        hashValue: personPartition(personId),
        range: { between: [from, to] },
        ...(options.limit === undefined ? {} : { limit: options.limit }),
        ...(options.descending ? { descending: true } : {}),
      });
      return parseRows(Message, rows, TABLE);
    },
    async findMessageByProviderId(providerMessageId) {
      const row = await byProviderId(providerMessageId, "Message");
      return row === undefined ? undefined : parseRow(Message, row, TABLE);
    },
    async updateMessage(ref, patch) {
      const { table, key } = encodeRow("Message", { ...messageRefFields(ref) });
      return patchRow(ctx, table, Message, key, { ...patch }, { ifExists: true });
    },

    appendMessageEvent: (event) => createEntity(ctx, MessageEvent, "MessageEvent", event),
    async listMessageEvents(personId, messageId) {
      const events = await listPrefix(ctx, TABLE, MessageEvent, personPartition(personId), EVT_PREFIX);
      return messageId === undefined ? events : events.filter((event) => event.messageId === messageId);
    },

    appendTurnNote: (note) => createEntity(ctx, TurnNote, "TurnNote", note),
    listTurnNotes: (personId, limit) => listPrefix(ctx, TABLE, TurnNote, personPartition(personId), NOTE_PREFIX, { descending: true, ...(limit === undefined ? {} : { limit }) }),

    async listTimeline(workOrderId) {
      return (await client.query(TABLE, { index: "GSI2", hashValue: timelineKey(workOrderId) })).map(timelineEntry);
    },

    appendMail: (mail) => createEntity(ctx, OutboundEmail, "OutboundEmail", mail),
    getMail: (ref) => getEntity(ctx, OutboundEmail, "OutboundEmail", mailRefFields(ref)),
    async findMail(ispId, mailId) {
      const mails = await listPrefix(ctx, TABLE, OutboundEmail, outboxPartition(ispId), MAIL_PREFIX);
      return mails.find((mail) => mail.mailId === mailId);
    },
    async findMailByProviderId(providerMessageId) {
      const row = await byProviderId(providerMessageId, "OutboundEmail");
      return row === undefined ? undefined : parseRow(OutboundEmail, row, TABLE);
    },
    listOutbox: (ispId, options = {}) => listPrefix(ctx, TABLE, OutboundEmail, outboxPartition(ispId), MAIL_PREFIX, { ...options }),
    updateMail: (ref, patch) =>
      retryOnConflict(3, async () => {
        const current = await requireEntity(ctx, OutboundEmail, "OutboundEmail", mailRefFields(ref), `mail ${ref.mailId}`);
        return patchEntity(ctx, OutboundEmail, "OutboundEmail", current, {
          status: patch.status,
          providerMessageId: patch.providerMessageId,
          ...(patch.event === undefined ? {} : { events: [...current.events, patch.event] }),
        });
      }),
  };
}
