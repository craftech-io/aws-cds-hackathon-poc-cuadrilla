// Test kit of the world factory and the guest flows (never imported by a Lambda): the real guest
// template of the seed (`scripts/seed/data/worlds/guest.json`), a memory connector on a movable real
// clock, the subkeys of a test master key and fakes of the object store and of the brand secret.
import { readFileSync } from "node:fs";
import { createMemoryConnector, type MemoryConnector } from "../connector/memory/index";
import { deriveSubkey, phoneHash as hashPhone } from "../lib/crypto";
import type { BrandConfigValue } from "../lib/secret-schemas";
import type { FactoryDeps } from "./factory";
import type { DestroyDeps, ObjectBucket, ObjectStore } from "./guest-lifecycle";

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
