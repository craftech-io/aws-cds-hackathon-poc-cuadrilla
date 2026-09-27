// The committed synthetic photos against their datasheets (docs/seed-spec.md §10, §10.1, §14
// invariants 8, 21, 22, 23, 24): labels, files, bytes, values, scripted validator output and the
// certificate sample. A byte-identical re-render is only expected in the pinned container image; the
// render check here compares decoded pixels with a tolerance and runs with PHOTOS_RENDER_CHECK=1
// (optionally PHOTOS_CHROMIUM_EXECUTABLE=<path> when Playwright's pinned Chromium is not installed).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OnuSerial, RejectReason, isSetPhotoId, seedPhotoId } from "@cuadrilla/shared";
import { describe, expect, it } from "vitest";
import { DEFAULT_OPERATOR_NAME } from "../../../packages/bff/src/copy/brand";
import { findTerms, listFromEnv } from "../../lint/forbidden-terms";
import { actaSamplePdf } from "../photos/acta-sample";
import { openRenderer } from "../photos/browser";
import { DEMO_ORDERS, FOREIGN_SERIAL } from "../photos/catalog-set";
import { missingGlyphs } from "../photos/glyphs";
import { jpegInfo } from "../photos/jpeg";
import { sha256Hex } from "../photos/prng";
import { AUX_DATASHEET_FILE, DATASHEET_FILE, PIXEL_TOLERANCE, SCRIPTED_FILE, allPhotoSpecs, byteCollisions } from "../photos/render";
import { AuxDatasheet, Datasheet, PHOTO_FORMAT, type PhotoEntry, ScriptedVerdicts } from "../photos/schema";
import { scriptedVerdicts } from "../photos/scripted";
import { allPhotoTexts } from "../photos/texts";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path));
const json = (path: string): unknown => JSON.parse(read(path).toString("utf8"));

const datasheet = Datasheet.parse(json(DATASHEET_FILE));
const aux = AuxDatasheet.parse(json(AUX_DATASHEET_FILE));
const scripted = ScriptedVerdicts.parse(json(SCRIPTED_FILE));
const everyPhoto: readonly PhotoEntry[] = [...datasheet.photos, ...aux.photos];
const byId = new Map(everyPhoto.map((photo) => [photo.photoId, photo]));

function photo(photoId: string): PhotoEntry {
  const found = byId.get(photoId);
  if (found === undefined) throw new Error(`no photo ${photoId}`);
  return found;
}

// docs/seed-spec.md §10, restated: id → expected reason (`null` = PASS).
const PASS = null;
const EXPECTED: Readonly<Record<string, RejectReason | null>> = {
  ...Object.fromEntries(["01", "02", "03", "04", "18", "19", "20"].map((n) => [`ph-meter-${n}`, PASS])),
  "ph-meter-05": "READING_MISMATCH",
  ...Object.fromEntries(["06", "07", "08"].map((n) => [`ph-meter-${n}`, "OUT_OF_RANGE_LOW" as const])),
  ...Object.fromEntries(["09", "10"].map((n) => [`ph-meter-${n}`, "OUT_OF_RANGE_HIGH" as const])),
  "ph-meter-11": "BLURRY",
  "ph-meter-12": "GLARE",
  "ph-meter-13": "CROPPED",
  "ph-meter-14": "DARK",
  "ph-meter-15": "UNREADABLE",
  "ph-meter-16": "WRONG_WAVELENGTH",
  "ph-meter-17": "WRONG_WAVELENGTH",
  "ph-meter-21": "WRONG_SUBJECT",
  "ph-meter-22": "WRONG_SUBJECT",
  ...Object.fromEntries(["01", "02", "03", "07", "13", "16"].map((n) => [`ph-label-${n}`, PASS])),
  ...{ "ph-label-04": "BLURRY", "ph-label-05": "BLURRY", "ph-label-06": "GLARE", "ph-label-08": "CROPPED", "ph-label-10": "DARK" },
  ...{ "ph-label-14": "UNREADABLE", "ph-label-15": "UNREADABLE", "ph-label-17": "BLURRY", "ph-label-09": "SERIAL_MISMATCH", "ph-label-12": "SERIAL_MISMATCH" },
  ...{ "ph-label-11": "WRONG_SUBJECT", "ph-label-18": "WRONG_SUBJECT" },
  ...Object.fromEntries(["01", "02", "03", "07", "11", "12", "14", "16"].map((n) => [`ph-rosette-${n}`, PASS])),
  ...{ "ph-rosette-04": "BLURRY", "ph-rosette-05": "DARK", "ph-rosette-06": "CROPPED", "ph-rosette-08": "GLARE", "ph-rosette-13": "UNREADABLE", "ph-rosette-15": "BLURRY" },
  ...{ "ph-rosette-09": "WRONG_SUBJECT", "ph-rosette-10": "WRONG_SUBJECT" },
  ...{ "ph-adv-01": "SERIAL_MISMATCH", "ph-adv-02": "OUT_OF_RANGE_LOW", "ph-adv-03": "WRONG_SUBJECT", "ph-adv-04": "DUPLICATE_EVIDENCE" },
};

