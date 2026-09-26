// Generations of a guest's world (ADR-0025 §2): how one is opened, and how one is destroyed.
//
// Opening. A sign-up guest's world is a generation: an operator `isp-guest-s<yymmdd><5 base32>` (the real
// creation date and 5 random letters) with its clock `GUEST#isp-guest-s…`. Its first transaction
// creates `Isps/ISP#<id>` · `META` (and, where the caller may, `Runtime/CLOCK#<clockId>` with a fresh
// epoch) with `attribute_not_exists`, together with what the caller brings (the registry row, the
// account, the slot); nothing of the generation is written before. When the id is taken the transaction
// fails as a whole, and it is tried again with another suffix, at most 5 times: then the generation is
// `FAILED`. With about 33.5 million suffixes a day and at most 300 worlds a day this is a safety net.
//
// Destruction. `GuestAccountDeletion` destroys the current generation of a deleted account: every item
// of its operator in the demo's tables (found from the partitions the template gives it and from its
// cases), its objects under `guest/<seg>/` in `Media` and `Evidence` and, when a purger is given, its
// Memory. Only that generation: a key that does not carry its ids is never touched, and destroying one
// that is already gone is a no-op. The previous generations expire by TTL.
import { randomBytes } from "node:crypto";
import { CaseStatus, ConnectorError, type IspId, ToolError, clockIdOfIsp, isSignupGuestIsp, ispIdOfClock, signupGenerationIspId } from "@cuadrilla/shared";
import { worldObjectPrefix } from "@cuadrilla/shared/media/keys";
import { Isp } from "../domain/isps";
import { Clock } from "../domain/runtime";
import type { Connector } from "../connector/ports";
import { counterRowKey, COUNTER_KEYS, clockKey, ispKey } from "../connector/keys";
import { createRepoContext, entityRow } from "../connector/dynamo/repo";
import type { Key, Table, TableClient, TransactOp } from "../connector/table-client";
import { markersFor } from "./template";
import { worldPartitions } from "./partitions";

export interface Generation {
  readonly ispId: IspId;
  readonly clockId: string;
}

/** Tries of the first transaction before the generation is `FAILED` (ADR-0025 §2). */
export const GENERATION_ATTEMPTS = 5;

export class GenerationCollisionError extends Error {
  override readonly name = "GenerationCollisionError";
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** 5 random characters of `[a-z2-7]`. */
export function randomSuffix(): string {
  return [...randomBytes(5)].map((byte) => BASE32[byte % 32]).join("");
}

export interface ClockSeed {
  /** Simulated start of the world (the template's `startAtSim`, 13/10 07:00). */
  readonly pausedSimNow: string;
  readonly template: string;
  /** Stored in `Clock.settings`: the guest the generation belongs to (the factory checks it). */
  readonly ownerUserId?: string | undefined;
}

export interface GenerationOpening {
  readonly client: TableClient;
  readonly now: Date;
  readonly suffix?: () => string;
  readonly attempts?: number;
  /** The clock of the generation, created in the same transaction by callers that may write it. */
  readonly clock?: ClockSeed;
  /** What the first transaction carries besides `META` (and the clock). */
  readonly ops: (generation: Generation) => readonly TransactOp[] | Promise<readonly TransactOp[]>;
  /**
   * After a CONFLICT: whether it was the generation's id that was taken (then another suffix);
   * otherwise the conflict is the caller's own and is thrown as it is.
   */
  readonly idTaken: (generation: Generation) => Promise<boolean>;
}

/** The first rows of a generation: its operator and, optionally, its clock and the first epoch. */
export function generationOps(client: TableClient, generation: Generation, now: Date, clock?: ClockSeed): TransactOp[] {
  const ctx = createRepoContext(client, { now: () => now });
  const meta = entityRow(ctx, Isp, "Isp", { ispId: generation.ispId, kind: "GUEST", clockId: generation.clockId });
  const ops: TransactOp[] = [{ op: "put", table: "Isps", item: meta.item, condition: { ifNotExists: true } }];
  if (clock === undefined) return ops;
  const row = entityRow(ctx, Clock, "Clock", {
    clockId: generation.clockId,
    ispId: generation.ispId,
    kind: "GUEST",
    mode: "PAUSED",
    offsetMs: 0,
    pausedSimNow: clock.pausedSimNow,
    worldEpoch: 1,
    template: clock.template,
    ...(clock.ownerUserId === undefined ? {} : { settings: { ownerUserId: clock.ownerUserId } }),
  });
  const epochKey = COUNTER_KEYS.epoch(generation.clockId);
  ops.push({ op: "put", table: "Runtime", item: row.item, condition: { ifNotExists: true } });
  // A fresh id has no epoch yet: the counter goes from nothing to 1, or the id was used before.
  ops.push({ op: "increment", table: "Runtime", key: counterRowKey(epochKey), attribute: "count", by: 1, max: 1, defaults: { entity: "Counter", counterKey: epochKey, kind: "EPOCH", createdAt: now.toISOString(), version: 1, synthetic: false } });
  return ops;
}

/** Whether a generation's operator or clock already exists. */
export async function generationExists(client: TableClient, generation: Generation): Promise<boolean> {
  const [meta, clock] = await Promise.all([client.get("Isps", ispKey(generation.ispId)), client.get("Runtime", clockKey(generation.clockId))]);
  return meta !== undefined || clock !== undefined;
}

/** Opens a new generation with the caller's rows, trying another suffix while the id is taken. */
export async function openGeneration(opening: GenerationOpening): Promise<Generation> {
  const suffix = opening.suffix ?? randomSuffix;
  const attempts = opening.attempts ?? GENERATION_ATTEMPTS;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const ispId = signupGenerationIspId(opening.now, suffix());
    const generation: Generation = { ispId, clockId: clockIdOfIsp(ispId) };
    const ops = [...generationOps(opening.client, generation, opening.now, opening.clock), ...(await opening.ops(generation))];
    try {
      await opening.client.transact(ops, opening.now.toISOString());
      return generation;
    } catch (error) {
      if (!(error instanceof ConnectorError && error.code === "CONFLICT")) throw error;
      if (!(await opening.idTaken(generation))) throw error;
    }
  }
  throw new GenerationCollisionError(`no free generation id after ${attempts} tries`);
}

