// What a SCHEDULED timer needs from EventBridge Scheduler in its world right now (ADR-0004,
// docs/architecture.md §8), as pure functions:
//
//   PAUSED world    no schedule: the clock dispatches what falls due when it moves (clock/advance.ts);
//                   a timer that is already due when it is armed is dispatched at once (`CLOCK`), so a
//                   paused world never waits on a due timer nobody will send
//   RUNNING world   `dueAtReal = dueAtSim − offsetMs`; already due (`dueAtReal ≤ now`) → dispatched at
//                   once (`SCHEDULER`); due within the horizon (one real hour, never past
//                   `runningUntilReal`) → one schedule `at(dueAtReal)`, also when it is under 20 s away
//                   (the FIFO queue admits no per-message delay, the Scheduler admits seconds; the
//                   worker re-evaluates `dueAtSim` when it arrives); later → none until a resync
//
// Schedule names are `tm-<w>-<32 hex>` (≤ 64): `w` is the world letter the IAM fence of QA reads
// (`d` demo, `g` guest, `q` QA, `e` evaluation) and the hash covers the world and the whole timer
// reference, since timer ids repeat across orders and cases (`TIMER#CASE_TIMEOUT#PRIMARY`).
import { type TimerFiredBy, ispKindOfClock } from "@cuadrilla/shared";
import { timerRefKey } from "../connector/keys";
import type { TimerRef } from "../connector/ports";
import { sha256Hex } from "../lib/crypto";
import { type WorldClockInput, WorldClockTime, isRunning, simNowOf } from "../lib/clock";

/** A RUNNING world schedules what falls due within this many real milliseconds. */
export const SCHEDULE_HORIZON_MS = 60 * 60_000;

/** Below this, a schedule is still created (docs/architecture.md §8); kept as a named bound for tests. */
export const SHORT_SCHEDULE_MS = 20_000;

export const SCHEDULE_NAME_MAX = 64;
const NAME_HASH_CHARS = 32;

export type WorldLetter = "d" | "g" | "q" | "e";

export function worldLetter(clockId: string): WorldLetter {
  switch (ispKindOfClock(clockId)) {
    case "DEMO":
      return "d";
    case "GUEST":
      return "g";
    case "QA":
      return "q";
    case "EVAL":
      return "e";
  }
}

/** `tm-<w>-<32 hex>`: one name per timer of a world. */
export function scheduleNameOf(clockId: string, ref: TimerRef): string {
  const name = `tm-${worldLetter(clockId)}-${sha256Hex(`${clockId}|${timerRefKey(ref)}`).slice(0, NAME_HASH_CHARS)}`;
  if (name.length > SCHEDULE_NAME_MAX) throw new RangeError(`schedule name ${name} is longer than ${SCHEDULE_NAME_MAX}`);
  return name;
}

/** `at(yyyy-mm-ddThh:mm:ss)` in UTC; a fraction of a second rounds up, so a schedule never fires early. */
export function atExpression(at: Date): string {
  const ms = at.getTime();
  if (Number.isNaN(ms)) throw new RangeError("a schedule needs a valid instant");
  return `at(${new Date(Math.ceil(ms / 1000) * 1000).toISOString().slice(0, 19)})`;
}

export type SchedulePlan =
  /** Nothing to do now: a paused world, or due past the horizon of a running one. */
  | { readonly kind: "NONE" }
  /** One schedule at this real instant. */
  | { readonly kind: "SCHEDULE"; readonly at: Date }
  /** Already due in its world: dispatched now. */
  | { readonly kind: "DIRECT"; readonly firedBy: Extract<TimerFiredBy, "SCHEDULER" | "CLOCK"> };

/** What a SCHEDULED timer due at `dueAtSim` needs in a world whose clock is `clock`, at `realNowMs`. */
export function schedulePlan(dueAtSim: string, clock: WorldClockInput, realNowMs: number): SchedulePlan {
  const due = Date.parse(dueAtSim);
  if (Number.isNaN(due)) throw new RangeError(`invalid dueAtSim ${dueAtSim}`);
  if (!isRunning(clock, realNowMs)) {
    return due <= simNowOf(clock, realNowMs).getTime() ? { kind: "DIRECT", firedBy: "CLOCK" } : { kind: "NONE" };
  }
  const time = WorldClockTime.parse(clock);
  const dueAtReal = due - time.offsetMs;
  if (dueAtReal <= realNowMs) return { kind: "DIRECT", firedBy: "SCHEDULER" };
  const runningEnd = time.runningUntilReal === undefined ? Number.POSITIVE_INFINITY : Date.parse(time.runningUntilReal);
  // Past the end of the live window the world is paused again: the timer waits for the clock.
  if (dueAtReal > Math.min(realNowMs + SCHEDULE_HORIZON_MS, runningEnd)) return { kind: "NONE" };
  return { kind: "SCHEDULE", at: new Date(dueAtReal) };
}
