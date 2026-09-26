// Outbound WhatsApp Cloud API JSON (the `message` bytes of `SendWhatsAppMessage`), as strict zod
// schemas. Both transports validate every payload with these same schemas before anything leaves:
// the live one before calling End User Messaging Social, the simulated one before persisting it
// (docs/architecture-integrations.md §4.3). Limits come from copy/buttons.ts (`WHATSAPP_LIMITS`).
import { z } from "zod";
import { TemplateName } from "@cuadrilla/shared";
import { WHATSAPP_LIMITS } from "../../copy/buttons";

/** Recipient as the Cloud API takes it: E.164 digits without `+`. */
export const WaRecipient = z.string().regex(/^\d{8,15}$/, "expected E.164 digits without +");

/** Code points, as WhatsApp counts characters. */
const upTo = (limit: number) =>
  z
    .string()
    .min(1)
    .refine((value) => [...value].length <= limit && value.trim() !== "", `at most ${limit} characters, not blank`);

const Base = {
  messaging_product: z.literal("whatsapp"),
  recipient_type: z.literal("individual"),
  to: WaRecipient,
  /** Reply to a message (the inbound `wamid`). */
  context: z.object({ message_id: z.string().min(1).max(200) }).strict().optional(),
};

const Id = z.string().min(1).max(256);

export const MetaText = z
  .object({ ...Base, type: z.literal("text"), text: z.object({ preview_url: z.literal(false), body: upTo(WHATSAPP_LIMITS.textBody) }).strict() })
  .strict();

const ReplyButton = z.object({ type: z.literal("reply"), reply: z.object({ id: Id, title: upTo(WHATSAPP_LIMITS.replyButton) }).strict() }).strict();
const ListRow = z.object({ id: Id, title: upTo(WHATSAPP_LIMITS.listRowTitle), description: upTo(WHATSAPP_LIMITS.listRowDescription).optional() }).strict();
const ListSection = z.object({ title: upTo(WHATSAPP_LIMITS.listRowTitle).optional(), rows: z.array(ListRow).min(1) }).strict();
const InteractiveBody = z.object({ text: upTo(WHATSAPP_LIMITS.interactiveBody) }).strict();

export const MetaInteractive = z
  .object({
    ...Base,
    type: z.literal("interactive"),
    interactive: z.union([
      z
        .object({
          type: z.literal("button"),
          body: InteractiveBody,
          action: z.object({ buttons: z.array(ReplyButton).min(1).max(WHATSAPP_LIMITS.replyButtonsMax) }).strict(),
        })
        .strict(),
      z
        .object({
          type: z.literal("list"),
          body: InteractiveBody,
          action: z
            .object({ button: upTo(WHATSAPP_LIMITS.listButton), sections: z.array(ListSection).min(1).max(10) })
            .strict()
            .refine((action) => action.sections.reduce((rows, section) => rows + section.rows.length, 0) <= WHATSAPP_LIMITS.listRowsMax, `at most ${WHATSAPP_LIMITS.listRowsMax} rows`),
        })
        .strict(),
    ]),
  })
  .strict();

export const MetaImage = z.object({ ...Base, type: z.literal("image"), image: z.object({ id: Id, caption: upTo(1024).optional() }).strict() }).strict();

const FileName = z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/, "expected a plain file name");

export const MetaDocument = z
  .object({ ...Base, type: z.literal("document"), document: z.object({ id: Id, filename: FileName, caption: upTo(1024).optional() }).strict() })
  .strict();

export const MetaReaction = z
  .object({ ...Base, type: z.literal("reaction"), reaction: z.object({ message_id: z.string().min(1).max(200), emoji: z.string().min(1).max(16) }).strict() })
  .strict();

const TemplateText = z.object({ type: z.literal("text"), text: z.string().min(1).max(1024) }).strict();
const TemplateComponent = z.union([
  z
    .object({
      type: z.literal("header"),
      parameters: z.tuple([z.object({ type: z.literal("document"), document: z.object({ id: Id, filename: FileName }).strict() }).strict()]),
    })
    .strict(),
  z.object({ type: z.literal("body"), parameters: z.array(TemplateText).min(1).max(10) }).strict(),
  z
    .object({
      type: z.literal("button"),
      sub_type: z.literal("quick_reply"),
      index: z.string().regex(/^[0-2]$/),
      parameters: z.tuple([z.object({ type: z.literal("payload"), payload: Id }).strict()]),
    })
    .strict(),
]);

export const MetaTemplate = z
  .object({
    ...Base,
    type: z.literal("template"),
    template: z.object({ name: TemplateName, language: z.object({ code: z.literal("es_MX") }).strict(), components: z.array(TemplateComponent).max(5) }).strict(),
  })
  .strict();

export const MetaMessage = z.discriminatedUnion("type", [MetaText, MetaInteractive, MetaImage, MetaDocument, MetaReaction, MetaTemplate]);
export type MetaMessage = z.infer<typeof MetaMessage>;
export type MetaMessageType = MetaMessage["type"];

/** Read receipt with the typing indicator (FL-102): a status payload, not a message. */
export const MetaReadStatus = z
  .object({
    messaging_product: z.literal("whatsapp"),
    status: z.literal("read"),
    message_id: z.string().min(1).max(200),
    typing_indicator: z.object({ type: z.literal("text") }).strict(),
  })
  .strict();
export type MetaReadStatus = z.infer<typeof MetaReadStatus>;

/** Bytes of a payload for `SendWhatsAppMessage.message`. */
export function encodePayload(payload: MetaMessage | MetaReadStatus): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload));
}
