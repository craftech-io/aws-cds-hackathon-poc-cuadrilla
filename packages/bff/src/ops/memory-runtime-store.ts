// In-process `Runtime` for the cap counters and the kill switch, with the same semantics as the
// DynamoDB adapter (all-or-nothing reservation, idempotency by key, release never below zero). The
// local flows (tests/flows) and the unit tests run on it.
import { type CapCounter, type CapLedgerStore, type CapStoreReserveResult, roomNeeded } from "./cost-caps";
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
        if (used + roomNeeded(counter) > counter.limit) return items.has(counter.key) ? { ok: false, failedKey: counter.key, used } : { ok: false, failedKey: counter.key };
      }
      // A counter that is only checked (amount 0) is a ConditionCheck in DynamoDB: it writes nothing.
      for (const counter of counters.filter((candidate) => candidate.amount > 0)) {
        const current = items.get(counter.key);
        const expiresAt = current?.expiresAt ?? counter.expiresAt;
        items.set(counter.key, { ...current, used: usedOf(counter.key) + counter.amount, limit: counter.limit, ...(expiresAt === undefined ? {} : { expiresAt }), updatedAt: options.nowIso });
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

    async adjust(key, delta, options) {
      // Its own token space, as the DynamoDB adapter's `adjust#` client token.
      const token = `adjust#${options.idempotencyKey}`;
      if (applied.has(token)) return;
      items.set(key, { ...items.get(key), used: usedOf(key) + delta, updatedAt: options.nowIso });
      applied.add(token);
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
