// `reserve_cost` (docs/tool-catalog.md, ADR-0019): every spend on a model, on Transcribe or on an
// email is reserved BEFORE it happens, with one conditional write over every counter that caps it,
// all or nothing. Three ledgers, all in `Runtime`, all measured in real time (a "+1 h" of the demo
// clock never resets them):
//
//   SIMULATOR  SIMCAP#<clockId>#<resource>#<period>   the world's simulator caps (IspSettings.simulatorCaps)
//   OPERATOR   TURNCAP#<ispId>#<period>               the operator's turn caps (IspSettings.turnCaps)
//   GLOBAL     TURNCAP|VALCAP|TRANSCRIBE#GLOBAL#<day> the stage's ceiling (infra/cost-caps.ts, `CostCaps`)
//
// A world of the own sign-up (`GUEST#isp-guest-s…`, ADR-0025 §3) spends inside two more ceilings, both
// checked with the global one and in this order: world → account → sub-ceiling → global ceiling, so
// the sign-up guests never use up the capacity of the invited ones and a new generation never resets
// its guest's quota (`KILL#` stays above everything):
//
//   TURNCAP#GUESTUSER#<userId>#<day>                  turns of one account (`IspSettings.ownerUserId`)
//   TURNCAP|VALCAP|TRANSCRIBE#GUESTSIGNUP#<day>       every sign-up world together (`CostCaps.guestSignup`)
//
// QA and evaluation worlds never touch the real global ceiling (they have a budget per run). A `qa-*`
// world with `globalCapsOverride` gets a test scope instead: `…#GLOBAL#<clockId>#<day>` (its clock id
// is `qa-<runId>-<scenario>`) with the values given, so a scenario proves the ceiling without ever
// touching the real one. A ledger may also be only *checked* (a write of zero that fails when the
// counter is full): the simulator checks the global ceiling before enqueueing, and the worker and
// `ToolEvidence` reserve it at the spend. The kill switch is read first; physical safety never
// calls this module.
import { z } from "zod";
import { ClockId, type KillScope, type ToolFailure, fail, ispIdOfClock, ispKindOfClock, isSignupGuestIsp } from "@cuadrilla/shared";
import { type Clock, systemClock } from "../lib/clock";
import type { Logger } from "../lib/log";
import { readLinked } from "../lib/resource";
import { type KillSurface, type KillSwitchReader, blockingScope } from "./kill-switch";

export const CostResource = z.enum(["turns", "validations", "transcribe", "emails"]);
export type CostResource = z.infer<typeof CostResource>;

export const CapLedger = z.enum(["SIMULATOR", "OPERATOR", "GLOBAL"]);
export type CapLedger = z.infer<typeof CapLedger>;

export const CapPeriod = z.enum(["HOUR", "DAY"]);
export type CapPeriod = z.infer<typeof CapPeriod>;

/** TTL of every counter past the end of its period (docs/architecture.md §5: rates and caps, 48 h). */
export const CAP_TTL_AFTER_PERIOD_SECONDS = 48 * 3_600;

const Limit = z.number().int().nonnegative();

/** `CostCaps.guestSignup`: the sub-ceiling of the sign-up worlds and the quota of one account (ADR-0025 §3). */
export const GuestSignupCaps = z.object({ turnsPerDay: Limit, validationsPerDay: Limit, transcribeSecondsPerDay: Limit, perUserTurnsPerDay: Limit });
export type GuestSignupCaps = z.infer<typeof GuestSignupCaps>;

/** `sst.Linkable("CostCaps")` of infra/cost-caps.ts: the stage's ceiling per real day. */
export const GlobalCostCaps = z.object({ turnsPerDay: Limit, validationsPerDay: Limit, transcribeSecondsPerDay: Limit, guestSignup: GuestSignupCaps.optional() });
export type GlobalCostCaps = z.infer<typeof GlobalCostCaps>;

export function linkedGlobalCostCaps(): GlobalCostCaps {
  return readLinked("CostCaps", GlobalCostCaps);
}

