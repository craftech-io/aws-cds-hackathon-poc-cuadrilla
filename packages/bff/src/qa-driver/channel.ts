// `wa.inbound` (docs/tool-catalog.md): what a person of a QA world sends, by the same path as the console's
// phone simulator (routers/simulator.ts): the signed SNS envelope of the world (channels/whatsapp/
// sim-envelope.ts) handed to `InboundWhatsApp`, with media only as an `UPLOAD#` of the world under its
// simulator key. The world must be `simulated`. Unlike the console's phone, no per-identity cap of the
// simulator applies (a scenario proves the business rate limit, `CP-RATE`, through it); the stage's
// ceiling and the kill switch still apply inside `InboundWhatsApp` and the worker.
//
// Ids derive from the step's key: the `wamid` (`qaWamid`) and the upload, so a retried step is the same
// message and `InboundWhatsApp` deduplicates it (FL-093).
import { createHash } from "node:crypto";
import { type ClockId, ToolError, type WaButtonAction } from "@cuadrilla/shared";
import { simMediaKey } from "@cuadrilla/shared/media/keys";
import { type SimulatedContent, buildSimulatedEvent, qaWamid } from "../channels/whatsapp/sim-envelope";
import type { Message } from "../domain/conversations";
import { buttonsOf, payloadOf, seedKeys } from "../routers/simulator-views";
import { unknownPhoneOf } from "../routers/simulator";
import { MEDIA_LIMITS } from "../channels/whatsapp/config";
import { QA_USER_BY_ROLE } from "../auth/qa-principal";
import type { InboundContent } from "./contract-inputs";
import type { QaPorts } from "./ports";

export interface InboundSent {
  readonly wamid: string;
  readonly sentAtReal: string;
  readonly uploadId?: string;
  /** What `InboundWhatsApp` answered (counts and outcomes, never a text). */
  readonly answer: unknown;
}

interface Sender {
  readonly phone: string;
  readonly personId?: string;
}

type Ports = Pick<QaPorts, "data" | "inbound" | "simEnvelopeKey" | "media">;

async function senderOf(ports: Ports, clockId: string, identity: string): Promise<Sender> {
  const ispId = (await ports.data.runtime.getClock(clockId))?.ispId;
  if (ispId === undefined) throw new ToolError("NOT_FOUND", `the world ${clockId} does not exist`);
  if (identity === "UNKNOWN") return { phone: unknownPhoneOf(ispId, "QA") };
  const person = await ports.data.people.requirePerson(identity);
  if (person.clockId !== clockId || person.phone === undefined) throw new ToolError("INVALID", `${identity} has no phone in ${clockId}`, "NO_PHONE");
  return { phone: person.phone, personId: person.personId };
}

/** A tap: the button of `action` on the latest message to `personId` that offers it (its id is the nonce). */
export async function buttonOf(ports: Pick<QaPorts, "data">, personId: string, action: WaButtonAction, title?: string, objectId?: string): Promise<{ readonly message: Message; readonly content: SimulatedContent }> {
  const thread = await ports.data.conversations.listMessages(personId, { limit: 300, descending: true });
  for (const message of thread) {
    if (message.direction !== "OUT") continue;
    for (const button of buttonsOf(payloadOf(message))) {
      if (title !== undefined && button.title !== title) continue;
      const nonce = await ports.data.runtime.getNonce(button.id);
      if (nonce === undefined || nonce.action !== action || (objectId !== undefined && nonce.object.id !== objectId)) continue;
      const content: SimulatedContent = button.kind === "button" ? { type: "button", payload: button.id, text: button.title } : { type: button.kind, id: button.id, title: button.title };
      return { message, content };
    }
  }
  throw new ToolError("CONFLICT", `no live ${action} button was offered to ${personId}`, "NO_BUTTON");
}

/**
 * The key of an inbound of the evaluation (`eval.runQuestions`): one per attempt at an item (the driver
 * call's key and the item, `evalAttempt`) and per message of that attempt (`text`, or the tap of a nonce).
 * A transport retry of the call is the same message; the runner's retry of an item, or a `rerun`, is not.
 */
export function evalInboundKey(input: { readonly clockId: string; readonly installerId: string; readonly attempt: string; readonly tapNonce?: string }): string {
  const digest = createHash("sha256").update(`${input.attempt}\n${input.tapNonce ?? "text"}`, "utf8").digest("base64url").slice(0, 22);
  return `eval/${input.clockId}/${input.installerId}/${input.tapNonce === undefined ? "q" : "tap"}/${digest}`;
}

