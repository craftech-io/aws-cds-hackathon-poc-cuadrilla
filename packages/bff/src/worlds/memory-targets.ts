// Who to purge from Memory for one past epoch of a world (docs/architecture.md §9.1 and §9.3): the
// actor of each installer in that epoch (`<installerId>-e<epoch>`) and the Harness sessions they may have
// had. Sessions are keyed digests (lib/crypto.ts `runtimeSessionId`) of an order with its session epoch,
// or of an installer's simulated day, so they are computed here from the world's orders and days with
// the `runtime-session` subkey; the Memory listing (`ListSessions`, when the role may) adds whatever
// else exists. An order's session epoch only goes up after a G1 block, so a few are enough.
import { addCalendarDays } from "@cuadrilla/shared";
import type { Connector } from "../connector/ports";
import { type SecretKey, runtimeSessionId } from "../lib/crypto";
import { actorIdOf } from "../turns/identity";
import type { PurgeTarget } from "./memory-purge";

/** Session epochs of an order tried for its sessions beyond the one it has now. */
export const SESSION_EPOCHS_TRIED = 4;
/** Simulated days around the world's start whose day sessions are computed. */
const DAYS_BEFORE = 1;
const DAYS_AFTER = 4;

export interface WorldMemoryScope {
  readonly clockId: string;
  /** The epoch whose actors go. */
  readonly epoch: number;
  readonly installerIds: readonly string[];
  readonly workOrders: ReadonlyArray<{ readonly workOrderId: string; readonly installerId: string; readonly sessionEpoch: number }>;
  /** Simulated calendar days (`YYYY-MM-DD`) of the world's day sessions. */
  readonly days: readonly string[];
}

/** The calendar days from one before `startDate` to four after it. */
export function daysAround(startDate: string): string[] {
  return Array.from({ length: DAYS_BEFORE + DAYS_AFTER + 1 }, (_unused, index) => addCalendarDays(startDate, index - DAYS_BEFORE));
}

/** Actors and computed sessions of the scope; without the subkey only the actors (their records still go). */
export function purgeTargetOf(scope: WorldMemoryScope, runtimeSessionKey: SecretKey | undefined): Omit<PurgeTarget, "startedAtReal"> {
  const installers = [...new Set(scope.installerIds)];
  const actorIds = installers.map((installerId) => actorIdOf(installerId, scope.epoch));
  const sessions: Array<{ actorId: string; sessionId: string }> = [];
  if (runtimeSessionKey !== undefined) {
    for (const order of scope.workOrders) {
      if (!installers.includes(order.installerId)) continue;
      const actorId = actorIdOf(order.installerId, scope.epoch);
      for (let sessionEpoch = 0; sessionEpoch <= Math.max(order.sessionEpoch, SESSION_EPOCHS_TRIED - 1); sessionEpoch += 1) {
        sessions.push({ actorId, sessionId: runtimeSessionId(runtimeSessionKey, { kind: "WORK_ORDER", workOrderId: order.workOrderId, clockId: scope.clockId, worldEpoch: scope.epoch, sessionEpoch }) });
      }
    }
    for (const installerId of installers) {
      for (const simDate of scope.days) {
        sessions.push({ actorId: actorIdOf(installerId, scope.epoch), sessionId: runtimeSessionId(runtimeSessionKey, { kind: "DAY", installerId, simDate, clockId: scope.clockId, worldEpoch: scope.epoch }) });
      }
    }
  }
  return { clockId: scope.clockId, epoch: scope.epoch, actorIds, sessions };
}

/**
 * The scope of a world's past epoch from what the connector holds now: the installers given (listed
 * before the reset deleted them) or the operator's, and the orders of the days around the world's start
 * (a reset rewrites the same order ids, so their sessions are the old epoch's with the old epoch number).
 */
export async function scopeOfWorld(
  data: Pick<Connector, "people" | "workOrders">,
  input: { readonly clockId: string; readonly ispId: string; readonly epoch: number; readonly startDate: string; readonly installerIds?: readonly string[] },
): Promise<WorldMemoryScope> {
  const installerIds = input.installerIds ?? (await data.people.listPeople(input.ispId, "INSTALLER")).map((person) => person.personId);
  const days = daysAround(input.startDate);
  const seen = new Map<string, { workOrderId: string; installerId: string; sessionEpoch: number }>();
  for (const day of days) {
    for (const order of await data.workOrders.listIspDay(input.ispId, day)) {
      if (order.clockId === input.clockId) seen.set(order.workOrderId, { workOrderId: order.workOrderId, installerId: order.installerId, sessionEpoch: order.sessionEpoch });
    }
  }
  return { clockId: input.clockId, epoch: input.epoch, installerIds, workOrders: [...seen.values()], days };
}
