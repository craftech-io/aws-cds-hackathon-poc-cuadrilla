// Test support of the evidence (never imported by runtime code): the 60 photos of the set with their
// datasheet labels and the scripted output of the validator (scripts/seed/photos, WP-18), the rubric
// rows of the seed, the zones of the demo operator, and fakes of the photo model, the objects and the
// orchestrator. The scripted fake answers by the photo's bytes, as Bedrock would see them.
import { readFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { OnuSerial, OpticalClass, PhotoId, PhotoItem, RejectReason, Verdict } from "@cuadrilla/shared";
import type { NetworkClient, NetworkOutcome } from "../network/client";
import type { OnuStatus } from "@cuadrilla/network-contract";
import { sha256Hex } from "../lib/crypto";
import type { NewEntity } from "../domain/common";
import type { Zone } from "../domain/isps";
import { Rubric } from "../domain/reference";
import { RecordVerdict } from "./record-verdict";
import { stripJpegMetadata } from "./strip-metadata";
import type { EvidenceObjectStore, PhotoModelCall, PhotoModelPort, PhotoModelResult } from "./ports";

const PHOTOS_DIR = fileURLToPath(new URL("../../../../scripts/seed/photos/", import.meta.url));
const SEED_DATA_DIR = fileURLToPath(new URL("../../../../scripts/seed/data/", import.meta.url));

const DatasheetPhoto = z.looseObject({
  photoId: PhotoId,
  item: PhotoItem,
  file: z.string(),
  sha256: z.string(),
  expectedVerdict: Verdict,
  expectedReason: RejectReason.nullable(),
  acceptedReasons: z.array(RejectReason),
  acceptsUnsure: z.boolean(),
  opticalClass: OpticalClass,
  orderSerial: OnuSerial,
  orchestratorRxDbm: z.number(),
  precondition: z.object({ seededPassEvidenceOf: PhotoId }).optional(),
});

const ScriptedVerdict = z.looseObject({
  photoId: PhotoId,
  modelCalled: z.boolean(),
  recordVerdict: RecordVerdict,
  finalVerdict: Verdict,
  finalReason: RejectReason.nullable(),
  checks: z.array(z.string()),
});

export interface SetPhoto extends z.infer<typeof DatasheetPhoto> {
  readonly bytes: Uint8Array;
  readonly scripted: z.infer<typeof ScriptedVerdict>;
}

let photoSet: SetPhoto[] | undefined;

/** The 60 photos of the set (docs/seed-spec.md §10), with their bytes and scripted validator output. */
export function loadPhotoSet(): SetPhoto[] {
  if (photoSet !== undefined) return photoSet;
  const datasheet = z.object({ photos: z.array(DatasheetPhoto) }).parse(JSON.parse(readFileSync(`${PHOTOS_DIR}datasheet.json`, "utf8")));
  const scripted = z.object({ verdicts: z.array(ScriptedVerdict) }).parse(JSON.parse(readFileSync(`${PHOTOS_DIR}scripted-verdicts.json`, "utf8")));
  photoSet = datasheet.photos.map((photo) => {
    const verdict = scripted.verdicts.find((entry) => entry.photoId === photo.photoId);
    if (verdict === undefined) throw new Error(`no scripted verdict for ${photo.photoId}`);
    const bytes = new Uint8Array(readFileSync(fileURLToPath(new URL(`../../../../${photo.file}`, import.meta.url))));
    if (sha256Hex(bytes) !== photo.sha256) throw new Error(`${photo.photoId}: bytes differ from the datasheet`);
    return { ...photo, bytes, scripted: verdict };
  });
  return photoSet;
}

export function setPhoto(photoId: string): SetPhoto {
  const photo = loadPhotoSet().find((entry) => entry.photoId === photoId);
  if (photo === undefined) throw new Error(`unknown photo ${photoId}`);
  return photo;
}

/** The three rubric rows of `Reference/RUBRIC#v001` as the seed writes them. */
export function seedRubrics(): Array<NewEntity<typeof Rubric>> {
  const reference = z.object({ items: z.array(z.looseObject({ entity: z.string() })) }).parse(JSON.parse(readFileSync(`${SEED_DATA_DIR}Reference.json`, "utf8")));
  return reference.items
    .filter((row) => row.entity === "Rubric")
    .map((row) => {
      const { PK: _pk, SK: _sk, entity: _entity, createdAt: _createdAt, updatedAt: _updatedAt, version: _version, ...value } = row as Record<string, unknown>;
      return value as NewEntity<typeof Rubric>;
    });
}

/** Zones of the demo operator (docs/seed-spec.md §4): B+ in the north, C+ in the south. */
export function demoZones(ispId: string, clockId: string): Array<NewEntity<typeof Zone>> {
  return [
    { ispId, clockId, zoneId: "zone-norte", name: "Zona Norte", opticalClass: "B+", acceptanceRange: { minDbm: -25, maxDbm: -8 }, zoneChiefId: "zc-marisol" },
    { ispId, clockId, zoneId: "zone-sur", name: "Zona Sur", opticalClass: "C+", acceptanceRange: { minDbm: -28, maxDbm: -8 }, zoneChiefId: "zc-ricardo" },
  ];
}

export interface ScriptedModel extends PhotoModelPort {
  readonly calls: PhotoModelCall[];
  /** Answers for bytes the set does not know (a test's own photo), by the sha256 of the JPEG sent. */
  readonly answers: Map<string, PhotoModelResult>;
}

let bySentSha: Map<string, SetPhoto> | undefined;

/** A set photo by the sha256 of the JPEG the model receives: the photo itself or its stripped copy. */
function setPhotoSent(sha: string): SetPhoto | undefined {
  bySentSha ??= new Map(loadPhotoSet().flatMap((photo) => [[photo.sha256, photo] as const, [sha256Hex(stripJpegMetadata(photo.bytes).jpeg), photo] as const]));
  return bySentSha.get(sha);
}

/** The scripted validator: the photo set's `recordVerdict` for the JPEG the model receives. */
export function scriptedModel(): ScriptedModel {
  const calls: PhotoModelCall[] = [];
  const answers = new Map<string, PhotoModelResult>();
  return {
    source: "SCRIPTED",
    calls,
    answers,
    async read(call) {
      calls.push(call);
      const sha = sha256Hex(call.jpeg);
      const own = answers.get(sha);
      if (own !== undefined) return own;
      const photo = setPhotoSent(sha);
      if (photo === undefined) return { kind: "READ", source: "SCRIPTED", problem: "NO_TOOL_USE", latencyMs: 1 };
      return { kind: "READ", source: "SCRIPTED", record: photo.scripted.recordVerdict, stopReason: "tool_use", usage: { inputTokens: 1600, outputTokens: 220 }, latencyMs: 1 };
    },
  };
}

/** Objects in memory: `Media` and `Evidence` by key. */
export function memoryObjects(): EvidenceObjectStore & { readonly media: Map<string, Uint8Array>; readonly evidence: Map<string, Uint8Array> } {
  const media = new Map<string, Uint8Array>();
  const evidence = new Map<string, Uint8Array>();
  return {
    media,
    evidence,
    async readMedia(key, maxBytes) {
      const bytes = media.get(key);
      if (bytes === undefined) return { ok: false, problem: "MISSING" };
      return bytes.length > maxBytes ? { ok: false, problem: "TOO_LARGE" } : { ok: true, bytes };
    },
    async putEvidencePhoto(key, jpeg) {
      evidence.set(key, jpeg);
    },
  };
}

/** The orchestrator's reading of each serial; `undefined` makes it unavailable. */
export function fakeNetwork(readings: Map<string, number | undefined> = new Map()): Pick<NetworkClient, "getOnuStatus"> & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async getOnuStatus(call): Promise<NetworkOutcome<OnuStatus>> {
      calls.push(`${call.caller}:${call.serial}`);
      if (!readings.has(call.serial)) return { kind: "UNAVAILABLE", reason: "HTTP_5XX", attempts: 3 };
      const rx = readings.get(call.serial);
      return { kind: "OK", attempts: 1, value: { serial: call.serial, operState: rx === undefined ? "LOS" : "ONLINE", observedAt: call.atSim, ...(rx === undefined ? {} : { rxPowerDbm: rx }) } };
    },
  };
}

