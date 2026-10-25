// `simulator` router of the console (docs/tool-catalog.md; FL-082, FL-083, FL-101; docs/architecture.md
// §10): the phone simulator of the principal's world. Every action enters by the same signed SNS envelope
// a live event has (channels/whatsapp/sim-envelope.ts), with the world of the principal (never one the
// browser names), as an identity of that world or the world's unknown number.
//
//   identities, thread, catalog, quickMessages, kit       what the phone draws (routers/simulator-views.ts)
//   sendText, tapButton, sendVoiceNote, sendPhoto, sendQuick, markRead
//   presignMedia                                          `UPLOAD#` (user, world, key, kind) + presigned POST
//   joinCode                                              live transport only: a one-use "ALTA" code
//
// Before anything is handed to `InboundWhatsApp`: the world must be `simulated`, the kill switch
// `KILL#SIMULATOR` off, the world's caps (`SIMCAP#`) and the stage's ceiling with room (checked, never
// taken: the worker reserves the turn), and the identity under its messages per real hour (a "+1 h" of
// the demo clock never frees it). A photo or a voice note travels only by an `uploadId` of the same
// user and world, used once, whose object passes `HeadObject` and the magic bytes; a key of S3 never
// comes from the browser.
import { z } from "zod";
import { type ClockId, PersonId, PhotoId, ToolError, VoiceNoteId } from "@cuadrilla/shared";
import { simMediaKey } from "@cuadrilla/shared/media/keys";
import { COUNTER_KEYS, hourKey } from "../connector/keys";
import { PHOTO_ITEM_BUTTONS } from "../copy/buttons";
import { RUNTIME_TTL_SECONDS } from "../domain/runtime";
import { rateLimitsOf } from "../channels/rate-limit";
import { MEDIA_LIMITS, SIMULATOR_AUDIO_TYPES } from "../channels/whatsapp/config";
import { issueJoinCode } from "../channels/whatsapp/lease";
import { baseMimeType, sniffMediaType } from "../channels/whatsapp/media";
import { type SimulatedContent, buildSimulatedEvent, simulatorWamid } from "../channels/whatsapp/sim-envelope";
import type { Person } from "../domain/people";
import type { Upload, UploadKind } from "../domain/runtime-world";
import { type CostResource, reserveCost } from "../ops/cost-caps";
import { markersFor } from "../worlds/template";
import { type ConsolePorts, consoleCall, inWorldTime, ownRow, worldToday } from "./console-ports";
import { KIT, QUICK_MESSAGES, UNKNOWN_IDENTITY, bubbleOf, buttonsOf, payloadOf, personOfParty, quickMessage, seedKeys, voiceCatalog } from "./simulator-views";
import { type IspContext, ispProcedure, router } from "./trpc";

const Identity = z.union([PersonId, z.literal(UNKNOWN_IDENTITY)]);
const UploadId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const ByIdentity = z.object({ identity: Identity }).strict();
const TextInput = z.object({ identity: Identity, text: z.string().trim().min(1).max(4096) }).strict();
const TapInput = z.object({ identity: Identity, messageId: z.string().min(1).max(200), buttonId: z.string().min(1).max(256) }).strict();
const VoiceInput = z.union([z.object({ identity: Identity, uploadId: UploadId }).strict(), z.object({ identity: Identity, voiceId: VoiceNoteId }).strict()]);
const PhotoInput = z.union([
  z.object({ identity: Identity, uploadId: UploadId, caption: z.string().trim().min(1).max(1024).optional() }).strict(),
  z.object({ identity: Identity, photoId: PhotoId }).strict(),
]);
const PresignInput = z.object({ kind: z.enum(["PHOTO", "VOICE"]), contentType: z.string().min(1).max(100) }).strict();

/** The number of the demo world nobody registered (docs/seed-spec.md §2); a guest world's is in its own block. */
export const DEMO_UNKNOWN_PHONE = "+525501990001";

