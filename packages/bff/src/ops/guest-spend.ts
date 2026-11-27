// The spend of one account of the own sign-up (ADR-0025 §3, infra/cost-caps.ts): `COSTUSD#GUESTUSER#<userId>`
// holds the micro-dollars the account ever spent, with no period and no TTL. Every turn, photo
// validation and second of audio reserves its estimate there (ops/cost-caps.ts, tier `GUEST_SPEND`);
// a turn then settles it to its priced cost, cache tokens included (turns/record.ts).
import { systemClock } from "../lib/clock";
import type { CapCounter, CostCapsDeps, GuestSignupCaps } from "./cost-caps";

/** Micro-dollars a reservation of `amount` of the resource takes from the account's spend. */
export function spendEstimate(resource: "turns" | "validations" | "transcribe", amount: number, caps: Pick<GuestSignupCaps, "spendEstimateMicroUsd">): number {
  const estimate = caps.spendEstimateMicroUsd;
  if (resource === "turns") return estimate.turn * amount;
  if (resource === "validations") return estimate.validation * amount;
  return estimate.transcribeSecond * amount;
}

/** `COSTUSD#GUESTUSER#<userId>`: what one account of the own sign-up ever spent, in micro-dollars. */
export const guestSpendKey = (userId: string): string => `COSTUSD#GUESTUSER#${userId}`;

/**
 * Settles the spend counter of a reservation to what the spend really cost (the turn's priced tokens,
 * cache included): adds `actual - estimate`, once per idempotency key. A spend that could not be priced
 * keeps its estimate.
 */
export async function settleSpend(deps: Pick<CostCapsDeps, "store" | "realClock">, reserved: readonly CapCounter[], actualMicroUsd: number | undefined, idempotencyKey: string): Promise<void> {
  const spend = reserved.find((counter) => counter.tier === "GUEST_SPEND" && counter.amount > 0);
  if (spend === undefined || actualMicroUsd === undefined) return;
  const delta = Math.max(0, Math.round(actualMicroUsd)) - spend.amount;
  if (delta === 0) return;
  const now = await (deps.realClock ?? systemClock).now();
  await deps.store.adjust(spend.key, delta, { idempotencyKey, nowIso: now.toISOString() });
}