// ---- A small PNG writer: every filter type, several color types --------------------------------------

export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const body = new Uint8Array([...new TextEncoder().encode(type), ...data]);
  const crc = crc32(body);
  return new Uint8Array([data.length >>> 24, (data.length >> 16) & 0xff, (data.length >> 8) & 0xff, data.length & 0xff, ...body, crc >>> 24, (crc >> 16) & 0xff, (crc >> 8) & 0xff, crc & 0xff]);
}

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c;
  const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** 8-bit PNG of `rows` (raw samples per row); row r uses filter r % 5. */
export function writePng(width: number, rows: number[][], colorType: number, extra: Uint8Array[] = [], interlace = 0): Uint8Array {
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType] ?? 1;
  const filtered: number[] = [];
  rows.forEach((row, r) => {
    const filter = r % 5;
    const up = rows[r - 1] ?? [];
    filtered.push(filter);
    row.forEach((value, i) => {
      const left = i >= channels ? (row[i - channels] ?? 0) : 0;
      const above = up[i] ?? 0;
      const upLeft = i >= channels ? (up[i - channels] ?? 0) : 0;
      const predictor = [0, left, above, (left + above) >> 1, paeth(left, above, upLeft)][filter] ?? 0;
      filtered.push((value - predictor) & 0xff);
    });
  });
  const header = new Uint8Array([0, 0, 0, width, 0, 0, 0, rows.length, 8, colorType, 0, 0, interlace]);
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...pngChunk("IHDR", header), ...extra.flatMap((part) => [...part]), ...pngChunk("IDAT", deflateSync(new Uint8Array(filtered))), ...pngChunk("IEND", new Uint8Array())]);
}

/** Samples that change in every direction, so each filter type predicts something different. */
export const gradient = (width: number, height: number, channels: number) =>
  Array.from({ length: height }, (_, y) => Array.from({ length: width * channels }, (_, i) => (i * 37 + y * 53 + (i % channels) * 91) & 0xff));