/** The part of `IspSettings` (docs/architecture.md §5) that caps spending; other settings are ignored. */
export const CapSettings = z.object({
  turnCaps: z.object({ perHour: Limit.optional(), perDay: Limit.optional() }).optional(),
  simulatorCaps: z
    .object({ turnsPerHour: Limit.optional(), turnsPerDay: Limit.optional(), validationsPerDay: Limit.optional(), transcribeSecPerDay: Limit.optional(), emailsPerDay: Limit.optional() })
    .optional(),
  globalCapsOverride: GlobalCostCaps.omit({ guestSignup: true }).partial().optional(),
  /** A sign-up generation's guest: the account whose quota its turns take. */
  ownerUserId: z.string().min(1).optional(),
});
export type CapSettings = z.infer<typeof CapSettings>;

/** One counter of one reservation; `amount` 0 only checks that the counter still has room. */
export interface CapCounter {
  /** Partition key in `Runtime` (sort key `META`). */
  readonly key: string;
  readonly ledger: CapLedger;
  readonly resource: CostResource;
  readonly period: CapPeriod;
  readonly limit: number;
  readonly amount: number;
  /** TTL, epoch seconds. */
  readonly expiresAt: number;
  /** Real instant the period ends and the counter starts over ("cuándo se libera"). */
  readonly resetsAtReal: string;
  /** Inside the GLOBAL ledger of a sign-up world: the account's quota or the sub-ceiling of every sign-up world. */
  readonly tier?: CapTier;
}

export type CapTier = "GUEST_ACCOUNT" | "GUEST_SIGNUP";

export type CapStoreReserveResult = { readonly ok: true } | { readonly ok: false; readonly failedKey: string; readonly used?: number };

/** `Runtime` access of the counters; adapters in ops/dynamo-runtime-store.ts and ops/memory-runtime-store.ts. */
export interface CapLedgerStore {
  /** Adds every `amount` if every counter keeps `used + max(amount, 1) <= limit`; otherwise changes none. */
  reserve(counters: readonly CapCounter[], options: { readonly idempotencyKey?: string; readonly nowIso: string }): Promise<CapStoreReserveResult>;
  /** Gives the amounts back (a reservation whose spend did not happen), never below zero. */
  release(counters: readonly CapCounter[]): Promise<void>;
  /** `used` of each existing counter. */
  readUsed(keys: readonly string[]): Promise<ReadonlyMap<string, number>>;
}

// ---- Periods (real time, UTC) ------------------------------------------------------------------

