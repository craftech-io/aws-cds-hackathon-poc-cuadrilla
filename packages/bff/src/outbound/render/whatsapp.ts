// Render of a WhatsApp send (step "render" of the pipeline): the Cloud API JSON the transports take,
// built with the builders of channels/whatsapp/render.ts so a label over its limit or a template with
// the wrong number of parameters fails here, never at Meta. Every button and list row gets a nonce
// bound to the recipient's phone, the object it acts on and the action (channels/whatsapp/nonces.ts,
// FL-094); its title comes from copy/ (never from the caller). Template parameters arrive already
// through G3. Media (the certificate PDF, a photo of a case) is rendered with the placeholder id the
// transport replaces (`PostWhatsAppMessageMedia` live, the object's key simulated).
//
// `shapeOf` renders with placeholder nonces before anything is issued or written, so a send the
// transports would refuse is `INVALID` up front; `displayTextOf` is the text the policy and the
// verification read (the rendered template body for a template).
import { ToolError, type WaButtonAction } from "@cuadrilla/shared";
import { buttonTitle } from "../../copy/buttons";
import { TEMPLATES, renderTemplateBody } from "../../copy/templates";
import type { JsonObject } from "../../domain/common";
import type { MessageContent } from "../../domain/conversations";
import type { NonceObject } from "../../domain/runtime";
import type { MetaMessage } from "../../channels/whatsapp/meta-messages";
import { type NonceDeps, issueNonce } from "../../channels/whatsapp/nonces";
import { type ListRowSpec, renderDocument, renderImage, renderList, renderReaction, renderReplyButtons, renderTemplate, renderText } from "../../channels/whatsapp/render";
import { type OutboundMedia, PENDING_MEDIA_ID } from "../../channels/whatsapp/transport";
import type { MessageForm } from "../../policy/types";
import { OUTBOUND_REASON, type OutboundButton, type WhatsAppSendRequest } from "../types";

/** Whom the nonces are bound to and what the default objects of the buttons are. */
export interface RenderTarget {
  readonly to: string;
  readonly personId: string;
  readonly phoneHash: string;
  readonly clockId: string;
  readonly messageId: string;
  /** Local simulated day of the send (`VIEW_ORDERS` acts on it). */
  readonly day: string;
}

export interface RenderedWhatsApp {
  readonly payload: MetaMessage;
  readonly content: MessageContent;
  readonly media?: OutboundMedia;
  /** The interactive part as stored on the message (buttons with their nonces), if any. */
  readonly interactive?: JsonObject;
}

export function formOf(request: WhatsAppSendRequest): MessageForm {
  if (request.template !== undefined) return "TEMPLATE";
  if (request.document !== undefined) return "DOCUMENT";
  if (request.image !== undefined) return "IMAGE";
  if (request.reaction !== undefined) return "REACTION";
  return request.buttons !== undefined || request.list !== undefined ? "INTERACTIVE" : "TEXT";
}

const CONTENT_OF: Readonly<Record<MessageForm, MessageContent>> = {
  TEXT: "TEXT",
  INTERACTIVE: "INTERACTIVE",
  TEMPLATE: "TEMPLATE",
  DOCUMENT: "DOCUMENT",
  IMAGE: "IMAGE",
  REACTION: "REACTION",
  READ_ACK: "READ_ACK",
  EMAIL: "OTHER",
};

/** What a person reads: the text, the rendered template body or the caption. */
export function displayTextOf(request: WhatsAppSendRequest): string | undefined {
  if (request.template !== undefined) return renderTemplateBody(request.template.name, request.template.params);
  return request.text ?? request.document?.caption ?? request.image?.caption;
}

/** The object a button acts on when the caller does not name one. */
export function defaultObjectOf(action: WaButtonAction, request: Pick<WhatsAppSendRequest, "workOrderId" | "caseId">, target: Pick<RenderTarget, "messageId" | "day">, item?: string): NonceObject {
  const need = (id: string | undefined, what: string): string => {
    if (id === undefined) throw new ToolError("INVALID", `the ${action} button needs ${what}`, OUTBOUND_REASON.CONTENT_INVALID);
    return id;
  };
  switch (action) {
    case "CHOOSE_ITEM":
      return { kind: "ITEM", id: need(item, "an item") };
    case "CONSULT_SUPERVISOR":
    case "CUSTOMER_OK":
    case "CLOSE_INSTALLATION":
    case "CHOOSE_ORDER":
      return { kind: "WORK_ORDER", id: need(request.workOrderId, "a work order") };
    case "TAKE_CASE":
    case "DECLINE_CASE":
    case "CLOSE_CASE":
    case "VIEW_REPLY":
    case "CHOOSE_CASE":
      return { kind: "CASE", id: need(request.caseId, "a case") };
    case "VIEW_ORDERS":
      return { kind: "DAY", id: target.day };
    case "NO_THANKS":
      return { kind: "MESSAGE", id: target.messageId };
  }
}