type Ctx = Pick<IspContext, "deps" | "world" | "principal" | "log">;

interface SimWorld {
  readonly ports: ConsolePorts;
  readonly settings: NonNullable<Awaited<ReturnType<IspContext["deps"]["connector"]["isps"]["getSettings"]>>>;
}

async function simWorld(ctx: Ctx): Promise<SimWorld> {
  const settings = await ctx.deps.connector.isps.getSettings(ctx.world.ispId);
  if (settings === undefined || settings.clockId !== ctx.world.clockId) throw new ToolError("NOT_FOUND", "settings of the world not found");
  if (settings.whatsappMode !== "simulated") throw new ToolError("FORBIDDEN", "this world talks over the live channel", "WORLD_NOT_SIMULATED");
  return { ports: consoleCall(ctx).ports, settings };
}

export function unknownPhoneOf(ispId: string, kind: string): string {
  return kind === "GUEST" ? `+5255${markersFor(ispId).phoneBlock}0999` : DEMO_UNKNOWN_PHONE;
}

interface Sender {
  readonly personId?: string;
  readonly phone: string;
  readonly phoneHash: string;
}

async function senderOf(ctx: Ctx, world: SimWorld, identity: string): Promise<Sender> {
  if (identity === UNKNOWN_IDENTITY) {
    const phone = unknownPhoneOf(ctx.world.ispId, ctx.world.kind);
    return { phone, phoneHash: world.ports.hashPhone(phone) };
  }
  const person = ownRow(ctx, await ctx.deps.connector.people.getPerson(identity), "identity");
  if (person.phone === undefined || person.phoneHash === undefined) throw new ToolError("INVALID", "this identity has no phone", "NO_PHONE");
  return { personId: person.personId, phone: person.phone, phoneHash: person.phoneHash };
}

/** Kill switch, caps and ceiling (checked, not taken) and the identity's messages per real hour. */
async function admit(ctx: Ctx, world: SimWorld, sender: Sender, resources: readonly CostResource[]): Promise<void> {
  for (const resource of resources) {
    const outcome = await reserveCost(
      { ...world.ports.costCaps, logger: ctx.log },
      { world: { clockId: ctx.world.clockId, settings: world.settings }, resource, amount: resource === "transcribe" ? 60 : 1, reserve: [], check: ["SIMULATOR", "GLOBAL"], surface: "SIMULATOR" },
    );
    if (!outcome.ok && outcome.code === "KILL_SWITCH_ACTIVE") throw new ToolError("UNAVAILABLE", "the simulator is paused", "KILL_SWITCH_ACTIVE");
    if (!outcome.ok) throw new ToolError("CAP_REACHED", `the ${resource} cap is reached until ${outcome.counter.resetsAtReal}`, outcome.counter.tier ?? outcome.counter.ledger);
  }
  const realNow = await world.ports.services.realClock.now();
  const limit = rateLimitsOf(world.settings).perRealHour;
  const counter = await ctx.deps.connector.runtime.getCounter(COUNTER_KEYS.rateReal(ctx.world.clockId, sender.phoneHash, hourKey(realNow)));
  if ((counter?.count ?? 0) >= limit) {
    const resetsAt = new Date(Math.floor(realNow.getTime() / 3_600_000 + 1) * 3_600_000).toISOString();
    ctx.log.warn("simulator.rate.limited", { metric: "SimulatorCapHits", window: "REAL_HOUR", limit });
    throw new ToolError("CAP_REACHED", `at most ${limit} messages per hour from one identity, until ${resetsAt}`, "RATE_LIMIT");
  }
}