function uploadIdOf(key: string): string {
  return `qa-${createHash("sha256").update(key, "utf8").digest("hex").slice(0, 40)}`;
}

/** A JPEG-looking body of `bytes` (SOI and APP0 markers, then zeros): the channel refuses it by size. */
export function oversizeJpeg(bytes: number): Uint8Array {
  const body = new Uint8Array(bytes);
  body.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
  return body;
}

async function upload(ports: Ports, clockId: string, key: string, kind: "PHOTO" | "VOICE", put: (objectKey: string) => Promise<void>): Promise<string> {
  const clock = await ports.data.runtime.getClock(clockId);
  if (clock === undefined) throw new ToolError("NOT_FOUND", `the world ${clockId} does not exist`);
  const uploadId = uploadIdOf(key);
  const objectKey = simMediaKey(clockId, clock.worldEpoch, uploadId);
  if ((await ports.data.worlds.getUpload(uploadId)) === undefined) {
    await put(objectKey);
    const maxBytes = kind === "PHOTO" ? Math.max(MEDIA_LIMITS.simulatorImageBytes, 6 * 1024 * 1024) : MEDIA_LIMITS.audioBytes;
    await ports.data.worlds.createUpload({ uploadId, userId: QA_USER_BY_ROLE.SUPERVISOR, clockId, key: objectKey, kind, maxBytes });
  }
  return uploadId;
}

/** The simulated content of a request (media copied or written under the world's simulator key first). */
async function contentOf(ports: Ports, clockId: string, key: string, sender: Sender, content: InboundContent): Promise<{ readonly content: SimulatedContent; readonly uploadId?: string }> {
  switch (content.type) {
    case "text":
      return { content: { type: "text", body: content.text } };
    case "button": {
      const tapper = content.fromPersonId ?? sender.personId;
      if (tapper === undefined) throw new ToolError("INVALID", "the unknown number received no buttons");
      return { content: (await buttonOf(ports, tapper, content.action, content.title, content.objectId)).content };
    }
    case "voice": {
      const uploadId = await upload(ports, clockId, key, "VOICE", (objectKey) => ports.media.copyFromSeed({ sourceKey: seedKeys.voice(content.voiceId), key: objectKey, contentType: "audio/ogg" }));
      return { content: { type: "voice", uploadId, mimeType: "audio/ogg" }, uploadId };
    }
    case "photo": {
      const uploadId = await upload(ports, clockId, key, "PHOTO", (objectKey) => ports.media.copyFromSeed({ sourceKey: seedKeys.photo(content.photoId), key: objectKey, contentType: "image/jpeg" }));
      return { content: { type: "photo", uploadId, mimeType: "image/jpeg", ...(content.caption === undefined ? {} : { caption: content.caption }) }, uploadId };
    }
    case "oversizeImage": {
      const uploadId = await upload(ports, clockId, key, "PHOTO", (objectKey) => ports.media.put({ key: objectKey, bytes: oversizeJpeg(content.bytes), contentType: "image/jpeg" }));
      return { content: { type: "photo", uploadId, mimeType: "image/jpeg" }, uploadId };
    }
    case "other":
      return { content: { type: "other", kind: content.kind } };
  }
}

/** One inbound message of `identity` in `clockId`, keyed by `key` (the step's idempotency key). */
export async function sendInbound(ports: Ports, input: { readonly clockId: string; readonly identity: string; readonly content: InboundContent; readonly key: string; readonly now: Date; readonly wamidKey?: string }): Promise<InboundSent> {
  const settings = await ports.data.isps.getSettings((await ports.data.runtime.getClock(input.clockId))?.ispId ?? "");
  if (settings !== undefined && settings.whatsappMode !== "simulated") throw new ToolError("FORBIDDEN", "this world talks over the live channel", "WORLD_NOT_SIMULATED");
  const sender = await senderOf(ports, input.clockId, input.identity);
  const built = await contentOf(ports, input.clockId, input.key, sender, input.content);
  const wamid = qaWamid(input.wamidKey === undefined ? input.key : `${input.clockId}/${input.wamidKey}`);
  const event = buildSimulatedEvent({ clockId: input.clockId as ClockId, from: sender.phone, wamid, content: built.content, sentAtReal: input.now }, ports.simEnvelopeKey());
  const answer = await ports.inbound(event);
  return { wamid, sentAtReal: input.now.toISOString(), ...(built.uploadId === undefined ? {} : { uploadId: built.uploadId }), answer: answer ?? null };
}