type NonceIssuer = (action: WaButtonAction, object: NonceObject) => Promise<string>;

function invalid(error: unknown): never {
  if (error instanceof ToolError) throw error;
  throw new ToolError("INVALID", "the message does not fit WhatsApp's limits", OUTBOUND_REASON.CONTENT_INVALID, { cause: error });
}

async function interactiveOf(request: WhatsAppSendRequest, target: RenderTarget, issue: NonceIssuer): Promise<{ payload: MetaMessage; interactive: JsonObject }> {
  const text = request.text ?? "";
  const options = request.replyToWamid === undefined ? {} : { replyTo: request.replyToWamid };
  if (request.list !== undefined) {
    const rows: ListRowSpec[] = [];
    for (const row of request.list.rows) {
      const id = row.id ?? (await issue(row.action ?? "CHOOSE_ORDER", row.object ?? { kind: "MESSAGE", id: target.messageId }));
      rows.push({ id, title: row.title, ...(row.description === undefined ? {} : { description: row.description }) });
    }
    return { payload: renderList(target.to, text, request.list.button, rows, options), interactive: { type: "list", button: request.list.button, rows: rows.map((row) => ({ ...row })) } };
  }
  const buttons = [];
  for (const button of request.buttons ?? ([] as OutboundButton[])) {
    const object = button.object ?? defaultObjectOf(button.action, request, target, button.item);
    buttons.push({ id: await issue(button.action, object), title: buttonTitle(button.action, button.item), action: button.action });
  }
  return { payload: renderReplyButtons(target.to, text, buttons, options), interactive: { type: "button", buttons: buttons.map((button) => ({ ...button })) } };
}

async function templateOf(request: WhatsAppSendRequest, target: RenderTarget, issue: NonceIssuer): Promise<{ payload: MetaMessage; media?: OutboundMedia }> {
  const template = request.template;
  if (template === undefined) throw new RangeError("not a template");
  const actions = TEMPLATES[template.name].buttons;
  const nonces: string[] = [];
  for (const [index, action] of actions.entries()) nonces.push(await issue(action, template.buttonObjects?.[index] ?? defaultObjectOf(action, request, target)));
  const document = template.document === undefined ? undefined : { id: PENDING_MEDIA_ID, filename: template.document.filename };
  return {
    payload: renderTemplate(target.to, { name: template.name, params: template.params, buttonNonces: nonces, ...(document === undefined ? {} : { document }) }),
    ...(template.document === undefined ? {} : { media: template.document.media }),
  };
}

async function build(request: WhatsAppSendRequest, target: RenderTarget, issue: NonceIssuer): Promise<RenderedWhatsApp> {
  const form = formOf(request);
  const content = CONTENT_OF[form];
  const options = request.replyToWamid === undefined ? {} : { replyTo: request.replyToWamid };
  switch (form) {
    case "TEMPLATE":
      return { content, ...(await templateOf(request, target, issue)) };
    case "DOCUMENT": {
      const document = request.document ?? invalid(new Error("no document"));
      return { content, payload: renderDocument(target.to, PENDING_MEDIA_ID, document.filename, document.caption, options), media: document.media };
    }
    case "IMAGE": {
      const image = request.image ?? invalid(new Error("no image"));
      return { content, payload: renderImage(target.to, PENDING_MEDIA_ID, image.caption, options), media: image.media };
    }
    case "REACTION": {
      const reaction = request.reaction ?? invalid(new Error("no reaction"));
      return { content, payload: renderReaction(target.to, reaction.wamid, reaction.emoji) };
    }
    case "INTERACTIVE":
      return { content, ...(await interactiveOf(request, target, issue)) };
    default:
      return { content, payload: renderText(target.to, request.text ?? "", options) };
  }
}

/** The send rendered with placeholder nonces: throws `INVALID` for anything the transports would refuse. */
export async function shapeOf(request: WhatsAppSendRequest, target: RenderTarget): Promise<RenderedWhatsApp> {
  try {
    return await build(request, target, async (action) => `shape-check-${action.toLowerCase()}`);
  } catch (error) {
    return invalid(error);
  }
}

/** The send rendered for real: one nonce per button, bound to the recipient's phone, the object and the action. */
export async function renderWhatsApp(request: WhatsAppSendRequest, target: RenderTarget, nonces: NonceDeps): Promise<RenderedWhatsApp> {
  const issue: NonceIssuer = (action, object) => issueNonce({ clockId: target.clockId, personId: target.personId, phoneHash: target.phoneHash, action, object, messageId: target.messageId }, nonces);
  try {
    return await build(request, target, issue);
  } catch (error) {
    return invalid(error);
  }
}
