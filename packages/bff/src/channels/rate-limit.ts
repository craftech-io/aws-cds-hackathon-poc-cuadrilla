// Messages per identity and hour (docs/architecture.md §5 and §13, FL-083, FL-098): two counters in
// `Runtime`, reserved together and all or nothing before anything else is spent on the message.
//
//   RATE#<clockId>#<hash>#<simHour>        business limit, per simulated hour of the world:
//                                          `IspSettings.rateLimitPerHour`; "+1 h" opens a new window
//   RATE#<clockId>#<hash>#REAL#<realHour>  anti-abuse limit, per real hour:
//                                          `simulatorCaps.messagesPerRealHourPerIdentity`, never above
//                                          `rateLimitPerHour`; "+1 h" of the demo clock never resets it
//
// A message over either limit is not counted (the reservation changes nothing), gets the fixed
// answer and `DENY RATE_LIMIT` from the caller, and never reaches a turn. `<hash>` is the keyed hash
// of the sender's phone, never the phone. Resetting a guest world or jumping to a scene deletes the
// simulated-hour counters and keeps the real-hour ones (docs/architecture.md §8).
import { z } from "zod";
import { ClockId } from "@cuadrilla/shared";
import { COUNTER_KEYS, hourKey } from "../connector/keys";
import type { CounterReservation, RuntimePort } from "../connector/ports-runtime";
import { HexHash } from "../domain/common";

/** Rule id the caller audits a denial with (`AuditLog DENY RATE_LIMIT`). */
export const RATE_LIMIT_RULE = "RATE_LIMIT";

/** Per identity and hour when the world's settings carry neither limit (docs/seed-spec.md §4). */
export const DEFAULT_MESSAGES_PER_HOUR = 20;

const Limit = z.number().int().positive();

/** The part of `IspSettings` that limits messages; other settings are ignored. */
export const RateLimitSettings = z.object({
  rateLimitPerHour: Limit.optional(),
  simulatorCaps: z.object({ messagesPerRealHourPerIdentity: Limit.optional() }).optional(),
});
export type RateLimitSettings = z.infer<typeof RateLimitSettings>;

export interface RateLimits {
  readonly perSimHour: number;
  readonly perRealHour: number;
}

/**
 * The two limits of a world. Without `rateLimitPerHour` both windows use the real-hour cap of the
 * simulator (20 per identity in guest worlds); with it, it bounds the real hour too, so a world set
 * to 3 per hour cannot send a fourth message by moving its clock forward (`SC-12/7`).
 */
export function rateLimitsOf(settings: unknown): RateLimits {
  const parsed = RateLimitSettings.safeParse(settings ?? {});
  const value = parsed.success ? parsed.data : {};
  const perIdentity = value.simulatorCaps?.messagesPerRealHourPerIdentity;
  const perSimHour = value.rateLimitPerHour ?? perIdentity ?? DEFAULT_MESSAGES_PER_HOUR;
  const perRealHour = Math.min(perIdentity ?? Number.POSITIVE_INFINITY, value.rateLimitPerHour ?? Number.POSITIVE_INFINITY);
  return { perSimHour, perRealHour: Number.isFinite(perRealHour) ? perRealHour : DEFAULT_MESSAGES_PER_HOUR };
}

export type RateWindow = "SIM_HOUR" | "REAL_HOUR";

export interface RateAdmissionInput {
  readonly clockId: string;
  /** Keyed hash of the sender's address (`phoneHash`). */
  readonly addressHash: string;
  /** The world's simulated "now" (its clock, ADR-0010). */
  readonly simNow: Date;
  /** Real "now": the anti-abuse window. */
  readonly realNow: Date;
  /** `Isps/SETTINGS` of the world (or just its rate fields). */
  readonly settings: unknown;
}

export type RateAdmission =
  | { readonly ok: true; readonly counts: { readonly simHour: number; readonly realHour: number }; readonly limits: RateLimits }
  | {
      readonly ok: false;
      readonly ruleId: typeof RATE_LIMIT_RULE;
      readonly window: RateWindow;
      readonly limit: number;
      /** When the window that blocked opens again: a simulated instant for `SIM_HOUR`, a real one for `REAL_HOUR`. */
      readonly resetsAt: string;
    };

function nextHour(instant: Date): string {
  const start = new Date(instant.getTime());
  start.setUTCMinutes(0, 0, 0);
  return new Date(start.getTime() + 3_600_000).toISOString();
}

function validInstant(name: string, instant: Date): Date {
  if (Number.isNaN(instant.getTime())) throw new RangeError(`${name} is not a valid instant`);
  return instant;
}

/** The two reservations of one message (exported for the console gauge and the tests). */
export function rateReservations(input: RateAdmissionInput): { readonly sim: CounterReservation; readonly real: CounterReservation; readonly limits: RateLimits } {
  const clockId = ClockId.parse(input.clockId);
  const addressHash = HexHash.parse(input.addressHash);
  const limits = rateLimitsOf(input.settings);
  const simHour = hourKey(validInstant("simNow", input.simNow));
  const realHour = hourKey(validInstant("realNow", input.realNow));
  return {
    sim: { counterKey: COUNTER_KEYS.rateSim(clockId, addressHash, simHour), kind: "RATE", by: 1, max: limits.perSimHour },
    real: { counterKey: COUNTER_KEYS.rateReal(clockId, addressHash, realHour), kind: "RATE", by: 1, max: limits.perRealHour },
    limits,
  };
}

/** Counts one message of an identity in both windows, or denies it without counting. */
export async function admitMessage(runtime: Pick<RuntimePort, "reserve">, input: RateAdmissionInput): Promise<RateAdmission> {
  const { sim, real, limits } = rateReservations(input);
  const result = await runtime.reserve([sim, real]);
  if (result.ok) return { ok: true, counts: { simHour: result.values[0] ?? 1, realHour: result.values[1] ?? 1 }, limits };
  const window: RateWindow = result.blockedBy === real.counterKey ? "REAL_HOUR" : "SIM_HOUR";
  return window === "REAL_HOUR"
    ? { ok: false, ruleId: RATE_LIMIT_RULE, window, limit: limits.perRealHour, resetsAt: nextHour(input.realNow) }
    : { ok: false, ruleId: RATE_LIMIT_RULE, window, limit: limits.perSimHour, resetsAt: nextHour(input.simNow) };
}
