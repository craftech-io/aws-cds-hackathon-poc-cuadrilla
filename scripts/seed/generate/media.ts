// The media of WP-18 as the generator reads them (docs/seed-spec.md §10-§11): the datasheet of the 60
// photos of the set (`EVAL#PHOTOS`, `eval/photos.json`), the historical renders of 12/10 (the
// evidence of the closed orders) and the voice notes. The generator never renders or synthesizes:
// it only reads the committed datasheets through their own schemas.
import { readFileSync } from "node:fs";
import type { PhotoItem } from "@cuadrilla/shared";
import { AudioDatasheet } from "../audio/schema";
import { AuxDatasheet, Datasheet, type PhotoEntry } from "../photos/schema";
import { MEDIA_FILES, fromRoot } from "../lib/paths";

export interface Media {
  readonly set: readonly PhotoEntry[];
  readonly aux: AuxDatasheet;
  readonly audio: AudioDatasheet;
}

export function readMedia(): Media {
  const json = (path: string): unknown => JSON.parse(readFileSync(fromRoot(path), "utf8"));
  return {
    set: Datasheet.parse(json(MEDIA_FILES.photoDatasheet)).photos,
    aux: AuxDatasheet.parse(json(MEDIA_FILES.auxDatasheet)),
    audio: AudioDatasheet.parse(json(MEDIA_FILES.audioDatasheet)),
  };
}

/** The renders of 12/10 of one closed order, in the order they were taken. */
export interface OrderHistoryPhotos {
  /** The photo that validated each item (PASS, or UNSURE then validated by hand). */
  readonly accepted: ReadonlyMap<PhotoItem, PhotoEntry>;
  /** Attempts the validator rejected before, per item. */
  readonly rejected: ReadonlyMap<PhotoItem, readonly PhotoEntry[]>;
}

/** Historical renders grouped by the number of their order (`wo-24801` → `24801`). */
export function historyPhotosByOrder(media: Media): Map<string, OrderHistoryPhotos> {
  const byOrder = new Map<string, { accepted: Map<PhotoItem, PhotoEntry>; rejected: Map<PhotoItem, PhotoEntry[]> }>();
  for (const photo of media.aux.photos) {
    if (photo.group !== "hist" || photo.workOrderId === null) continue;
    const number = photo.workOrderId.slice("wo-".length);
    const entry = byOrder.get(number) ?? { accepted: new Map(), rejected: new Map() };
    if (photo.expectedVerdict === "REJECT") entry.rejected.set(photo.item, [...(entry.rejected.get(photo.item) ?? []), photo]);
    else entry.accepted.set(photo.item, photo);
    byOrder.set(number, entry);
  }
  return byOrder;
}

/** Received power of each closed order: what the orchestrator reported for its accepted meter photo. */
export function historyReadings(media: Media): Map<string, number> {
  const readings = new Map<string, number>();
  for (const [number, photos] of historyPhotosByOrder(media)) {
    const meter = photos.accepted.get("POWER_READING_PHOTO");
    if (meter !== undefined) readings.set(number, meter.orchestratorRxDbm);
  }
  return readings;
}
