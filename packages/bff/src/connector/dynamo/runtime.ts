// `Runtime` repository, turn and clock state: sessions, tool results of a turn, button nonces, world
// clocks, epochs, idempotency marks and plain counters with ceilings (rate limits, scene jumps,
// replies to unknown numbers). Cost caps and the kill switch belong to ops/ (`reserve_cost`,
// ADR-0019). Rows with a TTL are checked on read too: DynamoDB deletes lazily.
import { ConnectorError } from "@cuadrilla/shared";
import { CAP_KEY_PREFIXES, CapCounter, Clock, Counter, Idempotency, Nonce, RUNTIME_TTL_SECONDS, Session, Turn, TurnResult } from "../../domain/runtime";
import { COUNTER_KEYS, counterRowKey, idempotencyKey, turnPartition, turnResultPrefix } from "../keys";
import type { CounterReservation, RuntimePort } from "../ports-runtime";
import { TTL_ATTRIBUTE, type Patch, type TransactOp } from "../table-client";
import {
  createEntity,
  expiresIn,
  getEntity,
  isExpired,
  listPrefix,
  nowEpoch,
  nowIso,
  parseRow,
  patchEntity,
  requireEntity,
  retryOnConflict,
  type RepoContext,
} from "./repo";

const TABLE = "Runtime";
const COUNT = "count";