/** `2026-10-13`: the real day of a counter. */
export function realDayKey(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/** `2026-10-13T15`: the real hour of a counter. */
export function realHourKey(instant: Date): string {
  return instant.toISOString().slice(0, 13);
}

function periodOf(period: CapPeriod, now: Date): { readonly token: string; readonly endsAt: Date } {
  const start = new Date(now.getTime());
  if (period === "DAY") start.setUTCHours(0, 0, 0, 0);
  else start.setUTCMinutes(0, 0, 0);
  const length = period === "DAY" ? 86_400_000 : 3_600_000;
  return { token: period === "DAY" ? realDayKey(now) : realHourKey(now), endsAt: new Date(start.getTime() + length) };
}

// ---- Planning ------------------------------------------------------------------------------------

export interface CapWorld {
  readonly clockId: string;
  /** `Isps/SETTINGS` of the world's operator (or just the cap fields of it). */
  readonly settings: unknown;
}

export interface ReserveCostRequest {
  readonly world: CapWorld;
  readonly resource: CostResource;
  /** Turns, validations or emails (1), or seconds of audio for `transcribe` (rounded up by the caller). */
  readonly amount: number;
  /** Ledgers that take the amount. */
  readonly reserve: readonly CapLedger[];
  /** Ledgers that only need room left (the amount is not added). */
  readonly check?: readonly CapLedger[];
  /** Kill switch surface the spend belongs to; omitted for what the switch never stops (emails). */
  readonly surface?: KillSurface;
  /** Event id: a retried Lambda does not reserve twice (DynamoDB idempotency window: 10 minutes). */
  readonly idempotencyKey?: string;
}

/** Resources the stage's ceiling caps (emails are capped per world only), with their key prefix. */
const GLOBAL_LEDGER = {
  turns: { prefix: "TURNCAP", field: "turnsPerDay" },
  validations: { prefix: "VALCAP", field: "validationsPerDay" },
  transcribe: { prefix: "TRANSCRIBE", field: "transcribeSecondsPerDay" },
} as const satisfies Partial<Record<CostResource, { readonly prefix: string; readonly field: keyof GlobalCostCaps }>>;
type GlobalResource = keyof typeof GLOBAL_LEDGER;
const GLOBAL_RESOURCES = Object.keys(GLOBAL_LEDGER) as GlobalResource[];
const SIMULATOR_CAP_FIELDS: Readonly<Record<CostResource, ReadonlyArray<readonly [CapPeriod, keyof NonNullable<CapSettings["simulatorCaps"]>]>>> = {
  turns: [["HOUR", "turnsPerHour"], ["DAY", "turnsPerDay"]],
  validations: [["DAY", "validationsPerDay"]],
  transcribe: [["DAY", "transcribeSecPerDay"]],
  emails: [["DAY", "emailsPerDay"]],
};

interface CounterSpec {
  readonly key: (token: string) => string;
  readonly ledger: CapLedger;
  readonly period: CapPeriod;
  readonly limit: number | undefined;
  readonly tier?: CapTier;
}

/**
 * The account and the sub-ceiling of a sign-up world, before its global ceiling. A world without its
 * guest, or a stage without the sub-ceiling, gets a limit of 0: it spends nothing (fails closed).
 */
function signupSpecs(clockId: string, resource: GlobalResource, settings: CapSettings, globalCaps: GlobalCostCaps): CounterSpec[] {
  const ledger = "GLOBAL";
  const caps = globalCaps.guestSignup;
  const { prefix, field } = GLOBAL_LEDGER[resource];
  const specs: CounterSpec[] = [];
  if (resource === "turns") {
    const owner = settings.ownerUserId;
    const key = owner === undefined ? (token: string) => `TURNCAP#GUESTUSER#${ispIdOfClock(clockId)}#${token}` : (token: string) => `TURNCAP#GUESTUSER#${owner}#${token}`;
    specs.push({ ledger, period: "DAY", tier: "GUEST_ACCOUNT", limit: owner === undefined ? 0 : (caps?.perUserTurnsPerDay ?? 0), key });
  }
  specs.push({ ledger, period: "DAY", tier: "GUEST_SIGNUP", limit: caps?.[field] ?? 0, key: (token) => `${prefix}#GUESTSIGNUP#${token}` });
  return specs;
}

function ledgerSpecs(ledger: CapLedger, clockId: string, resource: CostResource, settings: CapSettings, globalCaps: GlobalCostCaps): CounterSpec[] {
  switch (ledger) {
    case "SIMULATOR":
      return SIMULATOR_CAP_FIELDS[resource].map(([period, field]) => ({ ledger, period, limit: settings.simulatorCaps?.[field], key: (token) => `SIMCAP#${clockId}#${resource}#${token}` }));
    case "OPERATOR": {
      if (resource !== "turns") return [];
      const ispId = ispIdOfClock(clockId);
      const caps = settings.turnCaps;
      return [
        { ledger, period: "HOUR", limit: caps?.perHour, key: (token) => `TURNCAP#${ispId}#${token}` },
        { ledger, period: "DAY", limit: caps?.perDay, key: (token) => `TURNCAP#${ispId}#${token}` },
      ];
    }
    case "GLOBAL": {
      if (resource === "emails") return [];
      const { prefix, field } = GLOBAL_LEDGER[resource];
      const kind = ispKindOfClock(clockId);
      if (kind === "QA" && settings.globalCapsOverride !== undefined) {
        return [{ ledger, period: "DAY", limit: settings.globalCapsOverride[field], key: (token) => `${prefix}#GLOBAL#${clockId}#${token}` }];
      }
      if (kind === "QA" || kind === "EVAL") return [];
      const global: CounterSpec = { ledger, period: "DAY", limit: globalCaps[field], key: (token) => `${prefix}#GLOBAL#${token}` };
      return isSignupGuestIsp(ispIdOfClock(clockId)) ? [...signupSpecs(clockId, resource, settings, globalCaps), global] : [global];
    }
  }
}

const Amount = z.number().int().min(1);

/** The counters a reservation writes, in ledger order; ledgers without a configured cap add none. */
export function planCounters(request: ReserveCostRequest, globalCaps: GlobalCostCaps, now: Date): CapCounter[] {
  const clockId = ClockId.parse(request.world.clockId);
  const resource = CostResource.parse(request.resource);
  const amount = Amount.parse(request.amount);
  const settings = CapSettings.parse(request.world.settings ?? {});
  const reserved = new Set(request.reserve.map((ledger) => CapLedger.parse(ledger)));
  const checked = new Set((request.check ?? []).map((ledger) => CapLedger.parse(ledger)).filter((ledger) => !reserved.has(ledger)));
  const counters: CapCounter[] = [];
  for (const ledger of CapLedger.options) {
    if (!reserved.has(ledger) && !checked.has(ledger)) continue;
    for (const spec of ledgerSpecs(ledger, clockId, resource, settings, globalCaps)) {
      if (spec.limit === undefined) continue;
      const period = periodOf(spec.period, now);
      counters.push({
        key: spec.key(period.token),
        ledger,
        resource,
        period: spec.period,
        limit: spec.limit,
        amount: reserved.has(ledger) ? amount : 0,
        expiresAt: Math.floor(period.endsAt.getTime() / 1000) + CAP_TTL_AFTER_PERIOD_SECONDS,
        resetsAtReal: period.endsAt.toISOString(),
        ...(spec.tier === undefined ? {} : { tier: spec.tier }),
      });
    }
  }
  return counters;
}

// ---- Reserving -----------------------------------------------------------------------------------

export type ReserveCostOutcome =
  | { readonly ok: true; readonly reserved: readonly CapCounter[] }
  | { readonly ok: false; readonly code: "KILL_SWITCH_ACTIVE"; readonly scope: KillScope; readonly clockId: string }
  | { readonly ok: false; readonly code: "CAP_REACHED"; readonly counter: CapCounter; readonly used?: number };

/** `CAP_REACHED` / `KILL_SWITCH_ACTIVE` (docs/tool-catalog.md, `reserve_cost`); the caller's adapter writes `AuditLog`. */
export type CostAuditEvent = Exclude<ReserveCostOutcome, { readonly ok: true }> & { readonly resource: CostResource; readonly atReal: string };

export interface CostCapsDeps {
  readonly store: CapLedgerStore;
  readonly globalCaps: () => GlobalCostCaps;
  readonly kill?: KillSwitchReader;
  /** Real time: caps are counted per real hour and day, never in a world's simulated time. */
  readonly realClock?: Clock;
  readonly audit?: (event: CostAuditEvent) => Promise<void>;
  readonly logger?: Logger;
}

// Metric names the log lines carry (docs/architecture.md §12, metric filters of WP-38).
function capMetric(counter: CapCounter): { readonly metric: string; readonly scope?: string } {
  if (counter.tier !== undefined) return { metric: "GuestSignupCapHits", scope: counter.tier };
  if (counter.ledger === "SIMULATOR") return { metric: "SimulatorCapHits" };
  if (counter.resource === "turns") return { metric: "TurnCapHits", scope: counter.ledger };
  return { metric: "GlobalCapHits", scope: counter.resource };
}

async function denied(deps: CostCapsDeps, outcome: Exclude<ReserveCostOutcome, { readonly ok: true }>, resource: CostResource, now: Date): Promise<ReserveCostOutcome> {
  if (outcome.code === "CAP_REACHED") {
    const { counter } = outcome;
    deps.logger?.warn("cost cap reached", { action: "CAP_REACHED", ...capMetric(counter), ledger: counter.ledger, resource, period: counter.period, counter: counter.key, limit: counter.limit });
  } else {
    deps.logger?.warn("kill switch active", { action: "KILL_SWITCH_ACTIVE", metric: "KillSwitchActive", scope: outcome.scope, clockId: outcome.clockId, resource });
  }
  await deps.audit?.({ ...outcome, resource, atReal: now.toISOString() });
  return outcome;
}

/** `reserve_cost`: reads the kill switch, then reserves every counter of the request at once. */
export async function reserveCost(deps: CostCapsDeps, request: ReserveCostRequest): Promise<ReserveCostOutcome> {
  const now = await (deps.realClock ?? systemClock).now();
  const clockId = ClockId.parse(request.world.clockId);
  if (request.surface !== undefined && deps.kill !== undefined) {
    const scope = blockingScope(await deps.kill.status(clockId), request.surface);
    if (scope !== undefined) return denied(deps, { ok: false, code: "KILL_SWITCH_ACTIVE", scope, clockId }, request.resource, now);
  }
  const counters = planCounters(request, deps.globalCaps(), now);
  if (counters.length === 0) return { ok: true, reserved: [] };
  const result = await deps.store.reserve(counters, { nowIso: now.toISOString(), ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }) });
  if (result.ok) {
    const reserved = counters.filter((counter) => counter.amount > 0);
    for (const counter of reserved) if (counter.ledger === "GLOBAL") deps.logger?.info("global cap reserved", { action: "CAP_RESERVED", metric: "GlobalCapUsage", resource: counter.resource, amount: counter.amount });
    return { ok: true, reserved };
  }
  const counter = counters.find((candidate) => candidate.key === result.failedKey) ?? counters[0];
  if (counter === undefined) throw new Error("reserve failed on an unknown counter");
  return denied(deps, { ok: false, code: "CAP_REACHED", counter, ...(result.used === undefined ? {} : { used: result.used }) }, request.resource, now);
}

