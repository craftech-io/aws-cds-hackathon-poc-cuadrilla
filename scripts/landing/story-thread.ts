// The main story's WhatsApp conversations in a capture world (docs/landing-spec.md §6.2): Rogelio's day
// (packages/bff/src/story/main-story.ts, the one source of its texts) written up to one entry into the
// world's `Conversations`, as the outbound pipeline and `InboundWhatsApp` store them — the Cloud API
// payload of every outbound message (`refs.whatsapp`, without the recipient), the photos and the voice
// note of the synthetic set in `Media`, the validator's reaction on each photo — so a capture of the
// phone simulator or of an order's timeline shows the moment the landing tells without running a turn
// of the agent. An example reply of the agent is the story's (labelled `exampleAgentReply` there), as on
// the renders it replaces.
//
// The scene the world jumped to wrote its own messages first (the "Cerrar instalación" offer, the case
// templates the ladder sends): a message whose text the person's thread already holds is not written
// again. Nothing here reaches AWS; the world is the capture's, in memory.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { simMediaKey } from "../../packages/shared/src/media/keys";
import type { MetaMessage } from "../../packages/bff/src/channels/whatsapp/meta-messages";
import { displayOf, renderDocument, renderReaction, renderReplyButtons, renderTemplate, renderText } from "../../packages/bff/src/channels/whatsapp/render";
import { storedPayload } from "../../packages/bff/src/channels/whatsapp/transport";
import { BUTTON_LABELS } from "../../packages/bff/src/copy/buttons";
import type { Connector } from "../../packages/bff/src/connector/ports";
import type { NewEntity } from "../../packages/bff/src/domain/common";
import type { Message, Message as MessageSchema } from "../../packages/bff/src/domain/conversations";
import type { WorkOrder } from "../../packages/bff/src/domain/work-orders";
import { sha256Hex } from "../../packages/bff/src/lib/crypto";
import type { MemoryObjects } from "../../packages/bff/src/routers/console-testing";
import { payloadOf } from "../../packages/bff/src/routers/simulator-views";
import { MAIN_STORY, STORY_SCENES } from "../../packages/bff/src/story/main-story";
import { templateParams } from "../../packages/bff/src/story/render";
import type { StoryEntry, StoryParty, StoryPerson } from "../../packages/bff/src/story/types";
import { markersFor } from "../../packages/bff/src/worlds/template";

const ROOT = join(import.meta.dirname, "../..");

/** The capture world the story is written into. */
export interface StoryWorld {
  readonly connector: Connector;
  readonly objects: Pick<MemoryObjects, "put">;
  readonly ispId: string;
  readonly clockId: string;
}

/** Ids of the world for the story's people and orders: the `guest` template's ids with the world's tag. */
export interface StoryIds {
  person(party: StoryPerson): string;
  order(workOrderNumber: string): string;
}

export function storyIds(ispId: string): StoryIds {
  const { clockTag } = markersFor(ispId);
  return { person: (party) => `${party}-${clockTag}`, order: (workOrderNumber) => `wo-${workOrderNumber}-${clockTag}` };
}

/** The story up to and including `through`, in its order. */
export function storyThrough(through: string): StoryEntry[] {
  const at = MAIN_STORY.findIndex((entry) => entry.id === through);
  if (at < 0) throw new Error(`the main story has no entry ${through}`);
  return MAIN_STORY.slice(0, at + 1);
}

/**
 * What a world jumped to `jump` holds of the story up to `through`: the conversation of the order that
 * scene prepares (a jump reloads the world, so another order's past is not in it), in its order.
 */
export function sceneStory(jump: string, through: string): StoryEntry[] {
  const scene = STORY_SCENES.find((candidate) => candidate.jumpScenes.includes(jump));
  if (scene === undefined) throw new Error(`the scene ${jump} prepares no moment of the main story`);
  return storyThrough(through).filter((entry) => entry.workOrderNumber === scene.workOrderNumber);
}

/** What a person reads on a stored message: the payload's text for an outbound one, the text otherwise. */
export function shownText(message: Message): string | undefined {
  const payload = message.direction === "OUT" ? payloadOf(message) : undefined;
  return (payload === undefined ? undefined : displayOf(payload).text) ?? message.text;
}

