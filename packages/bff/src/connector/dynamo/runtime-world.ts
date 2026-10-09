// `Runtime` repository, world state (docs/architecture.md §7, docs/architecture-integrations.md
// §4.4.1): in-flight events of an installer and of a world (string sets, ADD before `SendMessage`,
// DELETE when done), emails waiting for their first SES event, number leases of QA worlds, join
// codes and phone leases (bound in one transaction), simulator uploads, the single live world,
// tombstones, probes and the fault switches of `qa-*` worlds.
import { ConnectorError } from "@cuadrilla/shared";
import type { EntityName } from "../../domain/common";
import { RUNTIME_TTL_SECONDS, PENDING_MAIL_STALE_SECONDS } from "../../domain/runtime";
import { Faults, InstallerState, JoinCode, Lease, LiveWorld, PendingMail, PhoneLease, Probe, Tombstone, Upload, WorldSession, WorldState } from "../../domain/runtime-world";
import { LIVE_WORLD_KEY, MAIL_PREFIX, installerStateKey, joinCodeKey, leaseKey, pendingPartition, phoneLeaseKey, worldStateKey } from "../keys";
import type { WorldRuntimePort } from "../ports-runtime";
import { TTL_ATTRIBUTE, type Patch, type TransactOp } from "../table-client";
import {
  createEntity,
  entityRow,
  expiresIn,
  getEntity,
  isExpired,
  listPrefix,
  nowEpoch,
  nowIso,
  patchEntity,
  patchRow,
  retryOnConflict,
  upsertEntity,
  type RepoContext,
} from "./repo";

const TABLE = "Runtime";
// Reads and writes of a pending mail mark before a version conflict is final.
const CLOSE_PENDING_ATTEMPTS = 3;

/** Attributes a set-update default never writes: the key, the stamp of each call and the sets. */
const ROW_OWNED = new Set(["PK", "SK", "updatedAt", "inFlight", "phoneLeases"]);

function isConflict(error: unknown): boolean {
  return error instanceof ConnectorError && error.code === "CONFLICT";
}