/** The signed envelope to `InboundWhatsApp`, as the person of the world. */
async function deliver(ctx: Ctx, world: SimWorld, sender: Sender, content: SimulatedContent) {
  const realNow = await world.ports.services.realClock.now();
  const wamid = simulatorWamid(world.ports.newId(realNow.getTime()));
  const event = buildSimulatedEvent({ clockId: ctx.world.clockId as ClockId, from: sender.phone, wamid, content, sentAtReal: realNow }, world.ports.simEnvelopeKey());
  await world.ports.inbound(event);
  ctx.log.info("simulator.sent", { type: content.type, identity: sender.personId ?? UNKNOWN_IDENTITY });
  return { wamid, sentAtReal: realNow.toISOString() };
}

async function send(ctx: Ctx, identity: string, content: SimulatedContent, resources: readonly CostResource[] = ["turns"]) {
  const world = await simWorld(ctx);
  const sender = await senderOf(ctx, world, identity);
  await admit(ctx, world, sender, resources);
  return deliver(ctx, world, sender, content);
}

async function currentEpoch(ctx: Ctx): Promise<number> {
  const clock = await ctx.deps.connector.runtime.getClock(ctx.world.clockId);
  if (clock === undefined) throw new ToolError("NOT_FOUND", "the world has no clock");
  return clock.worldEpoch;
}

const ALLOWED_TYPES: Readonly<Record<UploadKind, readonly string[]>> = { PHOTO: ["image/jpeg"], VOICE: SIMULATOR_AUDIO_TYPES };
const MAX_BYTES: Readonly<Record<UploadKind, number>> = { PHOTO: MEDIA_LIMITS.simulatorImageBytes, VOICE: MEDIA_LIMITS.audioBytes };

/** An upload of this user and world, used once, whose object is what it claims to be. */
async function takeUpload(ctx: Ctx, world: SimWorld, uploadId: string, kind: UploadKind): Promise<{ readonly upload: Upload; readonly mimeType: string }> {
  const upload = await ctx.deps.connector.worlds.getUpload(uploadId);
  if (upload === undefined || upload.userId !== ctx.principal.userId || upload.clockId !== ctx.world.clockId || upload.kind !== kind) {
    throw new ToolError("FORBIDDEN", "this upload is not yours", "UPLOAD_NOT_YOURS");
  }
  if (upload.key !== simMediaKey(ctx.world.clockId, await currentEpoch(ctx), uploadId)) throw new ToolError("CONFLICT", "the world was reset after this upload", "UPLOAD_STALE");
  await ctx.deps.connector.worlds.useUpload(uploadId);
  const media = world.ports.objects.media;
  const stored = await media.head(upload.key);
  if (stored === undefined) throw new ToolError("INVALID", "nothing was uploaded", "UPLOAD_MISSING");
  const declared = baseMimeType(stored.contentType);
  const proven = sniffMediaType(await media.readStart(upload.key, 16));
  if (stored.bytes > Math.min(upload.maxBytes, MAX_BYTES[kind]) || !ALLOWED_TYPES[kind].includes(declared) || proven !== declared) {
    await media.delete(upload.key);
    throw new ToolError("INVALID", "the file is not a valid photo or voice note", "MEDIA_REJECTED");
  }
  return { upload, mimeType: declared };
}

/** A file of the synthetic set as this user's upload, copied into the world's simulator prefix. */
async function sampleUpload(ctx: Ctx, world: SimWorld, kind: UploadKind, sourceKey: string, contentType: string): Promise<string> {
  const realNow = await world.ports.services.realClock.now();
  const uploadId = `upl-${world.ports.newId(realNow.getTime())}`;
  const key = simMediaKey(ctx.world.clockId, await currentEpoch(ctx), uploadId);
  await world.ports.objects.copyFromSeed({ sourceKey, key, contentType });
  await ctx.deps.connector.worlds.createUpload({ uploadId, userId: ctx.principal.userId, clockId: ctx.world.clockId, key, kind, maxBytes: MAX_BYTES[kind] });
  return uploadId;
}

