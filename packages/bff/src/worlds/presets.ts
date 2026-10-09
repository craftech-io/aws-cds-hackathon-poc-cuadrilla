// Presets per operation of `world.create` and of the scenes of "Saltar a escena" (docs/tool-catalog.md,
// docs/architecture.md §8): the state a step of a scenario or of the tour starts from, seeded through
// the same repositories and handlers as the product, never by turns of the model, so a step never depends
// on what the model did before.
//
//   checklist          presets-checklist.ts (seeding renders, or the set photo of an explicit `photoId`)
//   onu                behaviour, received power and whether the physical fix was already done (`Network`)
//   case               the real `open_case` and `advance_ladder` up to the rung, and the take (`PresetEffects`)
//   lastInboundAtSim   the installer's 24 h window
//   activeWorkOrderId  the order the installer works on (`INSTSTATE#`)
//   steps              troubleshooting steps with their outcome
//   offer              a REPLY of the agent with the buttons and real nonces bound to the installer's phone,
//                      the object and the action (FL-094), so a tap resolves like any other
//   candidates         photos the installer sent (inbound messages, no turn)
//   profile            the measured installer profile
//
// Everything seeded is marked `seeded: true`.
import { type ChecklistItem, type PhotoItem, ToolError } from "@cuadrilla/shared";
import { simMediaKey } from "@cuadrilla/shared/media/keys";
import type { CasePresetInput } from "../cases/preset";
import { BUTTON_LABELS } from "../copy/buttons";
import { esMX } from "../copy/es-MX";
import type { Connector } from "../connector/ports";
import type { TableClient } from "../connector/table-client";
import type { Person } from "../domain/people";
import type { WorkOrder } from "../domain/work-orders";
import type { NonceDeps } from "../channels/whatsapp/nonces";
import { storedPayload } from "../channels/whatsapp/transport";
import { sha256Hex, ulid } from "../lib/crypto";
import { renderWhatsApp } from "../outbound/render/whatsapp";
import { WhatsAppSendRequest } from "../outbound/types";
import { candidateIdOf } from "../evidence/candidate";
import { MAIN_STORY } from "../story/main-story";
import type { PhotoIndex, RenderAllocator } from "./photo-catalog";
import { type SeededPhoto, seedChecklist } from "./presets-checklist";
import { type OfferPreset, type OrderPreset, isPhotoItem } from "./templates";

/** What a preset does through handlers that send (the ladder's templates go through the pipeline). */
export interface PresetEffects {
  /**
   * `open_case` and `advance_ladder` with `caller QA` up to `rung`, then the take for `TAKEN`
   * (worlds/preset-effects.ts): the case's id when it ran in process, none when it was queued.
   */
  openCase(input: CasePresetInput & { readonly order: WorkOrder }): Promise<{ readonly caseId?: string }>;
}

/** Copies a photo of `Seed/photos/<photoId>.jpg`, byte for byte, to where a seeded row points at it. */
export interface SeedMediaCopier {
  /** To a key of `Media` (the candidates of a preset). */
  copySeedPhoto(photoId: string, mediaKey: string): Promise<void>;
  /** To an evidence key of `Evidence` (`[guest/<seg>/]photos/…`, the checklist's seeded evidence). */
  copySeedPhotoToEvidence(photoId: string, evidenceKey: string): Promise<void>;
}

export interface PresetDeps {
  readonly connector: Pick<Connector, "workOrders" | "people" | "worlds" | "conversations">;
  /** The mocks' tables (`Network`). */
  readonly client: TableClient;
  readonly photos: PhotoIndex;
  /** Button nonces (`offer`); a world built without them refuses an offer preset. */
  readonly nonces?: NonceDeps;
  readonly effects?: PresetEffects;
  readonly media?: SeedMediaCopier;
  /** Real time: ids of the seeded rows. */
  readonly now: () => Date;
}

export interface PresetTarget {
  readonly order: WorkOrder;
  readonly installer: Person;
  /** The simulated instant the preset stands at (the scene's, or the world's start). */
  readonly atSim: string;
}

export interface AppliedPreset {
  readonly workOrderId: string;
  readonly photos: readonly SeededPhoto[];
  readonly offers: ReadonlyArray<{ readonly action: OfferPreset["action"]; readonly messageId: string; readonly nonces: readonly string[] }>;
  readonly caseId?: string;
  /** The candidate id (`ec_…`, `candidateIdOf`) of each photo, what `validate_install_photo` takes. */
  readonly candidates: readonly string[];
}

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new ToolError("UNAVAILABLE", `this world factory cannot seed ${what}`, "PRESET_UNAVAILABLE");
  return value;
}