/** Gives back a reservation whose spend never happened (a turn returned to the queue before the Harness). */
export async function releaseCost(deps: Pick<CostCapsDeps, "store">, reserved: readonly CapCounter[]): Promise<void> {
  const counters = reserved.filter((counter) => counter.amount > 0);
  if (counters.length > 0) await deps.store.release(counters);
}

/** The envelope a tool or the simulator returns for a denied reservation. */
export function costFailure(outcome: Exclude<ReserveCostOutcome, { readonly ok: true }>): ToolFailure {
  if (outcome.code === "KILL_SWITCH_ACTIVE") return fail("UNAVAILABLE", "the service is paused", "KILL_SWITCH_ACTIVE");
  return fail("CAP_REACHED", `the ${outcome.counter.resource} cap of this period is reached until ${outcome.counter.resetsAtReal}`, outcome.counter.tier ?? outcome.counter.ledger);
}

export interface GlobalCapUsage {
  readonly resource: CostResource;
  readonly used: number;
  readonly limit: number;
  readonly resetsAtReal: string;
}

/** Today's consumption of the stage's ceiling (the metrics view, docs/design-brief.md §8). */
export async function globalCapUsage(deps: Pick<CostCapsDeps, "store" | "globalCaps" | "realClock">): Promise<GlobalCapUsage[]> {
  const now = await (deps.realClock ?? systemClock).now();
  const caps = deps.globalCaps();
  const day = periodOf("DAY", now);
  const rows = GLOBAL_RESOURCES.map((resource) => ({ resource, key: `${GLOBAL_LEDGER[resource].prefix}#GLOBAL#${day.token}`, limit: caps[GLOBAL_LEDGER[resource].field] }));
  const used = await deps.store.readUsed(rows.map((row) => row.key));
  return rows.map((row) => ({ resource: row.resource, used: used.get(row.key) ?? 0, limit: row.limit, resetsAtReal: day.endsAt.toISOString() }));
}
