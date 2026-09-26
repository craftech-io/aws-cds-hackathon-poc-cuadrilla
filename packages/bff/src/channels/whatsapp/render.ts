// Builders of the Cloud API JSON each outbound message takes (docs/architecture-integrations.md §4.1):
// text, reply buttons, list, image, document, reaction, template (with the document header of
// `acta_instalacion`) and the read receipt with the typing indicator. Every builder returns a payload
// already validated by meta-messages.ts, so a label over its limit or a template with the wrong
// number of parameters fails here, never at Meta. Button ids are nonces (nonces.ts): the payload of a
// tap is the only thing that comes back, and it means nothing without `Runtime/NONCE#`.
import { type TemplateName, normalizePhone } from "@cuadrilla/shared";
import { TEMPLATES, renderTemplateBody, templateButtonTitles } from "../../copy/templates";
import { type MetaMessage, MetaMessage as MetaMessageSchema, type MetaReadStatus, MetaReadStatus as MetaReadStatusSchema } from "./meta-messages";

/** `+525501010001` → `525501010001`: the Cloud API recipient. */
export function waRecipient(phoneE164: string): string {
  return normalizePhone(phoneE164).slice(1);
}

export interface RenderOptions {
  /** `wamid` of the inbound message this one answers. */
  readonly replyTo?: string;
}

function base(to: string, options: RenderOptions) {
  return {
    messaging_product: "whatsapp" as const,
    recipient_type: "individual" as const,
    to: waRecipient(to),
    ...(options.replyTo === undefined ? {} : { context: { message_id: options.replyTo } }),
  };
}

function valid(payload: unknown): MetaMessage {
  return MetaMessageSchema.parse(payload);
}

export function renderText(to: string, body: string, options: RenderOptions = {}): MetaMessage {
  return valid({ ...base(to, options), type: "text", text: { preview_url: false, body } });
}

export interface ReplyButtonSpec {
  /** Nonce of the button. */
  readonly id: string;
  readonly title: string;
}

export function renderReplyButtons(to: string, body: string, buttons: readonly ReplyButtonSpec[], options: RenderOptions = {}): MetaMessage {
  return valid({
    ...base(to, options),
    type: "interactive",
    interactive: { type: "button", body: { text: body }, action: { buttons: buttons.map(({ id, title }) => ({ type: "reply", reply: { id, title } })) } },
  });
}

export interface ListRowSpec {
  /** Nonce of the row. */
  readonly id: string;
  readonly title: string;
  readonly description?: string;
}

export function renderList(to: string, body: string, button: string, rows: readonly ListRowSpec[], options: RenderOptions = {}): MetaMessage {
  const listRows = rows.map(({ id, title, description }) => ({ id, title, ...(description === undefined ? {} : { description }) }));
  return valid({ ...base(to, options), type: "interactive", interactive: { type: "list", body: { text: body }, action: { button, sections: [{ rows: listRows }] } } });
}

/** `mediaId` is the id `PostWhatsAppMessageMedia` returned (live) or the simulated key reference. */
export function renderImage(to: string, mediaId: string, caption?: string, options: RenderOptions = {}): MetaMessage {
  return valid({ ...base(to, options), type: "image", image: { id: mediaId, ...(caption === undefined ? {} : { caption }) } });
}

export function renderDocument(to: string, mediaId: string, filename: string, caption?: string, options: RenderOptions = {}): MetaMessage {
  return valid({ ...base(to, options), type: "document", document: { id: mediaId, filename, ...(caption === undefined ? {} : { caption }) } });
}

/** A reaction on a message of the person (`VERDICT_REACTION`, FL-103). */
export function renderReaction(to: string, messageId: string, emoji: string): MetaMessage {
  return valid({ ...base(to, {}), type: "reaction", reaction: { message_id: messageId, emoji } });
}

