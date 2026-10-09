// Preset `checklist` of `world.create` and of the scenes of "Saltar a escena" (docs/tool-catalog.md,
// docs/seed-spec.md §10.1): the state of an order's checklist as the product's repositories write it,
// never by a turn of the model.
//
//   ONU_ONLINE, CUSTOMER_OK   the item in the given status
//   photo items               one `EVID#` + `VAL#` per seeded attempt: `attempts` rejected validations
//                             (REJECT-looking seeding renders, with the reason they show), then the
//                             final one: PASSED with a PASS render (or the set photo of `photoId`),
//                             IN_REVIEW with an UNSURE validation; the item with its attempts, its last
//                             reason and the ids of the validation and evidence that decided it
//
// Every evidence of the world gets bytes no other evidence of the world has (`RenderAllocator`), so no
// seeded evidence makes a later photo of the set a `DUPLICATE_EVIDENCE`, unless a step asks for it with
// an explicit `photoId`. Validations are `source: SEED`; evidence names the photo it stands for, and its
// object exists: `Seed/photos/<photoId>.jpg` is copied to the evidence key before the row is written, so
// the review queue's link, the order's detail and the certificate read it like any other evidence.
import { type ChecklistItem, type PhotoItem, type RejectReason, ToolError, type Verdict } from "@cuadrilla/shared";
import { evidencePhotoKey } from "@cuadrilla/shared/media/keys";
import type { Connector } from "../connector/ports";
import type { ChecklistEntry, WorkOrder } from "../domain/work-orders";
import { ulid } from "../lib/crypto";
import { type PhotoIndex, type RenderAllocator, type RenderAspect, SEED_RENDERS_PER_ASPECT } from "./photo-catalog";
import type { SeedMediaCopier } from "./presets";
import { type ChecklistPreset, isPhotoItem } from "./templates";

export interface ChecklistDeps {
  readonly connector: Pick<Connector, "workOrders">;
  readonly photos: PhotoIndex;
  readonly allocator: RenderAllocator;
  /** Copies the seeded photo to its evidence key; a world factory without it cannot seed photo items. */
  readonly media?: Pick<SeedMediaCopier, "copySeedPhotoToEvidence">;
  /** Real time: the ids of the seeded rows. */
  readonly now: () => Date;
}

export interface SeededPhoto {
  readonly item: PhotoItem;
  readonly evidenceId: string;
  readonly validationId: string;
  readonly photoId: string;
  readonly sha256: string;
  readonly verdict: Verdict;
}

const MINUTE = 60_000;

/** A seeded instant a few minutes before the preset's: attempts come first, in order. */
function before(atSim: string, minutes: number): string {
  return new Date(Date.parse(atSim) - minutes * MINUTE).toISOString();
}

interface Shot {
  readonly photoId: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly verdict: Verdict;
  readonly reason?: RejectReason;
  readonly readingDbm?: number;
}

function shotOf(deps: ChecklistDeps, item: PhotoItem, aspect: RenderAspect, verdict: Verdict): Shot {
  const render = deps.allocator.next(item, aspect);
  return {
    photoId: render.photoId,
    sha256: render.sha256,
    bytes: render.bytes,
    verdict,
    ...(verdict === "REJECT" ? { reason: render.reason ?? "UNREADABLE" } : {}),
    ...(render.readingDbm === undefined ? {} : { readingDbm: render.readingDbm }),
  };
}

/** The set photo an explicit `photoId` names, as the PASS of its item (`SC-04/12..13`, `EV-02`). */
function setShot(deps: ChecklistDeps, item: PhotoItem, photoId: string): Shot {
  const photo = deps.photos.photo(photoId);
  if (photo.item !== null && photo.item !== item) throw new ToolError("INVALID", `${photoId} is a photo of ${photo.item}, not of ${item}`, "PRESET_PHOTO_ITEM");
  deps.allocator.reserve(photo.sha256);
  return { photoId, sha256: photo.sha256, bytes: photo.bytes, verdict: "PASS", ...(photo.readingDbm === undefined ? {} : { readingDbm: photo.readingDbm }) };
}

async function seedShot(deps: ChecklistDeps, order: WorkOrder, item: PhotoItem, shot: Shot, atSim: string): Promise<SeededPhoto> {
  const { workOrders } = deps.connector;
  const nowMs = deps.now().getTime();
  const evidenceId = `ev-${ulid(nowMs)}`;
  const validationId = `val-${ulid(nowMs)}`;
  const s3Key = evidencePhotoKey(order.clockId, order.worldEpoch, order.workOrderId, item, evidenceId);
  if (deps.media === undefined) throw new ToolError("UNAVAILABLE", "this world factory cannot seed evidence photos", "PRESET_UNAVAILABLE");
  await deps.media.copySeedPhotoToEvidence(shot.photoId, s3Key);
  await workOrders.createEvidence({
    evidenceId,
    workOrderId: order.workOrderId,
    clockId: order.clockId,
    worldEpoch: order.worldEpoch,
    item,
    sha256: shot.sha256,
    s3Key,
    mime: "image/jpeg",
    bytes: shot.bytes,
    photoId: shot.photoId,
    receivedAtSim: atSim,
    seeded: true,
  });
  await workOrders.createValidation({
    validationId,
    workOrderId: order.workOrderId,
    clockId: order.clockId,
    item,
    evidenceId,
    sha256: shot.sha256,
    verdict: shot.verdict,
    ...(shot.verdict === "UNSURE" ? {} : { modelVerdict: shot.verdict }),
    ...(shot.reason === undefined ? {} : { reasonCode: shot.reason }),
    readings: shot.readingDbm === undefined ? {} : { readingDbm: shot.readingDbm, wavelengthNm: 1490 },
    checks: [],
    source: "SEED",
    atSim,
    seeded: true,
  });
  return { item, evidenceId, validationId, photoId: shot.photoId, sha256: shot.sha256, verdict: shot.verdict };
}