/** What this factory cannot seed of a preset, by the port it lacks (the preflight of a scene jump). */
export function missingPresetPorts(deps: Pick<PresetDeps, "effects" | "nonces" | "media">, preset: OrderPreset): string[] {
  const missing: string[] = [];
  if (preset.case !== undefined && deps.effects === undefined) missing.push("cases");
  if (preset.offer !== undefined && deps.nonces === undefined) missing.push("button nonces");
  if ((preset.candidates?.length ?? 0) > 0 && deps.media === undefined) missing.push("candidate photos");
  const photos = Object.entries(preset.checklist ?? {}).some(([item, entry]) => isPhotoItem(item as ChecklistItem) && entry !== undefined && (entry.status !== "PENDING" || (entry.attempts ?? 0) > 0));
  if (photos && deps.media === undefined) missing.push("evidence photos");
  return missing;
}

async function seedOnu(deps: PresetDeps, target: PresetTarget, onu: NonNullable<OrderPreset["onu"]>): Promise<void> {
  const key = { PK: `ONU#${target.order.clockId}#${target.order.onuSerial}`, SK: "META" };
  const row = await deps.client.get("Network", key);
  if (row === undefined) throw new ToolError("NOT_FOUND", `the ONU of ${target.order.workOrderId} has no row`, "PRESET_ONU_MISSING");
  const { fixedBy: _fixedBy, fixedAtSim: _fixedAtSim, ...rest } = row;
  const fixed = onu.fixed ?? row.fixed === true;
  await deps.client.put("Network", {
    ...rest,
    ...(onu.behaviour === undefined ? {} : { behaviour: onu.behaviour }),
    ...(onu.rxDbm === undefined ? {} : { rxPowerDbm: onu.rxDbm }),
    fixed,
    ...(fixed ? { fixedBy: "DEMO_CONTROL", fixedAtSim: target.atSim } : {}),
    updatedAt: deps.now().toISOString(),
    version: (typeof row.version === "number" ? row.version : 1) + 1,
  });
}

async function seedSteps(deps: PresetDeps, target: PresetTarget, steps: NonNullable<OrderPreset["steps"]>): Promise<void> {
  for (const [index, step] of steps.entries()) {
    const recordedAtSim = new Date(Date.parse(target.atSim) - (steps.length - index) * 60_000).toISOString();
    await deps.connector.workOrders.appendStep({ workOrderId: target.order.workOrderId, clockId: target.order.clockId, symptom: step.symptom, stepRef: step.stepRef, outcome: step.outcome, recordedAtSim, seeded: true });
  }
}

/** The text of a seeded offer: the step's question, the story's reply that offers that button, or a fixed text. */
export function offerText(offer: OfferPreset): string {
  if (offer.question !== undefined) return offer.question;
  if (offer.action === "CHOOSE_ITEM") return esMX.itemChoicePrompt;
  const story = MAIN_STORY.find((entry) => entry.kind === "TEXT" && entry.label === "exampleAgentReply" && entry.buttons.includes(offer.action));
  return story?.text ?? BUTTON_LABELS[offer.action].es;
}

const PHOTO_ITEMS: readonly PhotoItem[] = ["POWER_READING_PHOTO", "ONU_LABEL_PHOTO", "ROSETTE_PHOTO"];

async function seedOffer(deps: PresetDeps, target: PresetTarget, offer: OfferPreset): Promise<AppliedPreset["offers"][number]> {
  const nonces = need(deps.nonces, "button nonces");
  const { installer, order } = target;
  if (installer.phone === undefined || installer.phoneHash === undefined) throw new ToolError("INVALID", `${installer.personId} has no phone to bind a button to`, "PRESET_NO_PHONE");
  const items = offer.action === "CHOOSE_ITEM" ? (offer.item === undefined ? PHOTO_ITEMS : [offer.item]) : [];
  const buttons = offer.action === "CHOOSE_ITEM" ? items.map((item) => ({ action: offer.action, item })) : [{ action: offer.action }];
  const messageId = `msg-${ulid(deps.now().getTime())}`;
  const request = WhatsAppSendRequest.parse({ kind: "REPLY", author: "AGENT", channel: "WHATSAPP", personId: installer.personId, eventAtSim: target.atSim, workOrderId: order.workOrderId, messageId, text: offerText(offer), buttons });
  const rendered = await renderWhatsApp(request, { to: installer.phone, personId: installer.personId, phoneHash: installer.phoneHash, clockId: order.clockId, messageId, day: order.date }, nonces);
  await deps.connector.conversations.appendMessage({
    messageId,
    personId: installer.personId,
    ispId: order.ispId,
    clockId: order.clockId,
    direction: "OUT",
    channel: "WHATSAPP",
    content: rendered.content,
    kind: "REPLY",
    workOrderId: order.workOrderId,
    text: request.text,
    ...(rendered.interactive === undefined ? {} : { interactive: rendered.interactive }),
    status: "DELIVERED",
    author: "AGENT",
    simulated: true,
    transport: "simulated",
    providerMessageId: `wamid.SIM.${sha256Hex(`${order.clockId}/${messageId}`).slice(0, 32)}`,
    sentAtSim: target.atSim,
    // The Cloud API JSON a delivered send keeps (transport.ts `recordSent`): the simulator draws its buttons from it.
    refs: { seeded: true, offer: offer.action, whatsapp: storedPayload(rendered.payload) },
    seeded: true,
  });
  const ids = Array.isArray(rendered.interactive?.buttons) ? (rendered.interactive.buttons as Array<{ id?: unknown }>).flatMap((button) => (typeof button.id === "string" ? [button.id] : [])) : [];
  return { action: offer.action, messageId, nonces: ids };
}

