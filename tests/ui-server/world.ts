// The world of the local UI server (docs/test-plan.md §2, level UI): an in-memory connector seeded only
// from scripts/seed/data (every table of the demo world and the reference catalogs) plus the guest
// worlds the specs sign in to, built by the product's own factory from the `guest` template
// (`isp-guest-07`, an invited guest's, and `isp-guest-test`, the rehearsal's). Neutral brand: this
// process has no BrandConfig, so no partner's name or logo can reach a page (ADR-0018). Nothing here
// reads an override with real phones or addresses.
//
// Objects (photos, voice notes, the manual's sections) are read from the repository when the in-memory
// buckets do not hold them: `Seed/photos/<id>.jpg` from scripts/seed/photos/out, `Seed/audio/<id>.ogg`
// from scripts/seed/audio, `Manual/manual/<v>/<section>.md` from scripts/seed/data/manual.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DomainTable } from "../../packages/bff/src/domain/registry";
import type { Table } from "../../packages/bff/src/connector/table-client";
import { type MemoryConnector, createMemoryConnector } from "../../packages/bff/src/connector/index";
import type { Item } from "../../packages/bff/src/connector/table-client";
import { DEMO_CLOCK_ID } from "@cuadrilla/shared";
import { deriveSubkey, phoneHash } from "../../packages/bff/src/lib/crypto";
import type { BucketName } from "../../packages/bff/src/lib/resource";
import type { StoredBlob } from "../../packages/bff/src/routers/console-testing";
import { buildWorld } from "../../packages/bff/src/worlds/factory";

const ROOT = join(import.meta.dirname, "../..");
const SEED = join(ROOT, "scripts/seed/data");

/** The tables of the domain the seed writes, in the order a world is loaded (the operator's rows last). */
export const SEED_TABLES: readonly DomainTable[] = ["Reference", "People", "WorkOrders", "Cases", "Conversations", "AuditLog", "CuadrillaMetrics", "Isps"];
/** The simulated systems' tables: plain rows, written as they are. */
export const MOCK_TABLES: readonly Table[] = ["Network", "Dispatch"];

/** The guest worlds of the specs: an invited guest's and the rehearsal guest's. */
export const UI_GUEST_WORLDS = [
  { ispId: "isp-guest-07", origin: "INVITED" },
  { ispId: "isp-guest-test", origin: "TEST" },
] as const;

/** The phone hashes of this server only: the world is synthetic and never leaves the process. */
export const UI_PHONE_HASH_KEY = deriveSubkey("ui-server-world-key-not-a-secret", "phone-hash");
export const uiPhoneHash = (phone: string): string => phoneHash(UI_PHONE_HASH_KEY, phone);

/** The demo world's clock: paused at the story's day, before the day starts (docs/seed-spec.md §3). */
const DEMO_START_SIM = "2026-10-13T07:00:00-06:00";
const EPOCH_ENTITIES: ReadonlySet<string> = new Set(["WorkOrder", "Evidence"]);

interface SeedFile {
  readonly items: Item[];
}

async function seedItems(table: string): Promise<Item[]> {
  return (JSON.parse(await readFile(join(SEED, `${table}.json`), "utf8")) as SeedFile).items;
}

/** A fresh world: the seed as it is, plus the guest worlds of the specs. */
export async function createUiWorld(now: () => Date = () => new Date()): Promise<MemoryConnector> {
  const memory = createMemoryConnector({ now });
  for (const table of MOCK_TABLES) await memory.client.batchPut(table, await seedItems(table));
  // The loader stamps the demo world's epoch on its orders and evidence (worlds/demo.ts); this world is epoch 1.
  const stamped = (items: Item[]) => items.map((item) => (EPOCH_ENTITIES.has(String(item.entity)) && item.worldEpoch === undefined ? { ...item, worldEpoch: 1 } : item));
  for (const table of SEED_TABLES) await memory.connector.seed.loadItems(table, stamped(await seedItems(table)));
  await memory.connector.runtime.createClock({ clockId: DEMO_CLOCK_ID, ispId: "isp-demo", kind: "DEMO", mode: "PAUSED", offsetMs: 0, pausedSimNow: DEMO_START_SIM, worldEpoch: 1, template: "demo" });
  const template = await readFile(join(SEED, "worlds/guest.json"), "utf8");
  for (const world of UI_GUEST_WORLDS) {
    await buildWorld(
      { connector: memory.connector, client: memory.client, template: () => Promise.resolve(template), brand: () => ({ mode: "neutral" }), phoneHash: uiPhoneHash, now },
      { ispId: world.ispId, origin: world.origin },
    );
  }
  return memory;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = { jpg: "image/jpeg", ogg: "audio/ogg", md: "text/markdown", svg: "image/svg+xml" };

/** Where a bucket's object lives in the repository, if it is one of the seed's files. */
function repositoryPathOf(bucket: BucketName, key: string): string | undefined {
  if (key.includes("..")) return undefined;
  if (bucket === "Seed" && /^photos\/ph-[a-z0-9-]+\.jpg$/.test(key)) return join(ROOT, "scripts/seed/photos/out", key.slice("photos/".length));
  if (bucket === "Seed" && /^audio\/vn-\d{2}\.ogg$/.test(key)) return join(ROOT, "scripts/seed/audio", key.slice("audio/".length));
  if (bucket === "Manual" && /^manual\/v\d{3}\/[A-Z]{2,4}-\d{2}\.md$/.test(key)) return join(SEED, key);
  return undefined;
}

/** The repository's seed files as the buckets would serve them. */
export async function repositoryObject(bucket: BucketName, key: string): Promise<StoredBlob | undefined> {
  const path = repositoryPathOf(bucket, key);
  if (path === undefined) return undefined;
  try {
    const bytes = new Uint8Array(await readFile(path));
    return { bytes, contentType: CONTENT_TYPES[path.split(".").pop() ?? ""] ?? "application/octet-stream" };
  } catch {
    return undefined;
  }
}
