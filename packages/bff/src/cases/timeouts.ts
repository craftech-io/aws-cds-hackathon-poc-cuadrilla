// `TIMER#CASE_TIMEOUT#<caseId>-<rung>` (docs/architecture.md §8, ADR-0004): the wait of a notified
// rung is a timer of the world clock, never a Step Functions wait. It carries the `rungVersion` it was
// armed with, so a timeout that fires after the case moved (a tap, another timeout) is ignored. The
// wait is `caseTimeoutSec` (600) unless the world is in demo mode **and** its clock is RUNNING, when it
// is `demoCaseTimeoutSec` (60): a paused world never waits 60 simulated seconds by surprise.
import type { Rung } from "@cuadrilla/shared";
import type { TimerRef } from "../connector/ports";
import type { IspSettings } from "../domain/isps";
import { effectiveMode } from "../lib/clock";
import type { CaseDeps } from "./ports";

/** Timer id of a rung's wait: `<caseId>-<rung>` (letters, digits and dashes; fits a schedule name). */
export function caseTimeoutId(caseId: string, rung: Rung): string {
  return `${caseId}-${rung}`;
}

export function caseTimeoutRef(caseId: string, rung: Rung): TimerRef {
  return { home: { kind: "CASE", id: caseId }, kind: "CASE_TIMEOUT", timerId: caseTimeoutId(caseId, rung) };
}

/** Seconds a notified rung waits, given the world's settings and whether its clock runs. */
export function rungWaitSeconds(settings: Pick<IspSettings, "caseTimeoutSec" | "demoMode" | "demoCaseTimeoutSec">, clockRunning: boolean): number {
  return settings.demoMode && clockRunning ? settings.demoCaseTimeoutSec : settings.caseTimeoutSec;
}

/** Whether the world's clock is RUNNING right now (an expired running window reads as paused). */
export async function clockRunning(deps: Pick<CaseDeps, "connector" | "realClock">, clockId: string): Promise<boolean> {
  const clock = await deps.connector.runtime.getClock(clockId);
  if (clock === undefined) return false;
  return effectiveMode(clock, (await deps.realClock.now()).getTime()) === "RUNNING";
}

export interface ArmRungTimeout {
  readonly caseId: string;
  readonly clockId: string;
  readonly ispId: string;
  readonly rung: Rung;
  readonly rungVersion: number;
  /** Simulated instant the rung was notified. */
  readonly notifiedAtSim: string;
}

/** Arms the wait of a notified rung; returns its due instant. */
export async function armRungTimeout(deps: Pick<CaseDeps, "connector" | "realClock" | "timers">, input: ArmRungTimeout): Promise<string> {
  const settings = await deps.connector.isps.getSettings(input.ispId);
  const seconds = settings === undefined ? 600 : rungWaitSeconds(settings, await clockRunning(deps, input.clockId));
  const dueAtSim = new Date(Date.parse(input.notifiedAtSim) + seconds * 1000).toISOString();
  await deps.timers.arm({
    home: { kind: "CASE", id: input.caseId },
    kind: "CASE_TIMEOUT",
    timerId: caseTimeoutId(input.caseId, input.rung),
    clockId: input.clockId,
    dueAtSim,
    reason: `wait of rung ${input.rung}`,
    payload: { caseId: input.caseId, rung: input.rung, rungVersion: input.rungVersion },
  });
  return dueAtSim;
}

/** Cancels the waits of a case that are still scheduled (a take, a decline, a close). */
export async function cancelRungTimeouts(deps: Pick<CaseDeps, "connector" | "timers">, caseId: string, reason: string): Promise<void> {
  const timers = await deps.connector.timers.listTimers({ kind: "CASE", id: caseId });
  for (const timer of timers) {
    if (timer.kind !== "CASE_TIMEOUT" || timer.status !== "SCHEDULED") continue;
    await deps.timers.cancel({ home: timer.home, kind: timer.kind, timerId: timer.timerId }, reason);
  }
}