export function runtimeRepo(ctx: RepoContext): RuntimePort {
  const { client } = ctx;

  const valid = <T extends { readonly expiresAt?: number | undefined }>(row: T | undefined): T | undefined => (row === undefined || isExpired(ctx, row.expiresAt) ? undefined : row);

  function counterDefaults(reservation: CounterReservation): Patch {
    const ttl = reservation.kind === "EPOCH" ? undefined : expiresIn(ctx, reservation.ttlSeconds ?? RUNTIME_TTL_SECONDS.counter);
    return { entity: "Counter", counterKey: reservation.counterKey, kind: reservation.kind, createdAt: nowIso(ctx), version: 1, synthetic: false, [TTL_ATTRIBUTE]: ttl };
  }

  const getCounter = (counterKey: string) => getEntity(ctx, Counter, "Counter", { counterKey });

  function assertPlain(reservation: CounterReservation): void {
    if (CAP_KEY_PREFIXES.some((prefix) => reservation.counterKey.startsWith(prefix))) {
      throw new ConnectorError("VALIDATION", "cost caps are reserved by ops/cost-caps.ts, not by plain counters", TABLE);
    }
  }

  async function increment(reservation: CounterReservation): Promise<number> {
    assertPlain(reservation);
    return client.increment(TABLE, counterRowKey(reservation.counterKey), COUNT, reservation.by, {
      updatedAt: nowIso(ctx),
      defaults: counterDefaults(reservation),
      ...(reservation.max === undefined ? {} : { max: reservation.max }),
    });
  }

  async function blockedBy(reservations: readonly CounterReservation[]): Promise<string> {
    for (const reservation of reservations) {
      if (reservation.max === undefined) continue;
      const counter = await getCounter(reservation.counterKey);
      if ((counter?.count ?? 0) + reservation.by > reservation.max) return reservation.counterKey;
    }
    return reservations.find((reservation) => reservation.max !== undefined)?.counterKey ?? reservations[0]?.counterKey ?? "";
  }

  const nonceOf = async (nonce: string) => valid(await getEntity(ctx, Nonce, "Nonce", { nonce }));

  return {
    async putSession(session, expiresAt) {
      await createEntity(ctx, Session, "Session", expiresAt === undefined ? session : { ...session, expiresAt }, expiresAt === undefined ? { ttlSeconds: RUNTIME_TTL_SECONDS.session } : {});
    },
    getSession: async (sessionId) => valid(await getEntity(ctx, Session, "Session", { sessionId })),
    getTurn: async (turnId) => valid(await getEntity(ctx, Turn, "Turn", { turnId })),
    closeTurn: (turnId, details = {}) =>
      retryOnConflict(3, async () => {
        const current = await getEntity(ctx, Turn, "Turn", { turnId });
        const fields = { closedAtReal: nowIso(ctx), ...details };
        if (current === undefined) return createEntity(ctx, Turn, "Turn", { turnId, ...fields }, { ttlSeconds: RUNTIME_TTL_SECONDS.turn });
        return patchEntity(ctx, Turn, "Turn", current, fields);
      }),

    putTurnResult: (turnId, tool, output) =>
      retryOnConflict(5, async () => {
        const last = await listPrefix(ctx, TABLE, TurnResult, turnPartition(turnId), turnResultPrefix(tool), { descending: true, limit: 1 });
        const fields = { turnId, tool, seq: (last[0]?.seq ?? 0) + 1, output, atReal: nowIso(ctx) };
        return createEntity(ctx, TurnResult, "TurnResult", fields, { ttlSeconds: RUNTIME_TTL_SECONDS.turn });
      }),
    async listTurnResults(turnId, tool) {
      return listPrefix(ctx, TABLE, TurnResult, turnPartition(turnId), tool === undefined ? "RESULT#" : turnResultPrefix(tool));
    },

    putNonce: (nonce, ttlSeconds = RUNTIME_TTL_SECONDS.nonce) => createEntity(ctx, Nonce, "Nonce", nonce, { ttlSeconds }),
    getNonce: nonceOf,
    useNonce: (nonce) =>
      retryOnConflict(3, async () => {
        const current = await nonceOf(nonce);
        if (current === undefined) throw new ConnectorError("NOT_FOUND", "nonce not found or expired", TABLE);
        return patchEntity(ctx, Nonce, "Nonce", current, { useCount: current.useCount + 1, lastUsedAtReal: nowIso(ctx) });
      }),
    async expireNonce(nonce) {
      const current = await requireEntity(ctx, Nonce, "Nonce", { nonce }, "nonce");
      await patchEntity(ctx, Nonce, "Nonce", current, { [TTL_ATTRIBUTE]: nowEpoch(ctx) });
    },

    getClock: (clockId) => getEntity(ctx, Clock, "Clock", { clockId }),
    createClock: (clock) => createEntity(ctx, Clock, "Clock", clock),
    async updateClock(clockId, patch, expectedVersion) {
      const current = await requireEntity(ctx, Clock, "Clock", { clockId }, `clock ${clockId}`);
      return patchEntity(ctx, Clock, "Clock", current, { ...patch }, { ifVersion: expectedVersion });
    },

    nextEpoch: (clockId) => increment({ counterKey: COUNTER_KEYS.epoch(clockId), kind: "EPOCH", by: 1 }),
    async currentEpoch(clockId) {
      return (await getCounter(COUNTER_KEYS.epoch(clockId)))?.count ?? 0;
    },

    async claimIdempotency(source, id, result) {
      const fields = { source, id, firstSeenAtReal: nowIso(ctx), ...(result === undefined ? {} : { result }) };
      try {
        await createEntity(ctx, Idempotency, "Idempotency", fields, { ttlSeconds: RUNTIME_TTL_SECONDS.idempotency, condition: { ifNotExistsOrExpiredAt: nowEpoch(ctx) } });
        return true;
      } catch (error) {
        if (error instanceof ConnectorError && error.code === "CONFLICT") return false;
        throw error;
      }
    },
    async releaseIdempotency(source, id) {
      await client.delete(TABLE, idempotencyKey(source, id));
    },
    getIdempotency: async (source, id) => valid(await getEntity(ctx, Idempotency, "Idempotency", { source, id })),

    async reserve(reservations) {
      if (reservations.length === 0) return { ok: true, values: [] };
      reservations.forEach(assertPlain);
      try {
        if (reservations.length === 1 && reservations[0] !== undefined) return { ok: true, values: [await increment(reservations[0])] };
        const ops: TransactOp[] = reservations.map((reservation) => ({
          op: "increment",
          table: TABLE,
          key: counterRowKey(reservation.counterKey),
          attribute: COUNT,
          by: reservation.by,
          defaults: counterDefaults(reservation),
          ...(reservation.max === undefined ? {} : { max: reservation.max }),
        }));
        await client.transact(ops, nowIso(ctx));
        const counters = await Promise.all(reservations.map((reservation) => getCounter(reservation.counterKey)));
        return { ok: true, values: counters.map((counter) => counter?.count ?? 0) };
      } catch (error) {
        if (error instanceof ConnectorError && error.code === "CONFLICT") return { ok: false, blockedBy: await blockedBy(reservations) };
        throw error;
      }
    },
    async release(reservations) {
      reservations.forEach(assertPlain);
      for (const reservation of reservations) {
        await client.increment(TABLE, counterRowKey(reservation.counterKey), COUNT, -reservation.by, { updatedAt: nowIso(ctx), defaults: counterDefaults(reservation) });
      }
    },
    getCounter,
    async getCapCounter(counterKey) {
      if (!CAP_KEY_PREFIXES.some((prefix) => counterKey.startsWith(prefix))) throw new ConnectorError("VALIDATION", "not a cost-cap key", TABLE);
      const row = await client.get(TABLE, counterRowKey(counterKey));
      return valid(row === undefined ? undefined : parseRow(CapCounter, row, TABLE));
    },
  };
}