const RANGE = { "B+": { min: -25, max: -8 }, "C+": { min: -28, max: -8 } } as const;
const inRange = (entry: PhotoEntry, dbm: number) => dbm >= RANGE[entry.opticalClass].min && dbm <= RANGE[entry.opticalClass].max;

describe("photo set: labels of docs/seed-spec.md §10", () => {
  it("has 60 photos: 22 meter, 18 label, 16 rosette, 4 adversarial; 21 PASS and 39 to reject", () => {
    const ids = datasheet.photos.map((p) => p.photoId);
    expect(ids).toHaveLength(60);
    expect(new Set(ids).size).toBe(60);
    expect(ids.every(isSetPhotoId)).toBe(true);
    const count = (prefix: string) => ids.filter((id) => id.startsWith(prefix)).length;
    expect([count("ph-meter-"), count("ph-label-"), count("ph-rosette-"), count("ph-adv-")]).toEqual([22, 18, 16, 4]);
    expect(datasheet.photos.filter((p) => p.expectedVerdict === "PASS")).toHaveLength(21);
    expect(datasheet.photos.filter((p) => p.expectedVerdict === "REJECT")).toHaveLength(39);
  });

  it.each(Object.entries(EXPECTED))("[FL-036] [FL-037] [FL-038] [FL-039] [FL-041] %s is labelled %s", (photoId, reason) => {
    const entry = photo(photoId);
    expect(entry.expectedVerdict).toBe(reason === null ? "PASS" : "REJECT");
    expect(entry.expectedReason).toBe(reason);
    expect(entry.acceptsUnsure).toBe(reason === "UNREADABLE");
    if (reason !== null) expect(RejectReason.options).toContain(reason);
  });

  it("ph-label-17 also accepts GLARE; every other photo has a single right reason", () => {
    expect(photo("ph-label-17").acceptedReasons).toEqual(["GLARE"]);
    expect(datasheet.photos.filter((p) => p.acceptedReasons.length > 0).map((p) => p.photoId)).toEqual(["ph-label-17"]);
  });

  it("matches the catalogs: a changed spec without a new render fails here", () => {
    const specs = new Map(allPhotoSpecs().map((spec) => [spec.photoId, spec]));
    expect(specs.size).toBe(everyPhoto.length);
    for (const entry of everyPhoto) {
      const { file: _file, sha256: _sha, bytes: _bytes, width: _w, height: _h, framing: _framing, origin: _origin, ...spec } = entry;
      expect(spec, entry.photoId).toEqual(specs.get(entry.photoId));
    }
  });
});

describe("photo files (invariant 8)", () => {
  it.each(everyPhoto.map((p) => [p.photoId, p] as const))("%s: JPEG 1280x960, at most 400 KB, no EXIF, sha256 of the datasheet", (_id, entry) => {
    expect(existsSync(join(ROOT, entry.file))).toBe(true);
    const bytes = read(entry.file);
    const info = jpegInfo(bytes);
    expect([info.width, info.height]).toEqual([PHOTO_FORMAT.width, PHOTO_FORMAT.height]);
    expect(info.exifOrCommentSegments).toBe(0);
    expect(bytes.length).toBe(entry.bytes);
    expect(bytes.length).toBeLessThanOrEqual(PHOTO_FORMAT.maxBytes);
    expect(sha256Hex(bytes)).toBe(entry.sha256);
    expect(entry.origin).toBe("generated by scripts/seed/photos/render.ts, seed 20260926");
  });
});

