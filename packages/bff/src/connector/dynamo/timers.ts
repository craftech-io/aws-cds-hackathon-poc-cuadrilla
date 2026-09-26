// Timers repository (docs/architecture.md §8): `TIMER#<kind>#<timerId>` in the partition of its home
// (order, case or person). While `SCHEDULED` a timer carries `clockDueKey`, so the world clock finds
// what is due in `WorkOrders GSI3` and `Cases GSI4`; any other status drops it from the index. Every
// transition is conditional on the version the caller read: a stale timer never fires twice.
import { ConnectorError } from "@cuadrilla/shared";
import { Person } from "../../domain/people";
import { Timer } from "../../domain/timers";
import { timerTableOf } from "../codecs";
import { TIMER_PREFIX, clockDueKey, ispKindKey, timerHomePartition, timerKey } from "../keys";
import type { TimerRef, TimersPort } from "../ports-data";
import { createEntity, getEntity, listPrefix, parseRows, patchEntity, requireEntity, type RepoContext } from "./repo";

const DUE_INDEXES = [
  { table: "WorkOrders", index: "GSI3" },
  { table: "Cases", index: "GSI4" },
] as const;

const byDue = (a: Timer, b: Timer): number => (a.dueAtSim < b.dueAtSim ? -1 : a.dueAtSim > b.dueAtSim ? 1 : a.timerId < b.timerId ? -1 : 1);

export function timersRepo(ctx: RepoContext): TimersPort {
  const { client } = ctx;
  const requireTimer = (ref: TimerRef): Promise<Timer> => requireEntity(ctx, Timer, "Timer", ref, `timer ${ref.kind}#${ref.timerId}`);

  return {
    createTimer: (timer) => createEntity(ctx, Timer, "Timer", timer),
    getTimer: (ref) => getEntity(ctx, Timer, "Timer", ref),
    listTimers: (home) => listPrefix(ctx, timerTableOf(home), Timer, timerHomePartition(home), TIMER_PREFIX),

    async setTimerStatus(ref, change, expectedVersion) {
      const current = await requireTimer(ref);
      return patchEntity(ctx, Timer, "Timer", current, { ...change }, { ifVersion: expectedVersion });
    },

    async rescheduleTimer(ref, dueAtSim, expectedVersion, options = {}) {
      const current = await requireTimer(ref);
      return patchEntity(
        ctx,
        Timer,
        "Timer",
        current,
        { status: "SCHEDULED", dueAtSim, firedBy: null, firedAtSim: null, payload: options.payload, reason: options.reason },
        { ifVersion: expectedVersion },
      );
    },

    async setScheduleName(ref, scheduleName, expectedVersion) {
      const current = await requireTimer(ref);
      return patchEntity(ctx, Timer, "Timer", current, { scheduleName }, { ifVersion: expectedVersion });
    },

    async deleteTimer(ref) {
      await client.delete(timerTableOf(ref.home), timerKey(ref.home, ref.kind, ref.timerId));
    },

    async listDueTimers(clockId, uptoSim, limit) {
      const range = uptoSim === undefined ? undefined : { lte: new Date(Date.parse(uptoSim)).toISOString() };
      const pages = await Promise.all(
        DUE_INDEXES.map(async ({ table, index }) =>
          parseRows(Timer, await client.query(table, { index, hashValue: clockDueKey(clockId), ...(range ? { range } : {}), ...(limit === undefined ? {} : { limit }) }), table),
        ),
      );
      const due = pages.flat().sort(byDue);
      return limit === undefined ? due : due.slice(0, limit);
    },

    // People carry no due index (docs/architecture.md §5): read the timers of the operator's installers.
    async listDuePersonTimers(ispId, uptoSim) {
      if (uptoSim !== undefined && Number.isNaN(Date.parse(uptoSim))) throw new ConnectorError("VALIDATION", "invalid uptoSim", "People");
      const installers = parseRows(Person, await client.query("People", { index: "GSI2", hashValue: ispKindKey(ispId, "INSTALLER") }), "People");
      const timers = await Promise.all(installers.map((person) => listPrefix(ctx, "People", Timer, timerHomePartition({ kind: "PERSON", id: person.personId }), TIMER_PREFIX)));
      const limit = uptoSim === undefined ? undefined : Date.parse(uptoSim);
      return timers
        .flat()
        .filter((timer) => timer.status === "SCHEDULED" && (limit === undefined || Date.parse(timer.dueAtSim) <= limit))
        .sort(byDue);
    },
  };
}