async function seedCandidates(deps: PresetDeps, target: PresetTarget, photoIds: readonly string[]): Promise<string[]> {
  const media = need(deps.media, "candidate photos");
  const { installer, order } = target;
  const candidates: string[] = [];
  for (const [index, photoId] of photoIds.entries()) {
    const photo = deps.photos.photo(photoId);
    const messageId = `msg-${ulid(deps.now().getTime())}`;
    const s3Key = simMediaKey(order.clockId, order.worldEpoch, `seed-${messageId.slice(4)}`);
    await media.copySeedPhoto(photoId, s3Key);
    await deps.connector.conversations.appendMessage({
      messageId,
      personId: installer.personId,
      ispId: order.ispId,
      clockId: order.clockId,
      direction: "IN",
      channel: "WHATSAPP",
      content: "IMAGE",
      workOrderId: order.workOrderId,
      media: { kind: "IMAGE", s3Key, sha256: photo.sha256, mime: "image/jpeg", bytes: photo.bytes },
      status: "RECEIVED",
      author: `PERSON:${installer.personId}`,
      simulated: true,
      transport: "simulated",
      providerMessageId: `wamid.SIM.${sha256Hex(`${order.clockId}/${messageId}`).slice(0, 32)}`,
      sentAtSim: new Date(Date.parse(target.atSim) - (photoIds.length - index) * 60_000).toISOString(),
      refs: { seeded: true, photoId },
      seeded: true,
    });
    candidates.push(candidateIdOf(messageId));
  }
  return candidates;
}

/** Applies every preset of one operation, in the order of the header. */
export async function applyOrderPreset(deps: PresetDeps, allocator: RenderAllocator, target: PresetTarget, preset: OrderPreset): Promise<AppliedPreset> {
  const { order, installer, atSim } = target;
  const photos = preset.checklist === undefined ? [] : await seedChecklist({ connector: deps.connector, photos: deps.photos, allocator, now: deps.now, ...(deps.media === undefined ? {} : { media: deps.media }) }, order, preset.checklist, atSim);
  if (preset.onu !== undefined) await seedOnu(deps, target, preset.onu);
  if (preset.steps !== undefined) await seedSteps(deps, target, preset.steps);
  const caseId = preset.case === undefined ? undefined : (await need(deps.effects, "cases").openCase({ order, workOrderId: order.workOrderId, ...preset.case, atSim })).caseId;
  if (preset.lastInboundAtSim !== undefined) await deps.connector.people.recordInbound(installer.personId, { atSim: preset.lastInboundAtSim });
  if (preset.activeWorkOrderId === true) await deps.connector.worlds.setActiveWorkOrder(installer.personId, order.clockId, order.workOrderId, atSim);
  const offers = [];
  for (const offer of preset.offer === undefined ? [] : Array.isArray(preset.offer) ? preset.offer : [preset.offer]) offers.push(await seedOffer(deps, target, offer));
  const candidates = preset.candidates === undefined ? [] : await seedCandidates(deps, target, preset.candidates);
  if (preset.profile !== undefined) {
    const current = await deps.connector.people.getProfile(installer.personId);
    await deps.connector.people.putProfile({ installerId: installer.personId, clockId: order.clockId, rejects: preset.profile.rejects, stepsBySymptom: current?.stepsBySymptom ?? {}, casesByReason: current?.casesByReason ?? {}, events: current?.events ?? [], seeded: true });
  }
  return { workOrderId: order.workOrderId, photos, offers, ...(caseId === undefined ? {} : { caseId }), candidates };
}