/** Kinds of the story's outbound messages, as the product stores them (`MessageKind`). */
const OUT_KIND: Readonly<Record<string, Message["kind"]>> = {
  "s5-case-opened": "CASE_NOTICE",
  "s5-case-reassigned-notice": "CASE_NOTICE",
  "s5-case-taken": "CASE_TAKEN_NOTICE",
  "s5-case-brief": "CASE_BRIEF",
  "s5-case-closed": "CASE_NOTICE",
  "s6-safety-instruction": "SAFETY_INSTRUCTION",
  "s6-safety-case-opened": "CASE_NOTICE",
};

function outKind(entry: StoryEntry): NonNullable<Message["kind"]> {
  if (entry.kind === "TEMPLATE") return entry.template.name === "alerta_seguridad" ? "SAFETY_ALERT" : "CASE_REQUEST";
  if (entry.kind === "RELAY") return "RELAY";
  if (entry.kind === "DOCUMENT") return "CERTIFICATE";
  return OUT_KIND[entry.id] ?? "REPLY";
}

/** Button ids of a seeded message: shown, never tapped (a tap needs the nonce of a real send). */
function storyButtons(entry: StoryEntry, actions: readonly string[]) {
  return actions.map((action, index) => ({ id: `story-${entry.id}-${index}`, title: BUTTON_LABELS[action as keyof typeof BUTTON_LABELS].es }));
}

/** The Cloud API payload the pipeline would have sent for an outbound entry. */
function outboundPayload(entry: StoryEntry, phone: string, certificate: CertificateRef | undefined): MetaMessage {
  switch (entry.kind) {
    case "TEMPLATE":
      return renderTemplate(phone, { name: entry.template.name, params: templateParams(entry.template, "es"), buttonNonces: storyButtons(entry, entry.buttons).map((button) => button.id) });
    case "DOCUMENT":
      if (certificate === undefined) throw new Error(`${entry.id}: the certificate is written before it is sent`);
      return renderDocument(phone, `sim-s3:Evidence:${certificate.s3Key}`, certificate.fileName);
    case "TEXT":
    case "COPY":
      return entry.buttons.length > 0 ? renderReplyButtons(phone, entry.text, storyButtons(entry, entry.buttons)) : renderText(phone, entry.text);
    default:
      return renderText(phone, entry.text);
  }
}

/** The certificate the story's document points at (story-mail.ts writes it). */
export interface CertificateRef {
  readonly s3Key: string;
  readonly fileName: string;
}

function providerId(clockId: string, messageId: string): string {
  return `wamid.SIM.${sha256Hex(`${clockId}/${messageId}`).slice(0, 32)}`;
}

/** A file of the synthetic set into the world's `Media`, as the simulator's upload leaves it. */
function mediaOf(world: StoryWorld, order: WorkOrder, entryId: string, file: string, mime: string) {
  const bytes = new Uint8Array(readFileSync(join(ROOT, file)));
  const s3Key = simMediaKey(order.clockId, order.worldEpoch, `story-${entryId}`);
  world.objects.put("Media", s3Key, bytes, mime);
  return { s3Key, sha256: sha256Hex(bytes), mime, bytes: bytes.byteLength };
}

type NewMessage = NewEntity<typeof MessageSchema>;