describe("drawn values against the order (invariants 8 and 22)", () => {
  const meters = datasheet.photos.filter((p) => p.drawn.template === "meter" && p.item === "POWER_READING_PHOTO");

  it("[FL-036] [FL-037] a PASS reading is in range for its class; an out-of-range one is not", () => {
    for (const entry of meters) {
      if (entry.drawn.template !== "meter") continue;
      const reading = entry.drawn.readingDbm;
      if (entry.expectedReason === "OUT_OF_RANGE_LOW") expect(reading, entry.photoId).toBeLessThan(RANGE[entry.opticalClass].min);
      else if (entry.expectedReason === "OUT_OF_RANGE_HIGH") expect(reading, entry.photoId).toBeGreaterThan(RANGE[entry.opticalClass].max);
      else expect(inRange(entry, reading), entry.photoId).toBe(true);
    }
    expect(photo("ph-meter-04").opticalClass).toBe("C+");
    const meter04 = photo("ph-meter-04").drawn;
    expect(meter04.template === "meter" && meter04.readingDbm < RANGE["B+"].min).toBe(true);
  });

  it("[FL-041] the orchestrator's reading is within 3 dB of the meter except on ph-meter-05", () => {
    for (const entry of meters) {
      if (entry.drawn.template !== "meter") continue;
      const gap = Math.abs(entry.drawn.readingDbm - entry.orchestratorRxDbm);
      if (entry.expectedReason === "READING_MISMATCH") expect(gap, entry.photoId).toBeGreaterThan(3);
      else expect(gap, entry.photoId).toBeLessThanOrEqual(3);
    }
    expect(photo("ph-meter-05").orchestratorRxDbm).toBe(-21.4);
    expect(everyPhoto.every((p) => Number.isFinite(p.orchestratorRxDbm) && p.operState === "ONLINE")).toBe(true);
  });

  it("[FL-036] every meter reads at 1490 nm except the two wrong-wavelength photos", () => {
    for (const entry of meters) {
      if (entry.drawn.template !== "meter") continue;
      expect(entry.drawn.wavelengthNm, entry.photoId).toBe(entry.expectedReason === "WRONG_WAVELENGTH" ? (entry.photoId === "ph-meter-16" ? 1310 : 1550) : 1490);
    }
    const main = photo("ph-meter-01");
    expect(main.drawn).toEqual({ template: "meter", readingDbm: -21.4, wavelengthNm: 1490 });
    expect(main.workOrderId).toBe("wo-24817");
  });

  it("[FL-040] [FL-041] a PASS label shows the order's serial; a SERIAL_MISMATCH one shows a serial of no order", () => {
    const orderSerials = new Set(Object.values(DEMO_ORDERS).map((order) => order.serial));
    for (const entry of datasheet.photos) {
      if (entry.drawn.template !== "label") continue;
      expect(OnuSerial.safeParse(entry.drawn.serial).success).toBe(true);
      if (entry.expectedReason === "SERIAL_MISMATCH") {
        expect(entry.drawn.serial, entry.photoId).not.toBe(entry.orderSerial);
        expect(orderSerials.has(entry.drawn.serial), entry.photoId).toBe(false);
      } else {
        expect(entry.drawn.serial, entry.photoId).toBe(entry.orderSerial);
      }
    }
    expect(photo("ph-label-01").orderSerial).toBe("DEMO3F2C19A0");
    expect(photo("ph-label-09")).toMatchObject({ workOrderId: "wo-24821", orderSerial: "DEMO3F2C2D15", drawn: { serial: "DEMO3F2C9999" } });
    expect(photo("ph-label-12").drawn).toMatchObject({ serial: "DEMO3F2C19A8" });
    expect(photo("ph-adv-01").drawn).toMatchObject({ serial: FOREIGN_SERIAL });
  });
});

