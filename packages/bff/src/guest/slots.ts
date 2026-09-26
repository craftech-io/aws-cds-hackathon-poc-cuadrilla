// Room for the worlds of the own sign-up (ADR-0025 §3): a sign-up guest's world takes a slot, and a slot
// is two counters of `Runtime`, reserved in the same transaction as the generation that uses it:
//
//   GUESTWORLDS#<yymmdd>        worlds created that real day; the sum of the last 7 days (a generation
//                               lives 7 days) are the active worlds, at most 150
//   SIGNUPOK#GLOBAL#<realDay>   worlds granted to confirmed sign-ups that day, at most 150
//
// Today's counter is incremented with a ceiling computed from the sum it read (150 minus the other six
// days), so two concurrent reservations at the limit may pass together only when they read different
// sums: the race the ADR declares and tolerates (the stage's cost ceiling still holds). Without room,
// the account and the lead are created all the same and the world waits in `CAP_FULL`.
//
// Accounts of the QA seam (`success+qa-…` addresses, ADR-0025 §7) count under keys of their own
// (`GUESTWORLDS#QA#…`, `SIGNUPOK#QA#…`) with limits `guest.capsOverride` may set
// (`GUESTWORLDS#QA#LIMITS`): a scenario proves the caps without ever touching the real ones.
import { z } from "zod";
import { generationDateTag } from "@cuadrilla/shared";
import type { RuntimePort } from "../connector/ports-runtime";
import type { Item, TableClient, TransactOp } from "../connector/table-client";

export const SIGNUP_WORLD_LIMITS = { activeWorlds: 150, confirmedPerDay: 150 } as const;
export type SlotLimits = { readonly activeWorlds: number; readonly confirmedPerDay: number };

/** Days a generation lives, so the days whose counters add up to the active worlds. */
export const ACTIVE_WINDOW_DAYS = 7;
/** `GUESTWORLDS#` rows live 10 days (docs/architecture.md §5); the daily `SIGNUPOK#` ones 48 h past their day. */
const WORLDS_TTL_SECONDS = 10 * 86_400;
const CONFIRMED_TTL_AFTER_DAY_SECONDS = 48 * 3_600;
const DAY_MS = 86_400_000;
export const SLOT_COUNTER = "count";

export type SlotScope = "PUBLIC" | "QA";

const worldsPrefix = (scope: SlotScope): string => (scope === "QA" ? "GUESTWORLDS#QA#" : "GUESTWORLDS#");
export const worldsDayKey = (scope: SlotScope, yymmdd: string): string => `${worldsPrefix(scope)}${yymmdd}`;
export const confirmedDayKey = (scope: SlotScope, realDay: string): string => `${scope === "QA" ? "SIGNUPOK#QA#" : "SIGNUPOK#GLOBAL#"}${realDay}`;
/** Limits of the QA scope (`guest.capsOverride`); the public limits are code, never a row. */
export const QA_LIMITS_KEY = "GUESTWORLDS#QA#LIMITS";

const meta = (pk: string) => ({ PK: pk, SK: "META" });
/** The shape of a plain `Counter` of the connector (domain/runtime.ts), so any reader parses it. */
const counterDefaults = (counterKey: string, now: Date) => ({ entity: "Counter", counterKey, kind: "COUNTER", createdAt: now.toISOString(), version: 1, synthetic: false });
const realDay = (instant: Date): string => instant.toISOString().slice(0, 10);

export type SlotPlan =
  | { readonly ok: true; readonly day: string; readonly ops: readonly TransactOp[] }
  | { readonly ok: false; readonly reason: "WORLDS_FULL" | "CONFIRMED_FULL" };

const QaLimits = z.object({ activeWorlds: z.int().min(0), confirmedPerDay: z.int().min(0) });

async function limitsOf(client: TableClient, scope: SlotScope): Promise<SlotLimits> {
  if (scope === "PUBLIC") return SIGNUP_WORLD_LIMITS;
  const parsed = QaLimits.safeParse(await client.get("Runtime", meta(QA_LIMITS_KEY)));
  return parsed.success ? parsed.data : SIGNUP_WORLD_LIMITS;
}

