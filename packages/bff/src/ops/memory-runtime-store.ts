// In-process `Runtime` for the cap counters and the kill switch, with the same semantics as the
// DynamoDB adapter (all-or-nothing reservation, idempotency by key, release never below zero). The
// local flows (tests/flows) and the unit tests run on it.
import type { CapCounter, CapLedgerStore, CapStoreReserveResult } from "./cost-caps";
import type { KillSwitchRecord, KillSwitchStore } from "./kill-switch";

export interface MemoryRuntimeStore extends CapLedgerStore, KillSwitchStore {
  /** Every item by key, for assertions: counters as `{ used, limit, expiresAt }`, switches as written. */
  readonly items: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
}

export function createMemoryRuntimeStore(): MemoryRuntimeStore {
  const items = new Map<string, Record<string, unknown>>();
  const applied = new Set<string>();

  const usedOf = (key: string): number => {
    const used = items.get(key)?.used;
    return typeof used === "number" ? used : 0;
  };

  return {
    items,

    async reserve(counters: readonly CapCounter[], options): Promise<CapStoreReserveResult> {
      if (options.idempotencyKey !== undefined && applied.has(options.idempotencyKey)) return { ok: true };
      for (const counter of counters) {
        const used = usedOf(counter.key);
        if (used + Math.max(counter.amount, 1) > counter.limit) return items.has(counter.key) ? { ok: false, failedKey: counter.key, used } : { ok: false, failedKey: counter.key };
      }
      for (const counter of counters) {
        const current = items.get(counter.key);
        items.set(counter.key, { ...current, used: usedOf(counter.key) + counter.amount, limit: counter.limit, expiresAt: current?.expiresAt ?? counter.expiresAt, updatedAt: options.nowIso });
      }
      if (options.idempotencyKey !== undefined) applied.add(options.idempotencyKey);
      return { ok: true };
    },

    async release(counters) {
      for (const counter of counters) {
        const current = items.get(counter.key);
        if (current !== undefined && usedOf(counter.key) >= counter.amount) items.set(counter.key, { ...current, used: usedOf(counter.key) - counter.amount });
      }
    },

    async readUsed(keys) {
      return new Map(keys.filter((key) => items.has(key)).map((key) => [key, usedOf(key)] as const));
    },

    async read(keys) {
      return new Map(keys.flatMap((key) => {
        const item = items.get(key);
        return item === undefined ? [] : [[key, { ...item }] as const];
      }));
    },

    async write(key: string, record: KillSwitchRecord, expiresAt?: number) {
      items.set(key, { ...record, ...(expiresAt === undefined ? {} : { expiresAt }) });
    },
  };
}