describe("bytes across the set and the auxiliary renders (invariants 21 and 23)", () => {
  it("[FL-041] ph-adv-04 has the bytes of ph-meter-01 and needs that photo as an earlier PASS evidence", () => {
    const duplicate = photo("ph-adv-04");
    expect(duplicate.sha256).toBe(photo("ph-meter-01").sha256);
    expect(duplicate).toMatchObject({ sameBytesAs: "ph-meter-01", precondition: { seededPassEvidenceOf: "ph-meter-01" }, framing: null });
  });

  it("no other file repeats the bytes of another, in the set or outside it", () => {
    expect(byteCollisions(everyPhoto)).toEqual([]);
    const setHashes = new Set(datasheet.photos.map((p) => p.sha256));
    expect(aux.photos.filter((p) => setHashes.has(p.sha256))).toEqual([]);
  });

  it("has the main story's own render: the label of wo-24817 with glare over its serial, the same label as ph-label-01", () => {
    const story = aux.photos.filter((p) => p.group === "story");
    expect(story.map((p) => p.photoId)).toEqual(["ph-story-01"]);
    const [glare] = story;
    expect(glare).toMatchObject({ item: "ONU_LABEL_PHOTO", workOrderId: "wo-24817", expectedVerdict: "REJECT", expectedReason: "GLARE", degradations: [{ kind: "glare", target: "serial" }] });
    expect(glare?.drawn).toEqual(datasheet.photos.find((p) => p.photoId === "ph-label-01")?.drawn);
  });

  it("has 40 historical renders of wo-24801..24812 and 48 seeding renders with PASS and REJECT looks", () => {
    const hist = aux.photos.filter((p) => p.group === "hist");
    expect(hist.map((p) => p.photoId)).toEqual(Array.from({ length: 40 }, (_, i) => `ph-hist-${String(i + 1).padStart(2, "0")}`));
    expect(new Set(hist.map((p) => p.workOrderId))).toEqual(new Set(Array.from({ length: 12 }, (_, i) => `wo-248${String(i + 1).padStart(2, "0")}`)));
    expect(hist.slice(0, 36).filter((p) => p.expectedVerdict !== "PASS").map((p) => p.workOrderId)).toEqual(["wo-24805", "wo-24805"]);
    expect(hist.slice(36).map((p) => p.expectedReason)).toEqual(["GLARE", "GLARE", "BLURRY", "CROPPED"]);
    const seeds = aux.photos.filter((p) => p.group === "seed");
    const ids = (["POWER_READING_PHOTO", "ONU_LABEL_PHOTO", "ROSETTE_PHOTO"] as const).flatMap((item) => Array.from({ length: 16 }, (_, i) => seedPhotoId(item, i + 1)));
    expect(seeds.map((p) => p.photoId)).toEqual(ids);
    for (const seed of seeds) {
      const nn = Number(seed.photoId.slice(-2));
      expect(seed.expectedVerdict, seed.photoId).toBe(nn <= 8 ? "PASS" : "REJECT");
      expect(seed.workOrderId).toBeNull();
      if (seed.drawn.template === "meter") expect(inRange({ ...seed, opticalClass: "B+" }, seed.drawn.readingDbm) && inRange({ ...seed, opticalClass: "C+" }, seed.drawn.readingDbm)).toBe(true);
    }
  });
});

