// Test kit of the world factory and the guest flows (never imported by a Lambda): the real templates of
// the seed (`scripts/seed/data/worlds/*.json`) and its photo catalog, a memory connector on a movable real
// clock, the subkeys of a test master key and fakes of the object store, of the brand secret and of
// AgentCore Memory.
import { readFileSync } from "node:fs";
import { createMemoryConnector, type MemoryConnector } from "../connector/memory/index";
import { deriveSubkey, phoneHash as hashPhone } from "../lib/crypto";
import { createLogger } from "../lib/log";
import type { BrandConfigValue, SeedOverridesValue } from "../lib/secret-schemas";
import { RecordingDispatcher, RecordingScheduler } from "../timers/testing";
import { historicalCertificates } from "./certificates";
import type { WorldsDeps } from "./deps";
import type { FactoryDeps } from "./factory";
import type { DestroyDeps, ObjectBucket, ObjectStore } from "./guest-lifecycle";
import type { MemoryAdmin, PurgeTarget } from "./memory-purge";
import { PhotoIndex, catalogOfDatasheets } from "./photo-catalog";
import type { PresetEffects } from "./presets";
import { type WorldTemplateName, staticTemplateSource } from "./templates";

export const TEMPLATE_TEXT = readFileSync(new URL("../../../../scripts/seed/data/worlds/guest.json", import.meta.url), "utf8");

export const TEST_MASTER_KEY = "test-master-key-test-master-key-00000000";
export const PHONE_KEY = deriveSubkey(TEST_MASTER_KEY, "phone-hash");
export const phoneHashOf = (phone: string): string => hashPhone(PHONE_KEY, phone);

/** A sign-up generation of 1 October 2026 and its clock. */
export const SIGNUP_ISP = "isp-guest-s261001abcde";
export const SIGNUP_CLOCK = `GUEST#${SIGNUP_ISP}`;
export const SIGNUP_USER = "usr-g01K60000000000000000000001";

export const NEUTRAL: BrandConfigValue = { mode: "neutral" };
export const COBRAND: Extract<BrandConfigValue, { readonly mode: "cobrand" }> = {
  mode: "cobrand",
  partnerDisplayName: "Operadora Socia",
  partnerShortName: "Socia",
  logoAssetKeys: { onLight: "brand/logo-on-light.svg", onDark: "brand/logo-on-dark.svg" },
  disclaimer: { es: "Demo sintética.", en: "Synthetic demo." },
};

/** Keys of every object put under a prefix, per bucket; `deletePrefix` removes them. */
export class MemoryObjects implements ObjectStore {
  readonly keys: Record<ObjectBucket, Set<string>> = { Media: new Set(), Evidence: new Set() };

  put(bucket: ObjectBucket, key: string): void {
    this.keys[bucket].add(key);
  }

  async deletePrefix(bucket: ObjectBucket, prefix: string): Promise<number> {
    if (prefix === "") throw new RangeError("refusing to delete a whole bucket");
    const doomed = [...this.keys[bucket]].filter((key) => key.startsWith(prefix));
    for (const key of doomed) this.keys[bucket].delete(key);
    return doomed.length;
  }
}

export interface WorldHarness extends MemoryConnector {
  now(): Date;
  advance(ms: number): void;
  readonly objects: MemoryObjects;
  factoryDeps(brand?: BrandConfigValue): FactoryDeps;
  destroyDeps(): DestroyDeps;
}

export function worldHarness(start = "2026-10-01T15:00:00.000Z"): WorldHarness {
  let nowMs = Date.parse(start);
  const now = () => new Date(nowMs);
  const memory = createMemoryConnector({ now });
  const objects = new MemoryObjects();
  return {
    ...memory,
    now,
    advance: (ms) => {
      nowMs += ms;
    },
    objects,
    factoryDeps: (brand = NEUTRAL) => ({ connector: memory.connector, client: memory.client, template: async () => TEMPLATE_TEXT, brand: () => brand, phoneHash: phoneHashOf, now }),
    destroyDeps: () => ({ client: memory.client, connector: memory.connector, template: async () => TEMPLATE_TEXT, phoneHash: phoneHashOf, objects, now }),
  };
}

/** Every row of every table of the memory client (the mocks' tables included). */
export function allRows(harness: MemoryConnector): Array<{ table: string; row: Record<string, unknown> }> {
  const tables = ["Isps", "People", "WorkOrders", "Cases", "Conversations", "AuditLog", "Reference", "Runtime", "CuadrillaMetrics", "Network", "Dispatch"] as const;
  return tables.flatMap((table) => harness.client.dump(table).map((row) => ({ table, row })));
}

// ---- Wave 4: the whole factory over memory ---------------------------------------------------------

const seedFile = (path: string): string => readFileSync(new URL(`../../../../scripts/seed/${path}`, import.meta.url), "utf8");

/** The committed world templates, byte for byte (what the IaC uploads to `Seed/worlds/`). */
export const TEMPLATE_TEXTS: Readonly<Record<WorldTemplateName, string>> = {
  demo: seedFile("data/worlds/demo.json"),
  guest: TEMPLATE_TEXT,
  models: seedFile("data/worlds/models.json"),
  "qa-min": seedFile("data/worlds/qa-min.json"),
  eval: seedFile("data/worlds/eval.json"),
};

/** The photo catalog `seed:load` publishes, from the committed datasheets. */
export const PHOTO_INDEX = new PhotoIndex(catalogOfDatasheets(JSON.parse(seedFile("photos/datasheet.json")), JSON.parse(seedFile("photos/datasheet-aux.json"))));

