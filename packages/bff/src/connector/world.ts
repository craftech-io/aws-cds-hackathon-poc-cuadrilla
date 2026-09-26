// World scoping of stored items (docs/architecture.md §5, docs/seed-spec.md §13): which cloned world
// an item belongs to and when DynamoDB may expire it. QA and evaluation worlds expire 48 h after
// each write; `GUEST#isp-guest-test` is tagged `qa` without expiry; invited guest worlds live for the
// window of their accounts (the world janitor resets them); every item of a generation of the own
// sign-up (`GUEST#isp-guest-s<yymmdd>…`) expires at the end of its real creation day plus 9 days
// (7 of life and 2 of grace, ADR-0025 §2), also what the guest's activity writes later; the demo world
// keeps its items. Conversations keep 90 days and the audit log 12 months everywhere. The world
// factory may pass its own policy.
import { parseClockId, GUEST_TEST_CLOCK_ID, signupGenerationDay } from "@cuadrilla/shared";
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

/** Days after the end of its creation day that a sign-up generation's items live (ADR-0025 §2). */
export const SIGNUP_GENERATION_TTL_DAYS = 9;

/**
 * Epoch seconds at which every item of a sign-up generation expires: the end (UTC) of the real day
 * its id carries plus 9 days; `undefined` for any operator that is not a sign-up generation.
 */
export function signupGenerationExpiresAt(ispId: string): number | undefined {
  const day = signupGenerationDay(ispId);
  if (day === undefined) return undefined;
  return Math.floor(Date.parse(`${day}T00:00:00.000Z`) / 1000) + (1 + SIGNUP_GENERATION_TTL_DAYS) * DAY;
}

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
  const generationExpiry = signupGenerationExpiresAt(parsed.ispId);
  const expiresAt = earliest(tableExpiry, generationExpiry);
  return expiresAt === undefined ? { world } : { world, expiresAt };
};
