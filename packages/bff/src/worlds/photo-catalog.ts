// The photos the world factory names by id (docs/seed-spec.md §10 and §10.1), as `seed:load` publishes
// them in `Seed/photos/catalog.json` next to the JPEGs (`Seed/photos/<photoId>.jpg`): the 60 of the set,
// the historical renders of 12/10, the seeding renders of the presets and the story's own renders. The
// factory never reads the bytes of a photo to seed it: an evidence row carries the photo's `sha256`,
// which is what `DUPLICATE_EVIDENCE` compares (`GSI4`).
//
// Seeding renders (`ph-seed-<item>-<nn>`): `nn` 01-08 look like a PASS, 09-16 like a REJECT (with the
// reason they show). `RenderAllocator` gives every evidence of one world a render no other evidence of
// that world has (another order, another attempt), so two seeded orders never share bytes, and fails with
// `PRESET_POOL_EXHAUSTED` when a world uses up the 8 renders of an item and aspect.
import { z } from "zod";
import { PhotoId, PhotoItem, RejectReason, ToolError } from "@cuadrilla/shared";
import { Sha256Hex } from "../domain/common";

/** Key of the catalog in the `Seed` bucket. */
export const PHOTO_CATALOG_KEY = "photos/catalog.json";

/** Key of a photo's JPEG in the `Seed` bucket. */
export function seedPhotoKey(photoId: string): string {
  return `photos/${PhotoId.parse(photoId)}.jpg`;
}

export const PhotoGroup = z.enum(["set", "hist", "seed", "story"]);
export type PhotoGroup = z.infer<typeof PhotoGroup>;

export const CatalogPhoto = z
  .object({
    photoId: PhotoId,
    group: PhotoGroup,
    item: PhotoItem.nullable(),
    expectedVerdict: z.enum(["PASS", "REJECT", "UNSURE"]),
    expectedReason: RejectReason.nullable(),
    sha256: Sha256Hex,
    bytes: z.int().min(1),
    readingDbm: z.number().optional(),
    wavelengthNm: z.number().optional(),
  })
  .strict();
export type CatalogPhoto = z.infer<typeof CatalogPhoto>;

export const PhotoCatalog = z.object({ version: z.literal(1), photos: z.array(CatalogPhoto).min(1) }).strict();
export type PhotoCatalog = z.infer<typeof PhotoCatalog>;

/** A photo of the seed's datasheets (`scripts/seed/photos/datasheet.json` and `datasheet-aux.json`). */
const DatasheetPhoto = z.looseObject({
  photoId: PhotoId,
  group: PhotoGroup,
  item: PhotoItem.nullable().optional(),
  expectedVerdict: z.enum(["PASS", "REJECT", "UNSURE"]),
  expectedReason: RejectReason.nullable().optional(),
  sha256: Sha256Hex,
  bytes: z.int().min(1),
  drawn: z.looseObject({ readingDbm: z.number().optional(), wavelengthNm: z.number().optional() }).optional(),
});
const Datasheet = z.looseObject({ photos: z.array(DatasheetPhoto) });

/** The catalog `seed:load` publishes, from the two datasheets of the seed (ids, labels and digests only). */
export function catalogOfDatasheets(...datasheets: readonly unknown[]): PhotoCatalog {
  const photos = datasheets.flatMap((sheet) =>
    Datasheet.parse(sheet).photos.map((photo) =>
      CatalogPhoto.parse({
        photoId: photo.photoId,
        group: photo.group,
        item: photo.item ?? null,
        expectedVerdict: photo.expectedVerdict,
        expectedReason: photo.expectedReason ?? null,
        sha256: photo.sha256,
        bytes: photo.bytes,
        ...(photo.drawn?.readingDbm === undefined ? {} : { readingDbm: photo.drawn.readingDbm }),
        ...(photo.drawn?.wavelengthNm === undefined ? {} : { wavelengthNm: photo.drawn.wavelengthNm }),
      }),
    ),
  );
  return PhotoCatalog.parse({ version: 1, photos: photos.sort((a, b) => (a.photoId < b.photoId ? -1 : a.photoId > b.photoId ? 1 : 0)) });
}

/** Seeding renders per item and aspect (`nn` 01-08 PASS, 09-16 REJECT). */
export const SEED_RENDERS_PER_ASPECT = 8;

export type RenderAspect = "PASS" | "REJECT";

export interface SeedRender {
  readonly photoId: string;
  readonly item: PhotoItem;
  readonly aspect: RenderAspect;
  readonly sha256: string;
  readonly bytes: number;
  readonly reason?: RejectReason;
  readonly readingDbm?: number;
}

const SEED_RENDER = /^ph-seed-([A-Z_]+)-(\d{2})$/;

function renderOf(photo: CatalogPhoto): SeedRender | undefined {
  const match = SEED_RENDER.exec(photo.photoId);
  if (photo.group !== "seed" || match === null || photo.item === null) return undefined;
  const aspect: RenderAspect = Number(match[2]) <= SEED_RENDERS_PER_ASPECT ? "PASS" : "REJECT";
  return {
    photoId: photo.photoId,
    item: photo.item,
    aspect,
    sha256: photo.sha256,
    bytes: photo.bytes,
    ...(photo.expectedReason === null ? {} : { reason: photo.expectedReason }),
    ...(photo.readingDbm === undefined ? {} : { readingDbm: photo.readingDbm }),
  };
}

/** The photos of the catalog by id, and the seeding renders by item and aspect, in `nn` order. */
export class PhotoIndex {
  private readonly byId: ReadonlyMap<string, CatalogPhoto>;
  private readonly renders: ReadonlyMap<string, readonly SeedRender[]>;

  constructor(catalog: PhotoCatalog) {
    this.byId = new Map(catalog.photos.map((photo) => [photo.photoId, photo]));
    const renders = new Map<string, SeedRender[]>();
    for (const photo of [...catalog.photos].sort((a, b) => (a.photoId < b.photoId ? -1 : 1))) {
      const render = renderOf(photo);
      if (render === undefined) continue;
      const key = `${render.item}#${render.aspect}`;
      renders.set(key, [...(renders.get(key) ?? []), render]);
    }
    this.renders = renders;
  }

  photo(photoId: string): CatalogPhoto {
    const photo = this.byId.get(photoId);
    if (photo === undefined) throw new ToolError("NOT_FOUND", `photo ${photoId} is not in the catalog`, "PHOTO_NOT_FOUND");
    return photo;
  }

  /** The sha256 of every photo of the synthetic set (what a later step of a scenario may send). */
  setHashes(): ReadonlySet<string> {
    return new Set([...this.byId.values()].filter((photo) => photo.group === "set").map((photo) => photo.sha256));
  }

  renderPool(item: PhotoItem, aspect: RenderAspect): readonly SeedRender[] {
    return this.renders.get(`${item}#${aspect}`) ?? [];
  }
}

/** Seeding renders of one world: each one at most once, so no two seeded evidences share bytes. */
export class RenderAllocator {
  private readonly used = new Set<string>();

  constructor(private readonly index: PhotoIndex) {}

  /** Marks bytes the world already holds (an evidence seeded earlier in the same call). */
  reserve(sha256: string): void {
    this.used.add(sha256);
  }

  next(item: PhotoItem, aspect: RenderAspect): SeedRender {
    const render = this.index.renderPool(item, aspect).find((candidate) => !this.used.has(candidate.sha256));
    if (render === undefined) throw new ToolError("CAP_REACHED", `the world used every ${aspect} seeding render of ${item}`, "PRESET_POOL_EXHAUSTED");
    this.used.add(render.sha256);
    return render;
  }
}
