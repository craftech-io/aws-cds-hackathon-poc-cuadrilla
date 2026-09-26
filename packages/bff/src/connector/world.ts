// World scoping of stored items (docs/architecture.md §5, docs/seed-spec.md §13): which cloned world
// an item belongs to and when DynamoDB may expire it. QA and evaluation worlds expire 48 h after
// each write; `GUEST#isp-guest-test` is tagged `qa` without expiry; other guest worlds live for the
// evaluation window (the world janitor resets them); the demo world keeps its items. Conversations
// keep 90 days and the audit log 12 months everywhere. The world factory may pass its own policy.
import { parseClockId, GUEST_TEST_CLOCK_ID } from "@cuadrilla/shared";
import type { WorldTag } from "../domain/common";
import type { Table } from "./table-client";

export interface WorldStamp {
  readonly world?: WorldTag;
  /** Epoch seconds. */
  readonly expiresAt?: number;
}

export type WorldPolicy = (clockId: string | undefined, table: Table, now: Date) => WorldStamp;

const HOUR = 60 * 60;
const DAY = 24 * HOUR;

export const WORLD_TTL_SECONDS = { qa: 48 * HOUR, eval: 48 * HOUR } as const;

/** Tables that expire rows of every world after a fixed time (docs/architecture.md §5). */
export const TABLE_TTL_SECONDS: Readonly<Partial<Record<Table, number>>> = { Conversations: 90 * DAY, AuditLog: 365 * DAY };

const epoch = (now: Date, seconds: number): number => Math.floor(now.getTime() / 1000) + seconds;

function earliest(...values: Array<number | undefined>): number | undefined {
  const defined = values.filter((value): value is number => value !== undefined);
  return defined.length === 0 ? undefined : Math.min(...defined);
}

export const defaultWorldPolicy: WorldPolicy = (clockId, table, now) => {
  const tableTtl = TABLE_TTL_SECONDS[table];
  const tableExpiry = tableTtl === undefined ? undefined : epoch(now, tableTtl);
  if (table === "Reference") return {};
  const parsed = clockId === undefined ? undefined : parseClockId(clockId);
  if (parsed === undefined || parsed.kind === "DEMO") return tableExpiry === undefined ? {} : { expiresAt: tableExpiry };
  if (parsed.kind === "QA" || parsed.kind === "EVAL") {
    const world = parsed.kind === "QA" ? "qa" : "eval";
    return { world, expiresAt: earliest(tableExpiry, epoch(now, WORLD_TTL_SECONDS[world])) as number };
  }
  const world: WorldTag = clockId === GUEST_TEST_CLOCK_ID ? "qa" : "guest";
  return tableExpiry === undefined ? { world } : { world, expiresAt: tableExpiry };
};