// ---- Destruction ---------------------------------------------------------------------------------

export type ObjectBucket = "Media" | "Evidence";

export interface ObjectStore {
  /** Deletes every object under `prefix`; the number deleted. */
  deletePrefix(bucket: ObjectBucket, prefix: string): Promise<number>;
}

export interface DestroyDeps {
  readonly client: TableClient;
  readonly connector: Pick<Connector, "cases" | "runtime">;
  /** The guest template's text (partitions of the world). */
  readonly template: () => Promise<string>;
  readonly phoneHash: (phone: string) => string;
  readonly objects: ObjectStore;
  /** Purges the Memory of the world's actors, when the stage has one (WP-39 wires the Memory purge). */
  readonly purgeMemory?: (clockId: string, epochs: readonly number[]) => Promise<void>;
  readonly now: () => Date;
}

export interface DestroyResult {
  readonly clockId: string;
  readonly items: number;
  readonly objects: number;
}

async function casePartitions(deps: DestroyDeps, ispId: string): Promise<Key[]> {
  const lists = await Promise.all(CaseStatus.options.map((status) => deps.connector.cases.listCasesByStatus(ispId, status)));
  return lists.flat().map((item) => ({ PK: `CASE#${item.caseId}`, SK: "META" }));
}

/**
 * The registry row of the account itself stays: `GuestAccountDeletion` removes it in its own transaction,
 * after Cognito, and reads it on a retry to find the Cognito user again.
 */
const isAccountRow = (table: Table, row: Record<string, unknown>): boolean => table === "Isps" && row.entity === "ConsoleUser" && row.guestOrigin === "SIGNUP";

async function deletePartition(client: TableClient, table: Table, partition: string): Promise<number> {
  const rows = (await client.query(table, { hashValue: partition })).filter((row) => !isAccountRow(table, row));
  if (rows.length > 0) await client.batchDelete(table, rows.map((row) => ({ PK: row.PK, SK: row.SK })));
  return rows.length;
}

/**
 * Destroys one guest generation: its items, its `guest/` objects of every epoch and its Memory.
 * Idempotent. Throws for anything that is not a guest world, and when a step could not be done, so
 * the caller keeps the account for its retry.
 */
export async function destroyGeneration(deps: DestroyDeps, clockId: string): Promise<DestroyResult> {
  const ispId = ispIdOfClock(clockId);
  const markers = markersFor(ispId);
  const partitions = worldPartitions(await deps.template(), markers, deps.phoneHash, deps.now());
  const cases = await casePartitions(deps, ispId);
  let items = 0;
  for (const { table, partition } of partitions) items += await deletePartition(deps.client, table, partition);
  for (const key of cases) items += await deletePartition(deps.client, "Cases", key.PK);
  const epoch = await deps.connector.runtime.currentEpoch(clockId);
  const epochs = Array.from({ length: epoch + 1 }, (_unused, index) => index);
  let objects = 0;
  for (const bucket of ["Media", "Evidence"] as const) {
    for (const worldEpoch of epochs) objects += await deps.objects.deletePrefix(bucket, worldObjectPrefix(clockId, worldEpoch));
  }
  await deps.purgeMemory?.(clockId, epochs);
  return { clockId, items, objects };
}

/**
 * The port `GuestAccountDeletion` destroys a sign-up guest's current generation with (leads/deletion.ts
 * `GenerationDestroyer`): only a sign-up generation, never an invited or rehearsal world.
 */
export function signupGenerationDestroyer(deps: DestroyDeps): { destroyGeneration(account: { readonly clockId: string }): Promise<void> } {
  return {
    async destroyGeneration(account) {
      const ispId = ispIdOfClock(account.clockId);
      if (!isSignupGuestIsp(ispId)) throw new ToolError("FORBIDDEN", "only a generation of the own sign-up is destroyed with its account");
      await destroyGeneration(deps, account.clockId);
    },
  };
}