async function putItem(deps: ChecklistDeps, order: WorkOrder, item: ChecklistItem, fields: Partial<Pick<ChecklistEntry, "attempts" | "lastRejectReason" | "validationId" | "evidenceId">> & { readonly status: ChecklistEntry["status"] }, atSim: string): Promise<void> {
  await deps.connector.workOrders.putChecklistItem({
    workOrderId: order.workOrderId,
    clockId: order.clockId,
    item,
    attempts: fields.attempts ?? 0,
    status: fields.status,
    ...(fields.lastRejectReason === undefined ? {} : { lastRejectReason: fields.lastRejectReason }),
    ...(fields.validationId === undefined ? {} : { validationId: fields.validationId }),
    ...(fields.evidenceId === undefined ? {} : { evidenceId: fields.evidenceId }),
    updatedAtSim: atSim,
    history: [{ field: "status", to: fields.status, atSim, atReal: deps.now().toISOString(), actor: "QA", reason: "preset" }],
    seeded: true,
  });
}

/** Seeds one photo item: its rejected attempts, then its final validation; answers what it wrote. */
async function seedPhotoItem(deps: ChecklistDeps, order: WorkOrder, item: PhotoItem, preset: ChecklistPreset, atSim: string): Promise<SeededPhoto[]> {
  const rejected = preset.status === "REJECTED" ? Math.max(1, preset.attempts ?? 1) : (preset.attempts ?? 0);
  if (rejected > SEED_RENDERS_PER_ASPECT) throw new ToolError("INVALID", `at most ${SEED_RENDERS_PER_ASPECT} seeded attempts per item`, "PRESET_ATTEMPTS");
  if (preset.photoId !== undefined && preset.status !== "PASSED") throw new ToolError("INVALID", "an explicit photoId seeds a PASSED item", "PRESET_PHOTO_STATUS");
  const seeded: SeededPhoto[] = [];
  const steps = rejected + (preset.status === "PASSED" || preset.status === "IN_REVIEW" ? 1 : 0);
  for (let attempt = 0; attempt < rejected; attempt += 1) {
    seeded.push(await seedShot(deps, order, item, shotOf(deps, item, "REJECT", "REJECT"), before(atSim, steps - attempt)));
  }
  if (preset.status === "PASSED") {
    const shot = preset.photoId === undefined ? shotOf(deps, item, "PASS", "PASS") : setShot(deps, item, preset.photoId);
    seeded.push(await seedShot(deps, order, item, shot, before(atSim, 1)));
  } else if (preset.status === "IN_REVIEW") {
    seeded.push(await seedShot(deps, order, item, shotOf(deps, item, "REJECT", "UNSURE"), before(atSim, 1)));
  }
  const last = seeded.at(-1);
  const lastReject = [...seeded].reverse().find((photo) => photo.verdict === "REJECT");
  const lastReason = lastReject === undefined ? undefined : (await deps.connector.workOrders.getValidation(order.workOrderId, lastReject.validationId))?.reasonCode;
  await putItem(
    deps,
    order,
    item,
    {
      status: preset.status,
      attempts: rejected,
      ...(lastReason === undefined ? {} : { lastRejectReason: lastReason }),
      ...(last === undefined ? {} : { validationId: last.validationId, evidenceId: last.evidenceId }),
    },
    atSim,
  );
  return seeded;
}

/** Applies a `checklist` preset to one order; answers the photos it seeded. */
export async function seedChecklist(deps: ChecklistDeps, order: WorkOrder, checklist: Readonly<Partial<Record<ChecklistItem, ChecklistPreset>>>, atSim: string): Promise<SeededPhoto[]> {
  const seeded: SeededPhoto[] = [];
  for (const [item, preset] of Object.entries(checklist) as Array<[ChecklistItem, ChecklistPreset]>) {
    if (isPhotoItem(item)) {
      seeded.push(...(await seedPhotoItem(deps, order, item, preset, atSim)));
      continue;
    }
    if (preset.photoId !== undefined || (preset.attempts ?? 0) > 0) throw new ToolError("INVALID", `${item} has no photos to seed`, "PRESET_NOT_A_PHOTO");
    await putItem(deps, order, item, { status: preset.status }, atSim);
  }
  return seeded;
}