export async function sendVoice(ctx: Ctx, input: z.infer<typeof VoiceInput>) {
  const world = await simWorld(ctx);
  const sender = await senderOf(ctx, world, input.identity);
  await admit(ctx, world, sender, ["turns", "transcribe"]);
  const uploadId = "voiceId" in input ? await sampleUpload(ctx, world, "VOICE", seedKeys.voice(input.voiceId), "audio/ogg") : input.uploadId;
  const { mimeType } = await takeUpload(ctx, world, uploadId, "VOICE");
  return deliver(ctx, world, sender, { type: "voice", uploadId, mimeType });
}

/** `caption`: a quick photo of the tour names its item with the item's button title. */
async function sendPhoto(ctx: Ctx, input: z.infer<typeof PhotoInput>, quickCaption?: string) {
  const world = await simWorld(ctx);
  const sender = await senderOf(ctx, world, input.identity);
  await admit(ctx, world, sender, ["turns", "validations"]);
  const uploadId = "photoId" in input ? await sampleUpload(ctx, world, "PHOTO", seedKeys.photo(input.photoId), "image/jpeg") : input.uploadId;
  const { mimeType } = await takeUpload(ctx, world, uploadId, "PHOTO");
  const caption = "caption" in input && input.caption !== undefined ? input.caption : quickCaption;
  return deliver(ctx, world, sender, { type: "photo", uploadId, mimeType, ...(caption === undefined ? {} : { caption }) });
}

async function threadOf(ctx: Ctx, personId: string) {
  return ctx.deps.connector.conversations.listMessages(personId, { limit: 200 });
}

async function tap(ctx: Ctx, input: z.infer<typeof TapInput>) {
  if (input.identity === UNKNOWN_IDENTITY) throw new ToolError("NOT_FOUND", "the unknown number received no buttons");
  ownRow(ctx, await ctx.deps.connector.people.getPerson(input.identity), "identity");
  const message = (await threadOf(ctx, input.identity)).find((candidate) => candidate.messageId === input.messageId && candidate.direction === "OUT");
  const button = buttonsOf(message === undefined ? undefined : payloadOf(message)).find((candidate) => candidate.id === input.buttonId);
  if (button === undefined) throw new ToolError("NOT_FOUND", "no such button");
  const content: SimulatedContent = button.kind === "button" ? { type: "button", payload: button.id, text: button.title } : { type: button.kind, id: button.id, title: button.title };
  return send(ctx, input.identity, content);
}

export async function peopleOfWorld(ctx: Ctx): Promise<Person[]> {
  const data = ctx.deps.connector.people;
  const [installers, supervisors] = await Promise.all([data.listPeople(ctx.world.ispId, "INSTALLER"), data.listPeople(ctx.world.ispId, "SUPERVISOR")]);
  return [...installers, ...supervisors].filter((person) => person.clockId === ctx.world.clockId);
}

/** Taps the latest button with this title the identity was offered (a button only the agent emits, too). */
export async function tapByTitle(ctx: Ctx, identity: string, title: string) {
  const message = (await threadOf(ctx, identity)).reverse().find((candidate) => candidate.direction === "OUT" && buttonsOf(payloadOf(candidate)).some((button) => button.title === title));
  const button = message === undefined ? undefined : buttonsOf(payloadOf(message)).find((candidate) => candidate.title === title);
  if (message === undefined || button === undefined) throw new ToolError("CONFLICT", "the button of this step has not been offered yet", "NO_BUTTON");
  return tap(ctx, { identity, messageId: message.messageId, buttonId: button.id });
}