async function counterOf(client: TableClient, pk: string): Promise<number> {
  const value = (await client.get("Runtime", meta(pk)))?.[SLOT_COUNTER];
  return typeof value === "number" ? value : 0;
}

/** The `yymmdd` of today and of the six days before it. */
export function activeWindow(now: Date): string[] {
  return Array.from({ length: ACTIVE_WINDOW_DAYS }, (_unused, back) => generationDateTag(new Date(now.getTime() - back * DAY_MS)));
}

/**
 * Reads the counters and plans the slot: the two increments to put in the caller's transaction, or why
 * there is no room. Nothing is written here.
 */
export async function planSlot(client: TableClient, scope: SlotScope, now: Date): Promise<SlotPlan> {
  const limits = await limitsOf(client, scope);
  const [today = "", ...before] = activeWindow(now);
  const previous = await Promise.all(before.map((day) => counterOf(client, worldsDayKey(scope, day))));
  const todayCount = await counterOf(client, worldsDayKey(scope, today));
  const others = previous.reduce((sum, value) => sum + value, 0);
  if (others + todayCount >= limits.activeWorlds) return { ok: false, reason: "WORLDS_FULL" };
  const confirmedKey = confirmedDayKey(scope, realDay(now));
  if ((await counterOf(client, confirmedKey)) >= limits.confirmedPerDay) return { ok: false, reason: "CONFIRMED_FULL" };

  const nowSeconds = Math.floor(now.getTime() / 1000);
  const endOfDay = Math.floor(Date.parse(`${realDay(now)}T00:00:00.000Z`) / 1000) + 86_400;
  const ops: TransactOp[] = [
    {
      op: "increment",
      table: "Runtime",
      key: meta(worldsDayKey(scope, today)),
      attribute: SLOT_COUNTER,
      by: 1,
      max: limits.activeWorlds - others,
      defaults: { ...counterDefaults(worldsDayKey(scope, today), now), expiresAt: nowSeconds + WORLDS_TTL_SECONDS },
    },
    {
      op: "increment",
      table: "Runtime",
      key: meta(confirmedKey),
      attribute: SLOT_COUNTER,
      by: 1,
      max: limits.confirmedPerDay,
      defaults: { ...counterDefaults(confirmedKey, now), expiresAt: endOfDay + CONFIRMED_TTL_AFTER_DAY_SECONDS },
    },
  ];
  return { ok: true, day: today, ops };
}

/** The active sign-up worlds of a scope right now (the sum of the window). */
export async function activeWorlds(client: TableClient, scope: SlotScope, now: Date): Promise<number> {
  const counts = await Promise.all(activeWindow(now).map((day) => counterOf(client, worldsDayKey(scope, day))));
  return counts.reduce((sum, value) => sum + value, 0);
}

/** `guest.capsOverride` of the QA seam: the limits of the QA scope only, never the public ones. */
export async function setQaSlotLimits(client: TableClient, limits: SlotLimits, now: Date): Promise<void> {
  const parsed = QaLimits.parse(limits);
  const item: Item = { ...meta(QA_LIMITS_KEY), entity: "QaSlotLimits", ...parsed, updatedAt: now.toISOString(), expiresAt: Math.floor(now.getTime() / 1000) + WORLDS_TTL_SECONDS };
  await client.put("Runtime", item);
}

// ---- guest.retryWorld: once a minute ---------------------------------------------------------------

/** One retry of the world per guest and real minute (`docs/landing-spec.md` §7.6). */
export const RETRY_WINDOW_SECONDS = 60;

export const retryCounterKey = (userId: string, now: Date): string => `COUNTER#GUESTRETRY#${userId}#${now.toISOString().slice(0, 16)}`;

/** `true` when this is the guest's first retry of the minute; the counter lives two minutes. */
export async function claimRetry(runtime: Pick<RuntimePort, "reserve">, userId: string, now: Date): Promise<boolean> {
  const result = await runtime.reserve([{ counterKey: retryCounterKey(userId, now), kind: "COUNTER", by: 1, max: 1, ttlSeconds: 2 * RETRY_WINDOW_SECONDS }]);
  return result.ok;
}

/** Seconds until the next minute, when a refused retry may try again. */
export function retryAfterSeconds(now: Date): number {
  return RETRY_WINDOW_SECONDS - now.getUTCSeconds();
}
