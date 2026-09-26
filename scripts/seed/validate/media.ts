// Invariants of the synthetic media of WP-18 (docs/seed-spec.md §14): 8 the 60 photos of the set and
// their labels; 9 the 12 voice notes; 21 no historical render with the bytes of a photo of the set;
// 22 the orchestrator's reading of every meter photo, coherent with its label; 23 every seeding
// render unique against the set, the history and each other.
import { existsSync, readFileSync } from "node:fs";
import { ZONES } from "../generate/catalog";
import { fromRoot } from "../lib/paths";
import type { PhotoEntry } from "../photos/schema";
import { sha256Hex } from "../photos/prng";
import type { SeedBundle } from "./bundle";
import { duplicates, finding, type Invariant } from "./types";

const SET_SIZE = 60;
const SET_PASS = 21;
const VOICE_NOTES = 12;
const LONG_NOTE = "vn-10";
/** A PASS meter photo is read within ±3 dB of the orchestrator (`VAL-CROSSCHECK`). */
const CROSSCHECK_DB = 3;

function rangeOf(photo: PhotoEntry): { minDbm: number; maxDbm: number } {
  const zone = ZONES.find((candidate) => candidate.opticalClass === photo.opticalClass);
  if (zone === undefined) throw new RangeError(`no zone of class ${photo.opticalClass}`);
  return zone.acceptanceRange;
}

function fileMatches(path: string, sha256: string): boolean {
  const full = fromRoot(path);
  return existsSync(full) && sha256Hex(readFileSync(full)) === sha256;
}

function photoSet(bundle: SeedBundle): string[] {
  const errors: string[] = [];
  const set = bundle.media.set;
  if (set.length !== SET_SIZE) errors.push(`the set has ${set.length} photos, not ${SET_SIZE}`);
  const passes = set.filter((photo) => photo.expectedVerdict === "PASS").length;
  if (passes !== SET_PASS) errors.push(`the set has ${passes} PASS photos, not ${SET_PASS}`);
  for (const photo of set) {
    if (!fileMatches(photo.file, photo.sha256)) errors.push(`${photo.photoId}: ${photo.file} is missing or differs from the datasheet's sha256`);
    if (photo.drawn.template !== "meter") continue;
    const { minDbm, maxDbm } = rangeOf(photo);
    const value = photo.drawn.readingDbm;
    const inRange = value >= minDbm && value <= maxDbm;
    if (photo.expectedVerdict === "PASS" && !inRange) errors.push(`${photo.photoId}: PASS with ${value} dBm outside ${photo.opticalClass}`);
    if (photo.expectedReason === "OUT_OF_RANGE_LOW" && value >= minDbm) errors.push(`${photo.photoId}: OUT_OF_RANGE_LOW with ${value} dBm`);
    if (photo.expectedReason === "OUT_OF_RANGE_HIGH" && value <= maxDbm) errors.push(`${photo.photoId}: OUT_OF_RANGE_HIGH with ${value} dBm`);
  }
  return errors;
}

function voiceNotes(bundle: SeedBundle): string[] {
  const errors: string[] = [];
  const notes = bundle.media.audio.notes;
  if (notes.length !== VOICE_NOTES) errors.push(`${notes.length} voice notes, not ${VOICE_NOTES}`);
  for (const note of notes) {
    const full = fromRoot(note.file);
    if (!existsSync(full)) {
      errors.push(`${note.voiceId}: ${note.file} is missing`);
      continue;
    }
    const bytes = readFileSync(full);
    if (bytes.subarray(0, 4).toString("latin1") !== "OggS") errors.push(`${note.voiceId}: not an Ogg file`);
    if (sha256Hex(bytes) !== note.sha256) errors.push(`${note.voiceId}: differs from the datasheet's sha256`);
    const long = note.voiceId === LONG_NOTE;
    if (long ? note.durationSec < 150 : note.durationSec > 15) errors.push(`${note.voiceId}: lasts ${note.durationSec} s`);
  }
  return errors;
}

function historyBytes(bundle: SeedBundle): string[] {
  const set = new Set(bundle.media.set.map((photo) => photo.sha256));
  const hist = bundle.media.aux.photos.filter((photo) => photo.group === "hist");
  const errors = hist.filter((photo) => set.has(photo.sha256)).map((photo) => `${photo.photoId} has the bytes of a photo of the set`);
  for (const photo of hist) if (!fileMatches(photo.file, photo.sha256)) errors.push(`${photo.photoId}: ${photo.file} is missing or differs from the datasheet's sha256`);
  return errors;
}

function meterReadings(bundle: SeedBundle): string[] {
  const errors: string[] = [];
  for (const photo of bundle.media.set.filter((entry) => entry.item === "POWER_READING_PHOTO")) {
    if (!Number.isFinite(photo.orchestratorRxDbm) || photo.operState === undefined) errors.push(`${photo.photoId}: no orchestrator reading`);
    if (photo.drawn.template !== "meter") continue;
    const gap = Math.abs(photo.orchestratorRxDbm - photo.drawn.readingDbm);
    if (photo.expectedVerdict === "PASS" && (gap > CROSSCHECK_DB || photo.operState !== "ONLINE")) errors.push(`${photo.photoId}: PASS but the orchestrator reads ${photo.orchestratorRxDbm} dBm`);
    if (photo.expectedReason === "READING_MISMATCH" && gap <= CROSSCHECK_DB) errors.push(`${photo.photoId}: READING_MISMATCH within ${CROSSCHECK_DB} dB`);
  }
  return errors;
}

function seedingBytes(bundle: SeedBundle): string[] {
  const seeds = bundle.media.aux.photos.filter((photo) => photo.group === "seed");
  const others = new Set([...bundle.media.set, ...bundle.media.aux.photos.filter((photo) => photo.group === "hist")].map((photo) => photo.sha256));
  const errors = duplicates(seeds.map((photo) => photo.sha256)).map((sha) => `two seeding renders share ${sha.slice(0, 12)}`);
  for (const photo of seeds) {
    if (others.has(photo.sha256)) errors.push(`${photo.photoId} has the bytes of a photo of the set or of the history`);
    if (!fileMatches(photo.file, photo.sha256)) errors.push(`${photo.photoId}: ${photo.file} is missing or differs from the datasheet's sha256`);
  }
  if (seeds.length !== 48) errors.push(`${seeds.length} seeding renders, not 48`);
  return errors;
}

export const MEDIA_INVARIANTS: readonly Invariant[] = [
  { id: 8, title: "60 photos with the datasheet's sha256; 21 PASS and 39 not; values coherent with the labels", check: (bundle) => finding(photoSet(bundle)) },
  { id: 9, title: "12 Ogg voice notes with the datasheet's sha256 and durations", check: (bundle) => finding(voiceNotes(bundle)) },
  { id: 21, title: "No historical render shares bytes with a photo of the set", check: (bundle) => finding(historyBytes(bundle)) },
  { id: 22, title: "Every meter photo has the orchestrator's reading, coherent with its label", check: (bundle) => finding(meterReadings(bundle)) },
  { id: 23, title: "Seeding renders unique against the set, the history and each other", check: (bundle) => finding(seedingBytes(bundle)) },
];
