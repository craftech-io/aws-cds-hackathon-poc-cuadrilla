// `installer.settle` and `world.settle` (docs/tool-catalog.md, docs/test-plan.md §4.3 "Quiescencia"): the
// runner asserts a negative or an exact count only after the world went quiet and stayed quiet.
//
//   installer.settle  `INSTSTATE#<installer>.inFlight` empty, no `TIMER#` of the world due and still
//                     SCHEDULED, no email of the world without its first SES event
//   world.settle      the same with `WORLDSTATE#<clock>.inFlight` (unknown numbers, foreign events and the
//                     supervisors' keywords have no installer)
//
// Quiet is held for `holdSec` (10 s by default): a follow-up the worker enqueues right after its event is
// done (a turn after a transcription, the ladder's next rung) is caught. Past the timeout the action fails
// with `NOT_SETTLED` and what was pending, never a silent pass.
import { ToolError } from "@cuadrilla/shared";
import type { Connector } from "../connector/ports";
import { simNowOf } from "../lib/clock";
import { type PendingItem, worldQuiescence } from "../worker/settle";
import { QA_REASON } from "./contract";

export interface SettleDeps {
  readonly data: Pick<Connector, "worlds" | "timers" | "runtime">;
  /** Real time. */
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  /** Between two reads. */
  readonly pollMs?: number;
}

export interface Settled {
  readonly settled: true;
  readonly waitedMs: number;
  /** Polls that found the world busy before it went quiet. */
  readonly busyPolls: number;
}

const POLL_MS = 2_000;

/** What keeps the world (and, if named, the installer) busy now. */
export async function pendingOf(deps: SettleDeps, target: { readonly clockId: string; readonly installerId?: string }): Promise<PendingItem[]> {
  const clock = await deps.data.runtime.getClock(target.clockId);
  if (clock === undefined) throw new ToolError("NOT_FOUND", `the world ${target.clockId} does not exist`);
  const simNow = simNowOf(clock, deps.now().getTime()).toISOString();
  const world = await worldQuiescence(deps.data, target.clockId, simNow);
  // The world's own in-flight events count only for world.settle; installer.settle reads the installer's.
  const pending = target.installerId === undefined ? [...world.pending] : world.pending.filter((item) => item.kind === "MAIL" || item.detail.startsWith("timer:"));
  if (target.installerId !== undefined) {
    const state = await deps.data.worlds.getInstallerState(target.installerId);
    pending.push(...(state?.inFlight ?? []).map((eventId): PendingItem => ({ kind: "EVENT", detail: eventId })));
  }
  return pending;
}

/** Waits until nothing is pending for `holdSec` in a row, or fails with what still was after `timeoutSec`. */
export async function settle(deps: SettleDeps, target: { readonly clockId: string; readonly installerId?: string; readonly timeoutSec: number; readonly holdSec: number }): Promise<Settled> {
  const started = deps.now().getTime();
  const deadline = started + target.timeoutSec * 1_000;
  const poll = deps.pollMs ?? POLL_MS;
  let quietSince: number | undefined;
  let busyPolls = 0;
  let last: PendingItem[] = [];
  for (;;) {
    last = await pendingOf(deps, target);
    const at = deps.now().getTime();
    if (last.length === 0) {
      quietSince ??= at;
      if (at - quietSince >= target.holdSec * 1_000) return { settled: true, waitedMs: at - started, busyPolls };
    } else {
      quietSince = undefined;
      busyPolls += 1;
    }
    if (at >= deadline) break;
    await deps.sleep(Math.min(poll, Math.max(1, deadline - at)));
  }
  const detail = last.slice(0, 5).map((item) => `${item.kind}:${item.detail}`).join(", ");
  throw new ToolError("UNAVAILABLE", `not settled after ${target.timeoutSec} s (pending: ${detail})`, QA_REASON.NOT_SETTLED);
}
