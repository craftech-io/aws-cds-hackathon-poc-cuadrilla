// The visible names of field crews ("Equipo Norte 3"): `people.roster.get` names its crew, and no other
// console procedure does. Asked once per set of crews; a crew whose roster cannot be read keeps its
// fallback label, so the list never waits on it.
import { dataOf, useRemote } from "../../lib/use-remote";
import { CrewName, ORDERS_PROCEDURES } from "./orders-model";
import { useConsoleApi } from "./use-field-data";

export function useCrewNames(crewIds: readonly string[]): Readonly<Record<string, string>> {
  const api = useConsoleApi();
  const key = crewIds.length === 0 ? null : `crews:${[...crewIds].sort().join(",")}`;
  const remote = useRemote(key, async (signal) => {
    const found = await Promise.all(
      crewIds.map((crewId) =>
        api.query(ORDERS_PROCEDURES.roster, { crewId }, CrewName, signal).then(
          (crew) => [crew.crewId, crew.crewName] as const,
          () => undefined,
        ),
      ),
    );
    return Object.fromEntries(found.filter((entry) => entry !== undefined));
  });
  return dataOf(remote.state) ?? {};
}
