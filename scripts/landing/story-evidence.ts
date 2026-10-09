// The evidence of the main story in a capture world (docs/landing-spec.md §6.2): each photo Rogelio sends
// in the story (the set photo the entry names) kept as evidence with the validator's verdict and reason,
// and the checklist item as that verdict leaves it — written by the same repository calls the checklist
// preset of the world factory uses (worlds/presets-checklist.ts), so the evidence review, the order's
// timeline and the certificate read them like any other evidence. An item the scene's preset already
// validated keeps what the scene seeded.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PhotoItem } from "@cuadrilla/shared";
import { evidencePhotoKey } from "../../packages/shared/src/media/keys";
import { ulid } from "../../packages/bff/src/lib/crypto";
import type { StoryEntry } from "../../packages/bff/src/story/types";
import { PHOTO_INDEX } from "../../packages/bff/src/worlds/testing";
import type { MailWorld } from "./story-mail";
import { storyIds } from "./story-thread";

const ROOT = join(import.meta.dirname, "../..");
const STATUS = { PASS: "PASSED", REJECT: "REJECTED", UNSURE: "IN_REVIEW" } as const;

type PhotoEntry = Extract<StoryEntry, { kind: "PHOTO" }>;

/** Writes the evidence of the story's photos in `entries`; answers the items it set. */
export async function seedStoryEvidence(world: MailWorld, entries: readonly StoryEntry[]): Promise<PhotoItem[]> {
  const photos = entries.filter((entry): entry is PhotoEntry => entry.kind === "PHOTO");
  const ids = storyIds(world.ispId);
  const { workOrders } = world.connector;
  const set: PhotoItem[] = [];
  const attempts = new Map<PhotoItem, number>();
  const reasons = new Map<PhotoItem, NonNullable<PhotoEntry["reason"]>>();
  for (const entry of photos) {
    if (entry.photoId === null) throw new Error(`${entry.id}: a photo of the story without its photo of the set`);
    const order = await workOrders.requireWorkOrder(ids.order(entry.workOrderNumber));
    const current = await workOrders.getChecklistItem(order.workOrderId, entry.item);
    if (current?.status === "PASSED" && !set.includes(entry.item)) continue;
    const photo = PHOTO_INDEX.photo(entry.photoId);
    const nowMs = world.now().getTime();
    const evidenceId = `ev-${ulid(nowMs)}`;
    const validationId = `val-${ulid(nowMs)}`;
    const s3Key = evidencePhotoKey(order.clockId, order.worldEpoch, order.workOrderId, entry.item, evidenceId);
    world.objects.put("Evidence", s3Key, new Uint8Array(readFileSync(join(ROOT, `scripts/seed/photos/out/${entry.photoId}.jpg`))), "image/jpeg");
    await workOrders.createEvidence({
      evidenceId,
      workOrderId: order.workOrderId,
      clockId: order.clockId,
      worldEpoch: order.worldEpoch,
      item: entry.item,
      sha256: photo.sha256,
      s3Key,
      mime: "image/jpeg",
      bytes: photo.bytes,
      photoId: entry.photoId,
      receivedAtSim: entry.atSim,
      seeded: true,
    });
    await workOrders.createValidation({
      validationId,
      workOrderId: order.workOrderId,
      clockId: order.clockId,
      item: entry.item,
      evidenceId,
      sha256: photo.sha256,
      verdict: entry.verdict,
      ...(entry.verdict === "UNSURE" ? {} : { modelVerdict: entry.verdict }),
      ...(entry.reason === null ? {} : { reasonCode: entry.reason }),
      readings: photo.readingDbm === undefined ? {} : { readingDbm: photo.readingDbm, wavelengthNm: 1490 },
      checks: [],
      source: "SEED",
      atSim: entry.atSim,
      seeded: true,
    });
    const rejected = (attempts.get(entry.item) ?? 0) + (entry.verdict === "REJECT" ? 1 : 0);
    attempts.set(entry.item, rejected);
    if (entry.reason !== null) reasons.set(entry.item, entry.reason);
    const lastReason = reasons.get(entry.item);
    await workOrders.putChecklistItem({
      workOrderId: order.workOrderId,
      clockId: order.clockId,
      item: entry.item,
      attempts: rejected,
      status: STATUS[entry.verdict],
      ...(lastReason === undefined ? {} : { lastRejectReason: lastReason }),
      validationId,
      evidenceId,
      updatedAtSim: entry.atSim,
      history: [{ field: "status", to: STATUS[entry.verdict], atSim: entry.atSim, atReal: world.now().toISOString(), actor: "QA", reason: "preset" }],
      seeded: true,
    });
    if (!set.includes(entry.item)) set.push(entry.item);
  }
  return set;
}