/** Bytes of a committed photo (`scripts/seed/photos/out/<photoId>.jpg`). */
export function photoBytes(photoId: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`../../../../scripts/seed/photos/out/${photoId}.jpg`, import.meta.url)));
}

/** AgentCore Memory in memory: events per actor and session, records per namespace. */
export class FakeMemory implements MemoryAdmin {
  readonly events = new Map<string, Set<string>>();
  readonly records = new Map<string, string>();
  readonly sessionListing: boolean;
  deletedEvents = 0;
  deletedRecords = 0;

  constructor(options: { readonly sessionListing?: boolean } = {}) {
    this.sessionListing = options.sessionListing ?? true;
  }

  addEvent(actorId: string, sessionId: string, eventId: string): void {
    const key = `${actorId}/${sessionId}`;
    this.events.set(key, new Set([...(this.events.get(key) ?? []), eventId]));
  }

  addRecord(actorId: string, recordId: string, namespace: "tips" | "preferences" = "tips"): void {
    this.records.set(recordId, `/installers/${actorId}/${namespace}/`);
  }

  eventsOf(actorId: string): number {
    return [...this.events.entries()].filter(([key]) => key.startsWith(`${actorId}/`)).reduce((sum, [, ids]) => sum + ids.size, 0);
  }

  recordsOf(actorId: string): number {
    return [...this.records.values()].filter((namespace) => namespace.startsWith(`/installers/${actorId}/`)).length;
  }

  async listSessionIds(actorId: string): Promise<string[]> {
    if (!this.sessionListing) return [];
    return [...this.events.keys()].filter((key) => key.startsWith(`${actorId}/`)).map((key) => key.slice(actorId.length + 1));
  }

  async listEventIds(actorId: string, sessionId: string): Promise<string[]> {
    return [...(this.events.get(`${actorId}/${sessionId}`) ?? [])];
  }

  async deleteEvent(actorId: string, sessionId: string, eventId: string): Promise<void> {
    if (this.events.get(`${actorId}/${sessionId}`)?.delete(eventId) === true) this.deletedEvents += 1;
  }

  async listRecordIds(prefix: string): Promise<string[]> {
    return [...this.records.entries()].filter(([, namespace]) => namespace.startsWith(prefix)).map(([id]) => id);
  }

  async deleteRecord(recordId: string): Promise<void> {
    if (this.records.delete(recordId)) this.deletedRecords += 1;
  }

  async listRecordActors(): Promise<string[]> {
    return [...new Set([...this.records.values()].map((namespace) => namespace.split("/")[2] ?? ""))].filter((actor) => actor !== "");
  }
}

export interface WorldsHarness extends WorldHarness {
  readonly deps: WorldsDeps;
  readonly memory: FakeMemory;
  readonly scheduler: RecordingScheduler;
  readonly dispatcher: RecordingDispatcher;
  /** Targets handed to `continuePurge` (the passes after the first). */
  readonly purges: PurgeTarget[];
  /** PDFs written by the historical certificates, by key. */
  readonly pdfs: Map<string, Uint8Array>;
  /** Keys of `Media` the `candidates` preset copied a photo to. */
  readonly media: Map<string, string>;
  /** Changes `BrandConfig` (a brand change between two loads). */
  setBrand(next: BrandConfigValue): void;
}

export interface WorldsHarnessOptions {
  readonly start?: string;
  readonly brand?: BrandConfigValue;
  readonly overrides?: SeedOverridesValue;
  readonly effects?: PresetEffects;
  readonly certificates?: boolean;
  readonly sessionListing?: boolean;
}

export const RUNTIME_SESSION_KEY = deriveSubkey(TEST_MASTER_KEY, "runtime-session");
export const NONCE_KEY = deriveSubkey(TEST_MASTER_KEY, "nonce");

export function worldsHarness(options: WorldsHarnessOptions = {}): WorldsHarness {
  const base = worldHarness(options.start);
  let brand = options.brand ?? NEUTRAL;
  const memory = new FakeMemory(options.sessionListing === undefined ? {} : { sessionListing: options.sessionListing });
  const scheduler = new RecordingScheduler();
  const dispatcher = new RecordingDispatcher();
  const purges: PurgeTarget[] = [];
  const pdfs = new Map<string, Uint8Array>();
  const media = new Map<string, string>();
  const log = createLogger({ sink: () => undefined });
  const certificates = historicalCertificates({ connector: base.connector, objects: { putPdf: async (key, bytes) => void pdfs.set(key, bytes) }, photo: async (photoId) => photoBytes(photoId), brand: () => brand, logger: log });
  const deps: WorldsDeps = {
    connector: base.connector,
    client: base.client,
    templates: staticTemplateSource(TEMPLATE_TEXTS),
    photos: async () => PHOTO_INDEX,
    brand: () => brand,
    overrides: () => options.overrides ?? {},
    phoneHash: phoneHashOf,
    runtimeSessionKey: RUNTIME_SESSION_KEY,
    scheduler,
    dispatcher,
    memory,
    continuePurge: async (target) => void purges.push(target),
    ...(options.certificates === false ? {} : { certificates }),
    nonces: { runtime: base.connector.runtime, nonceKey: NONCE_KEY, realClock: { now: async () => base.now() } },
    ...(options.effects === undefined ? {} : { effects: options.effects }),
    media: { copySeedPhoto: async (photoId, key) => void media.set(key, photoId) },
    log,
    now: base.now,
  };
  return Object.assign(base, { deps, memory, scheduler, dispatcher, purges, pdfs, media, setBrand: (next: BrandConfigValue) => void (brand = next) });
}