export interface TemplateSpec {
  readonly name: TemplateName;
  /** One value per `{{n}}`, built by code and already through G3. */
  readonly params: readonly string[];
  /** One nonce per quick-reply button of the template, in order. */
  readonly buttonNonces?: readonly string[];
  /** Document header (`acta_instalacion`): the media id and the file name. */
  readonly document?: { readonly id: string; readonly filename: string };
}

export function renderTemplate(to: string, spec: TemplateSpec): MetaMessage {
  const definition = TEMPLATES[spec.name];
  // Checks the number of parameters and each value (no line breaks, not blank, ≤ 200 characters).
  renderTemplateBody(spec.name, spec.params);
  const nonces = spec.buttonNonces ?? [];
  if (nonces.length !== definition.buttons.length) throw new RangeError(`${spec.name} takes ${definition.buttons.length} button nonce(s), got ${nonces.length}`);
  if ((definition.header !== undefined) !== (spec.document !== undefined)) throw new RangeError(`${spec.name} ${definition.header ? "needs" : "takes no"} document header`);
  const components: unknown[] = [];
  if (spec.document !== undefined) components.push({ type: "header", parameters: [{ type: "document", document: { id: spec.document.id, filename: spec.document.filename } }] });
  components.push({ type: "body", parameters: spec.params.map((text) => ({ type: "text", text })) });
  nonces.forEach((payload, index) => components.push({ type: "button", sub_type: "quick_reply", index: String(index), parameters: [{ type: "payload", payload }] }));
  return valid({ ...base(to, {}), type: "template", template: { name: spec.name, language: { code: definition.language }, components } });
}

/** Read receipt with "escribiendo…" for an inbound `wamid` (FL-102). */
export function renderReadAck(messageId: string): MetaReadStatus {
  return MetaReadStatusSchema.parse({ messaging_product: "whatsapp", status: "read", message_id: messageId, typing_indicator: { type: "text" } });
}

/** The media a payload points at (image, document or the template's document header), if any. */
export function mediaIdOf(message: MetaMessage): string | undefined {
  if (message.type === "image") return message.image.id;
  if (message.type === "document") return message.document.id;
  if (message.type !== "template") return undefined;
  for (const component of message.template.components) {
    if (component.type === "header") return component.parameters[0].document.id;
  }
  return undefined;
}

/** The same payload pointing at another media id (after `PostWhatsAppMessageMedia`). */
export function withMediaId(message: MetaMessage, mediaId: string): MetaMessage {
  if (message.type === "image") return valid({ ...message, image: { ...message.image, id: mediaId } });
  if (message.type === "document") return valid({ ...message, document: { ...message.document, id: mediaId } });
  if (message.type !== "template") return message;
  const components = message.template.components.map((component) =>
    component.type === "header" ? { ...component, parameters: [{ ...component.parameters[0], document: { ...component.parameters[0].document, id: mediaId } }] } : component,
  );
  return valid({ ...message, template: { ...message.template, components } });
}

/** What the person reads, as the phone simulator draws it: the body text and the button titles. */
export function displayOf(message: MetaMessage): { readonly text?: string; readonly buttons?: readonly string[] } {
  switch (message.type) {
    case "text":
      return { text: message.text.body };
    case "interactive":
      return message.interactive.type === "button"
        ? { text: message.interactive.body.text, buttons: message.interactive.action.buttons.map((button) => button.reply.title) }
        : { text: message.interactive.body.text, buttons: [message.interactive.action.button] };
    case "template": {
      const body = message.template.components.find((component) => component.type === "body");
      const params = body?.type === "body" ? body.parameters.map((parameter) => parameter.text) : [];
      return { text: renderTemplateBody(message.template.name, params), buttons: templateButtonTitles(message.template.name) };
    }
    case "image":
      return message.image.caption === undefined ? {} : { text: message.image.caption };
    case "document":
      return { text: message.document.caption ?? message.document.filename };
    case "reaction":
      return { text: message.reaction.emoji };
  }
}