/** One quick message of the tour, with its physical action on the order's ONU when it has one. */
export async function sendQuick(ctx: Ctx, quickId: string) {
  const quick = quickMessage(quickId);
  const person = personOfParty(await peopleOfWorld(ctx), quick.party);
  if (person === undefined) throw new ToolError("NOT_FOUND", "this world has no such person");
  const identity = person.personId;
  let sent;
  switch (quick.action.type) {
    case "TEXT":
      sent = await send(ctx, identity, { type: "text", body: quick.action.text });
      break;
    case "VOICE":
      sent = await sendVoice(ctx, { identity, voiceId: quick.action.voiceId });
      break;
    case "PHOTO":
      sent = await sendPhoto(ctx, { identity, photoId: quick.action.photoId }, PHOTO_ITEM_BUTTONS[quick.action.item].es);
      break;
    case "TAP":
      sent = await tapByTitle(ctx, identity, quick.action.title);
      break;
  }
  if (quick.physicalAction !== undefined) await physicalAction(ctx, identity, quick.workOrderNumber, quick.physicalAction);
  return { quickId, ...sent };
}

async function physicalAction(ctx: Ctx, installerId: string, workOrderNumber: string, kind: "INSTALLER_STEP"): Promise<void> {
  const today = await worldToday(ctx);
  const order = (await ctx.deps.connector.workOrders.listInstallerDay(installerId, today.day)).find((candidate) => candidate.workOrderNumber === workOrderNumber && candidate.clockId === ctx.world.clockId);
  if (order === undefined) return;
  const outcome = await consoleCall(ctx).ports.network.reportPhysicalAction({ clockId: ctx.world.clockId, serial: order.onuSerial, caller: "CONSOLE", atSim: today.simNow, kind, logger: ctx.log });
  ctx.log.info("simulator.physical_action", { kind, outcome: outcome.kind });
}

async function presign(ctx: Ctx, input: z.infer<typeof PresignInput>) {
  const world = await simWorld(ctx);
  const contentType = baseMimeType(input.contentType);
  if (!ALLOWED_TYPES[input.kind].includes(contentType)) throw new ToolError("INVALID", "this type of file is not accepted", "MEDIA_TYPE");
  const realNow = await world.ports.services.realClock.now();
  const uploadId = `upl-${world.ports.newId(realNow.getTime())}`;
  const key = simMediaKey(ctx.world.clockId, await currentEpoch(ctx), uploadId);
  const maxBytes = MAX_BYTES[input.kind];
  await ctx.deps.connector.worlds.createUpload({ uploadId, userId: ctx.principal.userId, clockId: ctx.world.clockId, key, kind: input.kind, maxBytes });
  const post = await world.ports.objects.presignPost({ key, contentType, maxBytes });
  return { uploadId, url: post.url, fields: post.fields, maxBytes, expiresInSeconds: RUNTIME_TTL_SECONDS.upload };
}

function liveTransport(ctx: Ctx): boolean {
  return consoleCall(ctx).ports.stageTransports().includes("live");
}

async function identities(ctx: Ctx) {
  const settings = await ctx.deps.connector.isps.getSettings(ctx.world.ispId);
  const people = await peopleOfWorld(ctx);
  return {
    simulated: settings?.whatsappMode === "simulated",
    liveTransport: liveTransport(ctx),
    messagesPerRealHourPerIdentity: rateLimitsOf(settings ?? {}).perRealHour,
    identities: [
      ...people.map((person) => ({ identity: person.personId, firstName: person.firstName, lastName: person.lastName, role: person.role, active: person.active })),
      { identity: UNKNOWN_IDENTITY, firstName: null, lastName: null, role: null, active: false },
    ],
  };
}

async function kit(ctx: Ctx) {
  if (!liveTransport(ctx)) return { available: false as const };
  const { ports } = consoleCall(ctx);
  const photos = await Promise.all(KIT.photos.map(async (photoId) => ({ photoId, url: await ports.objects.presignGet({ bucket: "Seed", key: seedKeys.photo(photoId), contentType: "image/jpeg", download: `${photoId}.jpg` }) })));
  const voices = await Promise.all(
    KIT.voices.map(async (voiceId) => ({ voiceId, text: voiceCatalog().find((note) => note.voiceId === voiceId)?.text ?? null, url: await ports.objects.presignGet({ bucket: "Seed", key: seedKeys.voice(voiceId), contentType: "audio/ogg", download: `${voiceId}.ogg` }) })),
  );
  const script = QUICK_MESSAGES.filter((quick) => quick.party === "inst-rogelio" && quick.action.type === "TEXT").map((quick) => ({ quickId: quick.quickId, text: quick.label, glossEn: quick.glossEn }));
  return { available: true as const, photos, voices, script };
}