/** The rows one WhatsApp entry of the story becomes in the thread of `personId`. */
function rowsOf(world: StoryWorld, entry: StoryEntry, personId: string, phone: string, order: WorkOrder, certificate: CertificateRef | undefined): NewMessage[] {
  const messageId = `msg-story-${entry.id}`;
  const common = {
    messageId,
    personId,
    ispId: world.ispId,
    clockId: world.clockId,
    channel: "WHATSAPP" as const,
    workOrderId: order.workOrderId,
    simulated: true,
    transport: "simulated" as const,
    providerMessageId: providerId(world.clockId, messageId),
    sentAtSim: entry.atSim,
    seeded: true,
  };
  if (entry.from === "cuadrilla") {
    const payload = outboundPayload(entry, phone, certificate);
    const kind = outKind(entry);
    const content = entry.kind === "TEMPLATE" ? "TEMPLATE" : entry.kind === "DOCUMENT" ? "DOCUMENT" : entry.kind === "TEXT" || entry.kind === "COPY" ? (entry.buttons.length > 0 ? "INTERACTIVE" : "TEXT") : "TEXT";
    return [
      {
        ...common,
        direction: "OUT",
        content,
        kind,
        text: entry.text,
        ...(entry.kind === "TEMPLATE" ? { templateName: entry.template.name, templateParams: templateParams(entry.template, "es") } : {}),
        status: "READ",
        author: kind === "REPLY" ? "AGENT" : "SYSTEM",
        refs: { seeded: true, story: entry.id, whatsapp: storedPayload(payload) },
      },
    ];
  }
  const inbound = { ...common, direction: "IN" as const, status: "RECEIVED" as const, author: `PERSON:${personId}`, refs: { seeded: true, story: entry.id } };
  switch (entry.kind) {
    case "VOICE":
      return [{ ...inbound, content: "VOICE", media: { kind: "AUDIO", durationSec: entry.durationSec, ...mediaOf(world, order, entry.id, `scripts/seed/audio/${entry.voiceId}.ogg`, "audio/ogg") }, transcript: { text: entry.text, confidence: 0.94 } }];
    case "PHOTO": {
      if (entry.photoId === null) throw new Error(`${entry.id}: a photo of the story without its photo of the set`);
      const photo: NewMessage = { ...inbound, content: "IMAGE", media: { kind: "IMAGE", ...mediaOf(world, order, entry.id, `scripts/seed/photos/out/${entry.photoId}.jpg`, "image/jpeg") } };
      // The validator's verdict lands on the photo's bubble a few seconds later (VERDICT_REACTION, FL-103).
      const reactionId = `${messageId}-reaction`;
      const reaction: NewMessage = {
        ...common,
        messageId: reactionId,
        providerMessageId: providerId(world.clockId, reactionId),
        direction: "OUT",
        content: "REACTION",
        kind: "VERDICT_REACTION",
        status: "READ",
        author: "SYSTEM",
        sentAtSim: new Date(Date.parse(entry.atSim) + 5_000).toISOString(),
        refs: { seeded: true, story: entry.id, whatsapp: storedPayload(renderReaction(phone, common.providerMessageId, entry.reaction)) },
      };
      return [photo, reaction];
    }
    case "BUTTON":
      return [{ ...inbound, content: "BUTTON", text: entry.text, buttonAction: entry.action }];
    default:
      return [{ ...inbound, content: "TEXT", text: entry.text }];
  }
}

/** The person whose phone shows a WhatsApp entry: the one who is not Cuadrilla. */
function partyOf(entry: StoryEntry): StoryPerson {
  const party: StoryParty = entry.from === "cuadrilla" ? entry.to : entry.from;
  if (party === "cuadrilla") throw new Error(`${entry.id}: Cuadrilla talks to itself`);
  return party;
}

export interface SeededThread {
  /** Messages written, by story entry. */
  readonly written: readonly string[];
  /** Entries the scene's own presets had already written. */
  readonly skipped: readonly string[];
}

/**
 * Writes the WhatsApp entries of `entries` (sceneStory; the email entries are story-mail.ts's).
 * `certificate` is the certificate the document entry sends, when the story reaches it.
 */
export async function seedStoryThread(world: StoryWorld, entries: readonly StoryEntry[], certificate?: CertificateRef): Promise<SeededThread> {
  const ids = storyIds(world.ispId);
  const written: string[] = [];
  const skipped: string[] = [];
  const shown = new Map<string, Set<string>>();
  for (const entry of entries) {
    if (entry.channel !== "WHATSAPP") continue;
    const personId = ids.person(partyOf(entry));
    const person = await world.connector.people.requirePerson(personId);
    if (person.phone === undefined) throw new Error(`${personId} has no phone in the capture world`);
    let texts = shown.get(personId);
    if (texts === undefined) {
      const thread = await world.connector.conversations.listMessages(personId, { limit: 500 });
      texts = new Set(thread.map(shownText).filter((text): text is string => text !== undefined));
      shown.set(personId, texts);
    }
    if (entry.kind !== "PHOTO" && entry.kind !== "VOICE" && texts.has(entry.text)) {
      skipped.push(entry.id);
      continue;
    }
    const order = await world.connector.workOrders.requireWorkOrder(ids.order(entry.workOrderNumber));
    for (const row of rowsOf(world, entry, personId, person.phone, order, certificate)) await world.connector.conversations.appendMessage(row);
    texts.add(entry.text);
    written.push(entry.id);
  }
  return { written, skipped };
}
