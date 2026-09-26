// `Isps` repository: operator, settings, zones, crews, rosters (with history) and console users (the
// `SUB#<sub>` index is the only source of a token's operator and role, docs/architecture.md §10).
import { ConsoleUser, Crew, Isp, IspSettings, ShiftRoster, Zone } from "../../domain/isps";
import { CREW_PREFIX, USER_PREFIX, ZONE_PREFIX, cognitoSubKey, ispPartition, rosterPrefix } from "../keys";
import type { IspsPort } from "../ports-data";
import { getEntity, listPrefix, parseRows, patchEntity, requireEntity, upsertEntity, withHistory, type RepoContext } from "./repo";

const TABLE = "Isps";

export function ispsRepo(ctx: RepoContext): IspsPort {
  const { client } = ctx;
  const requireIsp = (ispId: string): Promise<Isp> => requireEntity(ctx, Isp, "Isp", { ispId }, `operator ${ispId}`);
  const requireSettings = (ispId: string): Promise<IspSettings> => requireEntity(ctx, IspSettings, "IspSettings", { ispId }, `settings of ${ispId}`);
  const requireUser = (ispId: string, userId: string): Promise<ConsoleUser> => requireEntity(ctx, ConsoleUser, "ConsoleUser", { ispId, userId }, `console user ${userId}`);

  const findUserBySub: IspsPort["findUserBySub"] = async (sub) => {
    if (sub === "") return undefined;
    const rows = await client.query(TABLE, { index: "GSI1", hashValue: cognitoSubKey(sub), limit: 2 });
    const users = parseRows(ConsoleUser, rows, TABLE);
    // Two rows with one `sub` would let a token pick its operator: refuse instead.
    return users.length === 1 ? users[0] : undefined;
  };

  const listUsersBySub: IspsPort["listUsersBySub"] = async (sub, limit) => {
    if (sub === "") return [];
    return parseRows(ConsoleUser, await client.query(TABLE, { index: "GSI1", hashValue: cognitoSubKey(sub), limit }), TABLE);
  };

  return {
    getIsp: (ispId) => getEntity(ctx, Isp, "Isp", { ispId }),
    putIsp: (isp) => upsertEntity(ctx, Isp, "Isp", isp),
    async setDisplayName(ispId, displayName) {
      const current = await requireIsp(ispId);
      return patchEntity(ctx, Isp, "Isp", current, { displayName });
    },

    getSettings: (ispId) => getEntity(ctx, IspSettings, "IspSettings", { ispId }),
    putSettings: (settings) => upsertEntity(ctx, IspSettings, "IspSettings", settings),
    async updateSettings(ispId, patch, options = {}) {
      const current = await requireSettings(ispId);
      return patchEntity(ctx, IspSettings, "IspSettings", current, { ...patch }, { ifVersion: options.expectedVersion ?? current.version });
    },
    async setTemplateStatus(ispId, name, status, transition) {
      const current = await requireSettings(ispId);
      const history = withHistory(ctx, current.history, `templateStatus.${name}`, current.templateStatus[name], status, transition);
      return patchEntity(ctx, IspSettings, "IspSettings", current, { templateStatus: { ...current.templateStatus, [name]: status }, history });
    },

    getZone: (ispId, zoneId) => getEntity(ctx, Zone, "Zone", { ispId, zoneId }),
    listZones: (ispId) => listPrefix(ctx, TABLE, Zone, ispPartition(ispId), ZONE_PREFIX),
    putZone: (zone) => upsertEntity(ctx, Zone, "Zone", zone),
    getCrew: (ispId, crewId) => getEntity(ctx, Crew, "Crew", { ispId, crewId }),
    listCrews: (ispId) => listPrefix(ctx, TABLE, Crew, ispPartition(ispId), CREW_PREFIX),
    putCrew: (crew) => upsertEntity(ctx, Crew, "Crew", crew),

    getRoster: (ispId, crewId, date) => getEntity(ctx, ShiftRoster, "ShiftRoster", { ispId, crewId, date }),
    listRosters: (ispId, crewId) => listPrefix(ctx, TABLE, ShiftRoster, ispPartition(ispId), rosterPrefix(crewId)),
    async setRoster(roster, transition) {
      const current = await getEntity(ctx, ShiftRoster, "ShiftRoster", roster);
      if (current === undefined) {
        const history = withHistory(ctx, [], "roster", undefined, `${roster.primaryId}/${roster.secondaryId}`, transition);
        return upsertEntity(ctx, ShiftRoster, "ShiftRoster", { ...roster, history });
      }
      const history = withHistory(ctx, current.history, "roster", `${current.primaryId}/${current.secondaryId}`, `${roster.primaryId}/${roster.secondaryId}`, transition);
      return patchEntity(ctx, ShiftRoster, "ShiftRoster", current, {
        primaryId: roster.primaryId,
        secondaryId: roster.secondaryId,
        startsAtSim: roster.startsAtSim,
        endsAtSim: roster.endsAtSim,
        history,
      });
    },

    getUser: (ispId, userId) => getEntity(ctx, ConsoleUser, "ConsoleUser", { ispId, userId }),
    listUsers: (ispId) => listPrefix(ctx, TABLE, ConsoleUser, ispPartition(ispId), USER_PREFIX),
    async putUser(user) {
      const current = await getEntity(ctx, ConsoleUser, "ConsoleUser", user);
      const cognitoSub = user.cognitoSub !== undefined && user.cognitoSub !== "" ? user.cognitoSub : (current?.cognitoSub ?? "");
      return upsertEntity(ctx, ConsoleUser, "ConsoleUser", { ...user, cognitoSub });
    },
    findUserBySub,
    listUsersBySub,
    async findBySub(ispId, sub) {
      const user = await findUserBySub(sub);
      return user === undefined || user.ispId !== ispId ? undefined : { userId: user.userId, active: user.active };
    },
    async setCognitoSub(ispId, userId, sub) {
      const current = await requireUser(ispId, userId);
      return patchEntity(ctx, ConsoleUser, "ConsoleUser", current, { cognitoSub: sub });
    },
    async setUserActive(ispId, userId, active) {
      const current = await requireUser(ispId, userId);
      return patchEntity(ctx, ConsoleUser, "ConsoleUser", current, { active });
    },
  };
}
