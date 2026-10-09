// What the phone simulator draws (docs/design-brief.md §6, FL-082): a thread as WhatsApp shows it, the
// buttons a person can tap, the catalog of the synthetic set, the tour's quick messages and the guest's
// kit. Pure mapping over the stored rows plus presigned links; routers/simulator.ts owns the procedures.
//
// Nothing of S3 reaches the browser but presigned links: a simulated attachment's reference
// (`sim-s3:<bucket>:<key>`) is replaced by `attachment` and the link travels apart. Button ids are the
// nonces the channel checks again when the tap comes back (bound to phone, object and action).
import { z } from "zod";
import { type PhotoItem, ToolError } from "@cuadrilla/shared";
import voiceSheet from "../../../../scripts/seed/audio/datasheet.json" with { type: "json" };
import { MetaMessage } from "../channels/whatsapp/meta-messages";
import { displayOf, mediaIdOf } from "../channels/whatsapp/render";
import type { Message } from "../domain/conversations";
import type { Person } from "../domain/people";
import { MAIN_STORY } from "../story/main-story";
import type { StoryEntry } from "../story/types";
import type { ConsolePorts } from "./console-ports";

/** The identity of a number the world does not know (FL-004). */
export const UNKNOWN_IDENTITY = "UNKNOWN";

/** How a tap comes back: a reply button or list row (interactive) or a template's quick reply. */
export type TapKind = "button_reply" | "list_reply" | "button";

export interface ThreadButton {
  readonly id: string;
  readonly title: string;
  readonly kind: TapKind;
}

const SIM_REFERENCE = /^sim-s3:(Evidence|Media):(.+)$/;
const QuickReplyComponent = z.object({ type: z.literal("button"), sub_type: z.literal("quick_reply"), index: z.coerce.number().optional(), parameters: z.array(z.object({ payload: z.string() }).loose()) }).loose();

/** The stored Cloud API JSON of an outbound message (`refs.whatsapp`), if it parses. */
export function payloadOf(message: Message): MetaMessage | undefined {
  const stored = message.refs?.whatsapp;
  if (typeof stored !== "object" || stored === null) return undefined;
  // The stored payload never carries the recipient (transport.ts `storedPayload`): any valid one parses it.
  const parsed = MetaMessage.safeParse({ ...stored, to: "10000000" });
  return parsed.success ? parsed.data : undefined;
}

/** The buttons of an outbound message, with the id the channel expects back. */
export function buttonsOf(payload: MetaMessage | undefined): ThreadButton[] {
  if (payload === undefined) return [];
  if (payload.type === "interactive") {
    if (payload.interactive.type === "button") return payload.interactive.action.buttons.map((button) => ({ id: button.reply.id, title: button.reply.title, kind: "button_reply" as const }));
    return payload.interactive.action.sections.flatMap((section) => section.rows.map((row) => ({ id: row.id, title: row.title, kind: "list_reply" as const })));
  }
  if (payload.type !== "template") return [];
  const titles = displayOf(payload).buttons ?? [];
  return payload.template.components.flatMap((component, position) => {
    const reply = QuickReplyComponent.safeParse(component);
    if (!reply.success) return [];
    const payloadId = reply.data.parameters[0]?.payload;
    const title = titles[reply.data.index ?? position] ?? titles[0] ?? "";
    return payloadId === undefined ? [] : [{ id: payloadId, title, kind: "button" as const }];
  });
}

/** A simulated attachment's object, if the payload carries one. */
function attachmentOf(payload: MetaMessage | undefined): { readonly bucket: "Evidence" | "Media"; readonly key: string; readonly fileName?: string } | undefined {
  const id = payload === undefined ? undefined : mediaIdOf(payload);
  const match = id === undefined ? null : SIM_REFERENCE.exec(id);
  if (match === null) return undefined;
  const fileName = payload?.type === "document" ? payload.document.filename : payload?.type === "template" ? headerFileName(payload) : undefined;
  return { bucket: match[1] as "Evidence" | "Media", key: match[2] ?? "", ...(fileName === undefined ? {} : { fileName }) };
}

function headerFileName(payload: Extract<MetaMessage, { type: "template" }>): string | undefined {
  for (const component of payload.template.components) if (component.type === "header") return component.parameters[0].document.filename;
  return undefined;
}

const CONTENT_TYPE = { AUDIO: undefined, IMAGE: "image/jpeg", DOCUMENT: "application/pdf" } as const;

