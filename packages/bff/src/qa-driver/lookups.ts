// Where the rows an action's input names live (guard.ts `GuardLookups`), read from the connector: the
// stage's tables in the Lambda, the memory connector in the tests. The guard never trusts the clock an
// input pairs an id with; it reads the row's own.
import type { Connector } from "../connector/ports";
import { parseTimerRefKey } from "../connector/keys";
import type { GuardLookups } from "./guard";

export function connectorLookups(data: Pick<Connector, "isps" | "workOrders" | "people" | "cases" | "timers">, procedureKind: GuardLookups["procedureKind"]): GuardLookups {
  return {
    ispKindOf: async (ispId) => (await data.isps.getIsp(ispId))?.kind,
    clockOfWorkOrder: async (id) => (await data.workOrders.getWorkOrder(id))?.clockId,
    clockOfPerson: async (id) => (await data.people.getPerson(id))?.clockId,
    clockOfCase: async (id) => (await data.cases.getCase(id))?.clockId,
    async clockOfTimer(key) {
      const ref = parseTimerRefKey(key);
      return ref === undefined ? undefined : (await data.timers.getTimer(ref))?.clockId;
    },
    procedureKind,
  };
}