describe("scripted validator output (labelled scripted)", () => {
  it("is the one the generator derives from the catalogs, one per photo of the set", () => {
    expect(scripted).toEqual(ScriptedVerdicts.parse(scriptedVerdicts(allPhotoSpecs())));
    expect(scripted.label).toBe("scripted");
    expect(scripted.verdicts.map((v) => v.photoId)).toEqual(datasheet.photos.map((p) => p.photoId));
  });

  it.each(scripted.verdicts.map((v) => [v.photoId, v] as const))("[FL-043] [FL-097] %s: final verdict within the label", (photoId, verdict) => {
    const entry = photo(photoId);
    expect(verdict.item).toBe(entry.item);
    const right = verdict.finalVerdict === entry.expectedVerdict || (entry.acceptsUnsure && verdict.finalVerdict === "UNSURE");
    expect(right).toBe(true);
    if (verdict.finalVerdict === "REJECT") expect([entry.expectedReason, ...entry.acceptedReasons]).toContain(verdict.finalReason);
    // A model PASS turned into a REJECT always names the deterministic check that did it (ADR-0015).
    if (verdict.recordVerdict.modelVerdict === "PASS" && verdict.finalVerdict !== "PASS") expect(verdict.checks.length).toBe(1);
    if (verdict.recordVerdict.modelVerdict === "PASS" && entry.drawn.template === "meter") expect(verdict.recordVerdict.readingDbm).toBe(entry.drawn.readingDbm);
    if (verdict.recordVerdict.modelVerdict === "PASS" && entry.drawn.template === "label") expect(verdict.recordVerdict.serial).toBe(entry.drawn.serial);
  });

  it("[FL-043] ph-meter-15 goes to human review by low confidence; ph-adv-04 never reaches the model", () => {
    const occluded = scripted.verdicts.find((v) => v.photoId === "ph-meter-15");
    expect(occluded).toMatchObject({ finalVerdict: "UNSURE", checks: ["VAL-CONFIDENCE"] });
    expect(occluded?.recordVerdict.confidence).toBeLessThan(0.6);
    expect(scripted.verdicts.find((v) => v.photoId === "ph-adv-04")).toMatchObject({ modelCalled: false, finalReason: "DUPLICATE_EVIDENCE", checks: ["VAL-DUPLICATE"] });
  });
});

describe("texts and the certificate sample (invariants 11 and 24)", () => {
  const sources = ["texts.ts", "catalog-set.ts", "catalog-aux.ts", "scenes/meter.ts", "scenes/label.ts", "scenes/props.ts"].map((file) => `scripts/seed/photos/${file}`);

  it("draws every text with the stroke font and never names the operator", () => {
    for (const text of allPhotoTexts()) expect(missingGlyphs(text), text).toEqual([]);
    for (const file of sources) expect(read(file).toString("utf8").includes(DEFAULT_OPERATOR_NAME), file).toBe(false);
  });

  it.runIf(listFromEnv(process.env).ok)("has no term of the external FORBIDDEN_TERMS list in the photo texts", () => {
    const list = listFromEnv(process.env);
    if (!list.ok) return;
    for (const file of sources) expect(findTerms(file, read(file).toString("utf8"), list.terms)).toEqual([]);
    expect(findTerms("allPhotoTexts", allPhotoTexts().join("\n"), list.terms)).toEqual([]);
  });

  it("acta-muestra.pdf is the generator's output, synthetic, dated nowhere and without an operator", async () => {
    const [document] = aux.documents;
    expect(document).toMatchObject({ documentId: "acta-muestra", seedKey: "templates/acta-muestra.pdf", mime: "application/pdf" });
    const bytes = read(document?.file ?? "");
    expect(bytes.equals(actaSamplePdf())).toBe(true);
    expect(sha256Hex(bytes)).toBe(document?.sha256);
    const { extractText, getDocumentProxy, getMeta } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(pdf, { mergePages: true });
    const meta = await getMeta(pdf);
    expect(text).toContain("MUESTRA");
    expect(text).toContain("Documento sintético · datos ficticios");
    expect(text.includes(DEFAULT_OPERATOR_NAME)).toBe(false);
    expect(meta.info).not.toHaveProperty("CreationDate");
    expect(meta.info).not.toHaveProperty("ModDate");
  });
});

describe("render check by pixels", () => {
  it.runIf(process.env.PHOTOS_RENDER_CHECK === "1")(
    "a fresh render of four photos matches the committed files within the tolerance",
    async () => {
      const renderer = await openRenderer(process.env.PHOTOS_CHROMIUM_EXECUTABLE);
      try {
        const specs = allPhotoSpecs().filter((spec) => ["ph-meter-01", "ph-label-01", "ph-rosette-02", "ph-label-06"].includes(spec.photoId));
        for (const spec of specs) {
          const { bytes } = await renderer.render(spec);
          const diff = await renderer.compare(bytes, read(photo(spec.photoId).file));
          expect(diff.meanAbs, spec.photoId).toBeLessThanOrEqual(PIXEL_TOLERANCE.meanAbs);
          expect(diff.farShare, spec.photoId).toBeLessThanOrEqual(PIXEL_TOLERANCE.farShare);
        }
      } finally {
        await renderer.close();
      }
    },
    60_000,
  );
});