export function worldRuntimeRepo(ctx: RepoContext): WorldRuntimePort {
  const { client } = ctx;
  const valid = <T extends { readonly expiresAt?: number | undefined }>(row: T | undefined): T | undefined => (row === undefined || isExpired(ctx, row.expiresAt) ? undefined : row);

  /**
   * Attributes a set update writes only when it creates the row (metadata, world scope, fields),
   * never the sets themselves: a defaulted empty list would make a later ADD fail on its type.
   */
  function defaults(entity: EntityName, schema: Parameters<typeof entityRow>[1], fields: object): Patch {
    const { item } = entityRow(ctx, schema, entity, fields);
    return Object.fromEntries(Object.entries(item).filter(([name]) => !ROW_OWNED.has(name)));
  }

  const installerDefaults = (installerId: string, clockId: string) => defaults("InstallerState", InstallerState, { installerId, clockId });
  const worldDefaults = (clockId: string) => defaults("WorldState", WorldState, { clockId });

  async function upsertInstaller(installerId: string, clockId: string, patch: Patch) {
    return retryOnConflict(3, async () => {
      const current = await getEntity(ctx, InstallerState, "InstallerState", { installerId });
      if (current === undefined) return createEntity(ctx, InstallerState, "InstallerState", { installerId, clockId, ...withoutNulls(patch) });
      return patchEntity(ctx, InstallerState, "InstallerState", current, patch);
    });
  }

  return {
    getInstallerState: (installerId) => getEntity(ctx, InstallerState, "InstallerState", { installerId }),
    getWorldState: (clockId) => getEntity(ctx, WorldState, "WorldState", { clockId }),

    async markInFlight(installerId, clockId, eventId) {
      const ops: TransactOp[] = [
        { op: "addToSet", table: TABLE, key: installerStateKey(installerId), attribute: "inFlight", values: [eventId], defaults: installerDefaults(installerId, clockId) },
        { op: "addToSet", table: TABLE, key: worldStateKey(clockId), attribute: "inFlight", values: [eventId], defaults: worldDefaults(clockId) },
      ];
      await client.transact(ops, nowIso(ctx));
    },
    async clearInFlight(installerId, clockId, eventId) {
      await client.removeFromSet(TABLE, installerStateKey(installerId), "inFlight", [eventId], { updatedAt: nowIso(ctx) });
      await client.removeFromSet(TABLE, worldStateKey(clockId), "inFlight", [eventId], { updatedAt: nowIso(ctx) });
    },
    async markWorldInFlight(clockId, eventId) {
      await client.addToSet(TABLE, worldStateKey(clockId), "inFlight", [eventId], { updatedAt: nowIso(ctx), defaults: worldDefaults(clockId) });
    },
    async clearWorldInFlight(clockId, eventId) {
      await client.removeFromSet(TABLE, worldStateKey(clockId), "inFlight", [eventId], { updatedAt: nowIso(ctx) });
    },
    setActiveWorkOrder: (installerId, clockId, workOrderId, atSim) =>
      upsertInstaller(installerId, clockId, { activeWorkOrderId: workOrderId, activeSetAtSim: workOrderId === null ? null : atSim }),
    setProcessError: (installerId, clockId, error) => upsertInstaller(installerId, clockId, { processError: error }),

    async addPendingMail(clockId, mailId) {
      try {
        return await createEntity(ctx, PendingMail, "PendingMail", { clockId, mailId, sentAtReal: nowIso(ctx), status: "OPEN" }, { ttlSeconds: RUNTIME_TTL_SECONDS.pending });
      } catch (error) {
        if (!isConflict(error)) throw error;
      }
      // A resend of the same mail: an open mark stays as it is; a closed or expired one opens again.
      const current = await getEntity(ctx, PendingMail, "PendingMail", { clockId, mailId });
      if (current === undefined) throw new ConnectorError("CONFLICT", "pending mail mark changed while it was reopened", TABLE);
      if (current.status === "OPEN" && !isExpired(ctx, current.expiresAt)) return current;
      return patchEntity(ctx, PendingMail, "PendingMail", current, { status: "OPEN", sentAtReal: nowIso(ctx), closedAtReal: null, eventType: null, [TTL_ATTRIBUTE]: expiresIn(ctx, RUNTIME_TTL_SECONDS.pending) });
    },
    // The event feed (ChannelEvents) and the worker's EMAIL_EVENT both close the mark: the one that
    // loses the version race reads it again and finds it closed.
    async closePendingMail(clockId, mailId, eventType) {
      for (let attempt = 1; ; attempt += 1) {
        const current = await getEntity(ctx, PendingMail, "PendingMail", { clockId, mailId });
        if (current === undefined || current.status === "CLOSED") return current;
        try {
          return await patchEntity(ctx, PendingMail, "PendingMail", current, { status: "CLOSED", closedAtReal: nowIso(ctx), eventType });
        } catch (error) {
          if (!isConflict(error) || attempt >= CLOSE_PENDING_ATTEMPTS) throw error;
        }
      }
    },
    async listPendingMail(clockId) {
      const open = (await listPrefix(ctx, TABLE, PendingMail, pendingPartition(clockId), MAIL_PREFIX)).filter((mail) => mail.status === "OPEN" && !isExpired(ctx, mail.expiresAt));
      const staleBefore = ctx.now().getTime() - PENDING_MAIL_STALE_SECONDS * 1000;
      const isStale = (mail: PendingMail) => Date.parse(mail.sentAtReal) <= staleBefore;
      return { open: open.filter((mail) => !isStale(mail)), stale: open.filter(isStale) };
    },

    async acquireLease(kind, n, holder) {
      try {
        await createEntity(ctx, Lease, "Lease", { leaseKind: kind, n, holder, acquiredAtReal: nowIso(ctx) }, { ttlSeconds: RUNTIME_TTL_SECONDS.lease, condition: { ifNotExistsOrExpiredAt: nowEpoch(ctx) } });
        return true;
      } catch (error) {
        if (!isConflict(error)) throw error;
        const current = valid(await getEntity(ctx, Lease, "Lease", { leaseKind: kind, n }));
        return current?.holder === holder;
      }
    },
    async releaseLease(kind, n, holder) {
      try {
        await client.delete(TABLE, leaseKey(kind, n), { equals: { holder } });
      } catch (error) {
        if (!isConflict(error)) throw error;
      }
    },

    createJoinCode: (code) => createEntity(ctx, JoinCode, "JoinCode", code, { ttlSeconds: RUNTIME_TTL_SECONDS.joinCode, condition: { ifNotExistsOrExpiredAt: nowEpoch(ctx) } }),
    getJoinCode: async (code) => valid(await getEntity(ctx, JoinCode, "JoinCode", { code })),

    async bindPhoneLease(code, phoneHash, bound = {}) {
      const joinCode = valid(await getEntity(ctx, JoinCode, "JoinCode", { code }));
      if (joinCode === undefined) throw new ConnectorError("NOT_FOUND", "join code not found or expired", TABLE);
      if (joinCode.usedAtReal !== undefined) throw new ConnectorError("CONFLICT", "join code already used", TABLE);
      const at = nowIso(ctx);
      const lease = entityRow(ctx, PhoneLease, "PhoneLease", { phoneHash, ...bound, clockId: joinCode.clockId, personId: joinCode.personId, joinCode: code, boundAtReal: at }, { ttlSeconds: RUNTIME_TTL_SECONDS.phoneLease });
      await client.transact(
        [
          { op: "update", table: TABLE, key: joinCodeKey(code), patch: { usedAtReal: at, usedByPhoneHash: phoneHash }, condition: { ifVersion: joinCode.version, absent: ["usedAtReal"] } },
          { op: "put", table: TABLE, item: lease.item, condition: { ifNotExistsOrExpiredAt: nowEpoch(ctx) } },
          { op: "addToSet", table: TABLE, key: worldStateKey(joinCode.clockId), attribute: "phoneLeases", values: [phoneHash], defaults: worldDefaults(joinCode.clockId) },
        ],
        at,
      );
      return lease.value;
    },
    getPhoneLease: async (phoneHash) => valid(await getEntity(ctx, PhoneLease, "PhoneLease", { phoneHash })),
    touchPhoneLease: (phoneHash, lastInboundAtReal) => patchRow(ctx, TABLE, PhoneLease, phoneLeaseKey(phoneHash), { lastInboundAtReal }, { ifExists: true }),
    async deletePhoneLease(phoneHash) {
      const lease = await getEntity(ctx, PhoneLease, "PhoneLease", { phoneHash });
      if (lease === undefined) return;
      await client.delete(TABLE, phoneLeaseKey(phoneHash));
      await client.removeFromSet(TABLE, worldStateKey(lease.clockId), "phoneLeases", [phoneHash], { updatedAt: nowIso(ctx) });
    },
    async listPhoneLeases(clockId) {
      const state = await getEntity(ctx, WorldState, "WorldState", { clockId });
      const leases = await Promise.all((state?.phoneLeases ?? []).map(async (phoneHash) => valid(await getEntity(ctx, PhoneLease, "PhoneLease", { phoneHash }))));
      return leases.filter((lease): lease is PhoneLease => lease !== undefined && lease.clockId === clockId);
    },

    createUpload: (upload) => createEntity(ctx, Upload, "Upload", upload, { ttlSeconds: RUNTIME_TTL_SECONDS.upload }),
    getUpload: async (uploadId) => valid(await getEntity(ctx, Upload, "Upload", { uploadId })),
    async useUpload(uploadId) {
      const upload = valid(await getEntity(ctx, Upload, "Upload", { uploadId }));
      if (upload === undefined) throw new ConnectorError("NOT_FOUND", "upload not found or expired", TABLE);
      return patchEntity(ctx, Upload, "Upload", upload, { usedAtReal: nowIso(ctx) }, { ifVersion: upload.version, absent: ["usedAtReal"] });
    },

    getLiveWorld: () => getEntity(ctx, LiveWorld, "LiveWorld", {}),
    async setLiveWorld(clockId, setBy) {
      const current = await getEntity(ctx, LiveWorld, "LiveWorld", {});
      if (current !== undefined) {
        if (current.clockId !== clockId) throw new ConnectorError("CONFLICT", "another world is live", TABLE);
        return current;
      }
      return createEntity(ctx, LiveWorld, "LiveWorld", { clockId, setBy, setAtReal: nowIso(ctx) });
    },
    async clearLiveWorld(clockId) {
      const current = await getEntity(ctx, LiveWorld, "LiveWorld", {});
      if (current === undefined) return;
      await client.delete(TABLE, LIVE_WORLD_KEY, { equals: { clockId } });
    },

    putTombstone: (tombstone) => upsertEntity(ctx, Tombstone, "Tombstone", tombstone, { ttlSeconds: RUNTIME_TTL_SECONDS.tombstone }),
    getTombstone: (clockId, worldEpoch) => getEntity(ctx, Tombstone, "Tombstone", { clockId, worldEpoch }),

    async putProbe(probeId, detail) {
      try {
        await createEntity(ctx, Probe, "Probe", { probeId, atReal: nowIso(ctx), ...(detail === undefined ? {} : { detail }) }, { ttlSeconds: RUNTIME_TTL_SECONDS.probe });
        return true;
      } catch (error) {
        if (isConflict(error)) return false;
        throw error;
      }
    },
    getProbe: async (probeId) => valid(await getEntity(ctx, Probe, "Probe", { probeId })),

    getWorldSession: async (clockId) => valid(await getEntity(ctx, WorldSession, "WorldSession", { clockId })),
    putWorldSession: (session) => upsertEntity(ctx, WorldSession, "WorldSession", session, { ttlSeconds: RUNTIME_TTL_SECONDS.worldSession }),

    getFaults: async (clockId) => (clockId.startsWith("qa-") ? getEntity(ctx, Faults, "Faults", { clockId }) : undefined),
    setFaults: (faults) => upsertEntity(ctx, Faults, "Faults", faults),
  };
}

function withoutNulls(patch: Patch): Patch {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== null && value !== undefined));
}