/** One bubble of the thread. */
export async function bubbleOf(message: Message, ports: ConsolePorts) {
  const payload = message.direction === "OUT" ? payloadOf(message) : undefined;
  const shown = payload === undefined ? undefined : displayOf(payload);
  const attachment = attachmentOf(payload);
  let mediaUrl: string | null = null;
  if (message.media !== undefined) {
    const bucket = message.media.kind === "DOCUMENT" ? "Evidence" : "Media";
    mediaUrl = await ports.objects.presignGet({ bucket, key: message.media.s3Key, contentType: CONTENT_TYPE[message.media.kind] ?? message.media.mime });
  } else if (attachment !== undefined) {
    const contentType = attachment.fileName === undefined ? "image/jpeg" : "application/pdf";
    mediaUrl = await ports.objects.presignGet({ bucket: attachment.bucket, key: attachment.key, contentType, ...(attachment.fileName === undefined ? {} : { download: attachment.fileName }) });
  }
  return {
    messageId: message.messageId,
    direction: message.direction,
    content: message.content,
    kind: message.kind ?? null,
    text: shown?.text ?? message.text ?? null,
    templateName: message.templateName ?? null,
    buttons: message.direction === "OUT" ? buttonsOf(payload) : [],
    buttonAction: message.buttonAction ?? null,
    transcript: message.transcript?.text ?? null,
    mediaKind: message.media?.kind ?? (attachment === undefined ? null : attachment.fileName === undefined ? "IMAGE" : "DOCUMENT"),
    mediaUrl,
    fileName: attachment?.fileName ?? null,
    reaction: payload?.type === "reaction" ? { emoji: payload.reaction.emoji, to: payload.reaction.message_id } : null,
    status: message.status,
    sentAtSim: message.sentAtSim,
    providerMessageId: message.providerMessageId ?? null,
  };
}

// ---- Catalog of the synthetic set ------------------------------------------------------------------

const VoiceSheet = z.object({ notes: z.array(z.object({ voiceId: z.string(), durationSec: z.number(), speaker: z.string().nullable(), text: z.string(), use: z.string().optional() }).loose()) }).loose();

/** The 12 synthetic voice notes (scripts/seed/audio/datasheet.json, the one source of their texts). */
export function voiceCatalog() {
  return VoiceSheet.parse(voiceSheet).notes.map((note) => ({ voiceId: note.voiceId, durationSec: note.durationSec, speaker: note.speaker, text: note.text }));
}

/** `Seed/audio/<voiceId>.ogg` and `Seed/photos/<photoId>.jpg` (docs/architecture.md §6). */
export const seedKeys = {
  voice: (voiceId: string): string => `audio/${voiceId}.ogg`,
  photo: (photoId: string): string => `photos/${photoId}.jpg`,
} as const;

// ---- Quick messages of the tour ----------------------------------------------------------------------

/** A quick message also does what the person did in the field (docs/architecture-integrations.md §6). */
const PHYSICAL_ACTIONS: Readonly<Record<string, "INSTALLER_STEP">> = { "s1-connector-cleaned": "INSTALLER_STEP" };

export type QuickAction =
  | { readonly type: "TEXT"; readonly text: string }
  | { readonly type: "VOICE"; readonly voiceId: string }
  | { readonly type: "PHOTO"; readonly photoId: string; readonly item: PhotoItem }
  | { readonly type: "TAP"; readonly title: string };

export interface QuickMessage {
  readonly quickId: string;
  readonly scene: string;
  /** The story's party (`inst-rogelio`, `sup-hector`): the world's person is resolved by prefix. */
  readonly party: string;
  readonly label: string;
  readonly glossEn: string;
  readonly action: QuickAction;
  readonly physicalAction?: "INSTALLER_STEP";
  readonly workOrderNumber: string;
}

function quickOf(entry: StoryEntry): QuickMessage | undefined {
  if (entry.from === "cuadrilla") return undefined;
  const base = { quickId: entry.id, scene: entry.scene, party: entry.from, label: entry.text, glossEn: entry.glossEn, workOrderNumber: entry.workOrderNumber, ...(PHYSICAL_ACTIONS[entry.id] === undefined ? {} : { physicalAction: PHYSICAL_ACTIONS[entry.id] }) };
  switch (entry.kind) {
    case "TEXT":
      return entry.label === "storyText" ? { ...base, action: { type: "TEXT", text: entry.text } } : undefined;
    case "VOICE":
      return { ...base, action: { type: "VOICE", voiceId: entry.voiceId } };
    case "PHOTO":
      return entry.photoId === null ? undefined : { ...base, action: { type: "PHOTO", photoId: entry.photoId, item: entry.item } };
    case "BUTTON":
      return { ...base, action: { type: "TAP", title: entry.text } };
    default:
      return undefined;
  }
}

/** The quick messages of the main story, in its order (story/main-story.ts, the one source). */
export const QUICK_MESSAGES: readonly QuickMessage[] = MAIN_STORY.flatMap((entry) => {
  const quick = quickOf(entry);
  return quick === undefined ? [] : [quick];
});

export function quickMessage(quickId: string): QuickMessage {
  const found = QUICK_MESSAGES.find((quick) => quick.quickId === quickId);
  if (found === undefined) throw new ToolError("NOT_FOUND", "no such quick message");
  return found;
}

/** The world's person a story party stands for: the same id, or the id with the world's tag. */
export function personOfParty(people: readonly Person[], party: string): Person | undefined {
  return people.find((person) => person.personId === party) ?? people.find((person) => person.personId.startsWith(`${party}-`));
}

/** What the guest forwards from a real phone (live transport only): the story's photos and voice note. */
export const KIT = {
  photos: ["ph-meter-01", "ph-story-01", "ph-label-01", "ph-rosette-02"],
  voices: ["vn-01"],
} as const;