export const simulatorRouter = router({
  identities: ispProcedure.query(({ ctx }) => identities(ctx)),
  thread: ispProcedure.input(ByIdentity).query(async ({ ctx, input }) => {
    if (input.identity === UNKNOWN_IDENTITY) return { identity: input.identity, bubbles: [] };
    ownRow(ctx, await ctx.deps.connector.people.getPerson(input.identity), "identity");
    const { ports } = consoleCall(ctx);
    return inWorldTime(ctx, { identity: input.identity, bubbles: await Promise.all((await threadOf(ctx, input.identity)).map((message) => bubbleOf(message, ports))) });
  }),
  catalog: ispProcedure.query(async ({ ctx }) => ({
    photos: (await ctx.deps.connector.reference.listEvalPhotos()).map((photo) => ({ photoId: photo.photoId, expectedVerdict: photo.expectedVerdict, expectedReason: photo.expectedReason ?? null })),
    voices: voiceCatalog(),
  })),
  quickMessages: ispProcedure.query(async ({ ctx }) => {
    const people = await peopleOfWorld(ctx);
    return QUICK_MESSAGES.flatMap((quick) => {
      const person = personOfParty(people, quick.party);
      return person === undefined ? [] : [{ quickId: quick.quickId, scene: quick.scene, identity: person.personId, label: quick.label, glossEn: quick.glossEn, type: quick.action.type, physicalAction: quick.physicalAction ?? null }];
    });
  }),
  sendText: ispProcedure.input(TextInput).mutation(({ ctx, input }) => send(ctx, input.identity, { type: "text", body: input.text })),
  tapButton: ispProcedure.input(TapInput).mutation(({ ctx, input }) => tap(ctx, input)),
  sendVoiceNote: ispProcedure.input(VoiceInput).mutation(({ ctx, input }) => sendVoice(ctx, input)),
  sendPhoto: ispProcedure.input(PhotoInput).mutation(({ ctx, input }) => sendPhoto(ctx, input)),
  sendQuick: ispProcedure.input(z.object({ quickId: z.string().min(1).max(64) }).strict()).mutation(({ ctx, input }) => sendQuick(ctx, input.quickId)),
  presignMedia: ispProcedure.input(PresignInput).mutation(({ ctx, input }) => presign(ctx, input)),
  markRead: ispProcedure.input(ByIdentity).mutation(async ({ ctx, input }) => {
    if (input.identity === UNKNOWN_IDENTITY) return { read: 0 };
    ownRow(ctx, await ctx.deps.connector.people.getPerson(input.identity), "identity");
    return { read: await consoleCall(ctx).ports.simulatedTransport().markThreadRead(input.identity) };
  }),
  joinCode: ispProcedure.input(z.object({ personId: PersonId }).strict()).mutation(async ({ ctx, input }) => {
    if (!liveTransport(ctx)) throw new ToolError("FORBIDDEN", "the live channel is not enabled in this stage", "LIVE_TRANSPORT_OFF");
    ownRow(ctx, await ctx.deps.connector.people.getPerson(input.personId), "person");
    const data = ctx.deps.connector;
    const code = await issueJoinCode({ clockId: ctx.world.clockId, personId: input.personId, userId: ctx.principal.userId }, { worlds: data.worlds, people: data.people, audit: data.audit });
    return { code: code.code, message: `ALTA ${code.code}`, expiresInMinutes: RUNTIME_TTL_SECONDS.joinCode / 60 };
  }),
  kit: ispProcedure.query(({ ctx }) => kit(ctx)),
});
