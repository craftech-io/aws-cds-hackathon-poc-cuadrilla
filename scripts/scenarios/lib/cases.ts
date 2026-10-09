// The cases a step of the ladder or the bridge reads (docs/test-plan.md §4.5 `SC-06`, `SC-07`, `SC-09`,
// `SC-10`): the case of an order once the worker opened it (a `case` preset and `case.open` run the real
// `open_case` in the installer's queue), with its ladder and its timers, and the messages its people got.
import type { Case } from "../../../packages/bff/src/domain/cases";
import type { QaSnapshot } from "../../../packages/bff/src/qa-driver/snapshot";
import { orderIn } from "./assist";
import type { ScenarioContext } from "./context";
import { WAITS } from "./eventually";
import { type World, op } from "./world";

/** The models' crew of `wo-24817` … `wo-24822` (`crew-n3`): on duty, backup and the zone chief. */
export const CREW_N3 = { primary: "sup-adriana", secondary: "sup-hector", zoneChief: "zc-marisol" } as const;

/** The order's case (of `reason`, if given) once it exists. */
export async function caseOn(ctx: ScenarioContext, w: World, key: string, reason?: string): Promise<Case> {
  const target = op(w, key);
  return ctx.eventually(
    `the case of ${key}`,
    async () => {
      const snapshot = await ctx.snapshot({ clockId: w.clockId, workOrderIds: [target.workOrderId] });
      return orderIn(snapshot, target.workOrderId).cases.find((entry) => reason === undefined || entry.reason === reason);
    },
    WAITS.settleSec,
    3,
  );
}

/** A settled snapshot of the order, its case (with its timers) and the people named. */
export async function caseSnapshot(ctx: ScenarioContext, w: World, key: string, caseId: string, personIds: readonly string[]): Promise<QaSnapshot> {
  const target = op(w, key);
  return ctx.settled({ clockId: w.clockId }, { clockId: w.clockId, workOrderIds: [target.workOrderId], personIds: [target.installerId, ...personIds], caseIds: [caseId] });
}

export function caseIn(snapshot: QaSnapshot, caseId: string): Case {
  const found = snapshot.cases.find((entry) => entry.caseId === caseId);
  if (found === undefined) throw new RangeError(`the snapshot has no case ${caseId}`);
  return found;
}

export function caseTimersIn(snapshot: QaSnapshot, caseId: string) {
  return snapshot.caseTimers.find((entry) => entry.caseId === caseId)?.timers ?? [];
}
