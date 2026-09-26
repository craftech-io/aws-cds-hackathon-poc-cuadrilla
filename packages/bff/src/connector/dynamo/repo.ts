// Helpers every repository shares: stamping metadata and world scope on a new row, validating rows
// written and read back with the entity schema (zod at the connector edge), typed NOT_FOUND, dated
// history and real-time expiry. Repositories never call `Date.now()`: the context brings the clock.
import { randomBytes } from "node:crypto";
import type { z } from "zod";
import { ConnectorError, encodeUlid } from "@cuadrilla/shared";
import { HISTORY_LIMIT, type EntityName, type HistoryEntry, type Transition } from "../../domain/common";
import { encodeRow, keyOf } from "../codecs";
import { defaultWorldPolicy, type WorldPolicy } from "../world";
import { TTL_ATTRIBUTE, type Item, type Key, type Patch, type Table, type TableClient, type WriteCondition } from "../table-client";

export interface RepoContext {
  readonly client: TableClient;
  /** Real clock for `createdAt`/`updatedAt` and TTLs; business instants (`…Sim`) come as inputs. */
  readonly now: () => Date;
  /** Id generator for rows the connector names itself (decisions, messages, events). */
  readonly newId: () => string;
  readonly worldPolicy: WorldPolicy;
}

/** ULID from the context clock and 80 bits of entropy (sortable by real time). */
export function ulidFrom(now: () => Date): () => string {
  return () => encodeUlid(now().getTime(), new Uint8Array(randomBytes(10)));
}

export function createRepoContext(client: TableClient, options: Partial<Omit<RepoContext, "client">> = {}): RepoContext {
  const now = options.now ?? (() => new Date());
  return { client, now, newId: options.newId ?? ulidFrom(now), worldPolicy: options.worldPolicy ?? defaultWorldPolicy };
}

export function nowIso(ctx: RepoContext): string {
  return ctx.now().toISOString();
}

/** Epoch seconds `seconds` after the context clock (TTL). */
export function expiresIn(ctx: RepoContext, seconds: number): number {
  return nowEpoch(ctx) + seconds;
}

export function nowEpoch(ctx: RepoContext): number {
  return Math.floor(ctx.now().getTime() / 1000);
}

/** Whether an epoch-seconds expiry has passed (DynamoDB deletes expired rows lazily). */
export function isExpired(ctx: RepoContext, expiresAt: number | undefined): boolean {
  return expiresAt !== undefined && expiresAt <= nowEpoch(ctx);
}

export interface StampOptions {
  /** GSI attributes of the row (composite keys, sort names). */
  readonly gsi?: Record<string, unknown>;
  /** TTL of the row in seconds from now; the world policy may shorten it. */
  readonly ttlSeconds?: number;
}

/** A new row: key, discriminator, fields, metadata, world scope and GSI attributes. */
export function stampRow(ctx: RepoContext, table: Table, entity: EntityName, key: Key, fields: object, options: StampOptions = {}): Item {
  const at = nowIso(ctx);
  const values = fields as Record<string, unknown>;
  const clockId = typeof values.clockId === "string" ? values.clockId : undefined;
  const scope = ctx.worldPolicy(clockId, table, ctx.now());
  const ttl = options.ttlSeconds === undefined ? undefined : expiresIn(ctx, options.ttlSeconds);
  const expiresAt = [scope.expiresAt, ttl].filter((value): value is number => value !== undefined);
  const item: Item = {
    synthetic: false,
    ...(scope.world === undefined ? {} : { world: scope.world }),
    ...(expiresAt.length === 0 ? {} : { [TTL_ATTRIBUTE]: Math.min(...expiresAt) }),
    ...values,
    ...options.gsi,
    ...key,
    entity,
    createdAt: at,
    updatedAt: at,
    version: 1,
  };
  return item;
}

export function parseRow<T>(schema: z.ZodType<T>, item: Item, table: Table): T {
  const parsed = schema.safeParse(item);
  if (parsed.success) return parsed.data;
  throw new ConnectorError("VALIDATION", `${table} item ${item.PK}/${item.SK} does not match ${String(item.entity)}`, table, { cause: parsed.error });
}

export function parseRows<T>(schema: z.ZodType<T>, items: readonly Item[], table: Table): T[] {
  return items.map((item) => parseRow(schema, item, table));
}

export function optionalRow<T>(schema: z.ZodType<T>, item: Item | undefined, table: Table): T | undefined {
  return item === undefined ? undefined : parseRow(schema, item, table);
}

export function requireRow<T>(schema: z.ZodType<T>, item: Item | undefined, table: Table, what: string): T {
  if (item === undefined) throw new ConnectorError("NOT_FOUND", `${what} not found`, table);
  return parseRow(schema, item, table);
}

/** Stamps and validates a new row; nothing invalid is ever stored. */
export function buildRow<T>(ctx: RepoContext, table: Table, schema: z.ZodType<T>, entity: EntityName, key: Key, fields: object, options: StampOptions = {}): { item: Item; value: T } {
  const item = stampRow(ctx, table, entity, key, fields, options);
  const parsed = schema.safeParse(item);
  if (!parsed.success) throw new ConnectorError("VALIDATION", `invalid ${entity} for ${table}`, table, { cause: parsed.error });
  return { item, value: parsed.data };
}

export interface CreateOptions extends StampOptions {
  /** Defaults to `{ ifNotExists: true }`: creating over an existing key is a CONFLICT. */
  readonly condition?: WriteCondition;
}

/** Validates, stamps and stores a new entity; returns it parsed through its schema. */
export async function createRow<T>(ctx: RepoContext, table: Table, schema: z.ZodType<T>, entity: EntityName, key: Key, fields: object, options: CreateOptions = {}): Promise<T> {
  const { item, value } = buildRow(ctx, table, schema, entity, key, fields, options);
  await ctx.client.put(table, item, options.condition ?? { ifNotExists: true });
  return value;
}

/** Create or replace, keeping `createdAt` and bumping `version` of an existing row. */
export async function upsertRow<T>(ctx: RepoContext, table: Table, schema: z.ZodType<T>, entity: EntityName, key: Key, fields: object, options: StampOptions = {}): Promise<T> {
  const existing = await ctx.client.get(table, key);
  const { item } = buildRow(ctx, table, schema, entity, key, fields, options);
  if (existing === undefined) {
    await ctx.client.put(table, item, { ifNotExists: true });
  } else {
    const version = typeof existing.version === "number" ? existing.version : 0;
    item.createdAt = existing.createdAt;
    item.version = version + 1;
    await ctx.client.put(table, item, { ifVersion: version });
  }
  return parseRow(schema, item, table);
}

/** Applies a patch (null removes) under a condition and returns the stored entity. */
export async function patchRow<T>(ctx: RepoContext, table: Table, schema: z.ZodType<T>, key: Key, patch: Patch, condition?: WriteCondition): Promise<T> {
  const item = await ctx.client.update(table, key, patch, nowIso(ctx), condition);
  return parseRow(schema, item, table);
}

// ---- Entity-level helpers (key and GSI attributes from the row codec) --------------------------

/** Row of an entity built by its codec, validated; for transactions. */
export function entityRow<T>(ctx: RepoContext, schema: z.ZodType<T>, entity: EntityName, fields: object, options: StampOptions = {}): { table: Table; item: Item; value: T } {
  const encoded = encodeRow(entity, fields);
  const { item, value } = buildRow(ctx, encoded.table, schema, entity, encoded.key, encoded.fields, { ...options, gsi: { ...encoded.gsi, ...options.gsi } });
  return { table: encoded.table, item, value };
}

export async function createEntity<T>(ctx: RepoContext, schema: z.ZodType<T>, entity: EntityName, fields: object, options: CreateOptions = {}): Promise<T> {
  const { table, item, value } = entityRow(ctx, schema, entity, fields, options);
  await ctx.client.put(table, item, options.condition ?? { ifNotExists: true });
  return value;
}

export async function upsertEntity<T>(ctx: RepoContext, schema: z.ZodType<T>, entity: EntityName, fields: object, options: StampOptions = {}): Promise<T> {
  const encoded = encodeRow(entity, fields);
  return upsertRow(ctx, encoded.table, schema, entity, encoded.key, encoded.fields, { ...options, gsi: { ...encoded.gsi, ...options.gsi } });
}

/** The row of an entity by the fields that make its key. */
export async function getEntity<T>(ctx: RepoContext, schema: z.ZodType<T>, entity: EntityName, keyFields: object): Promise<T | undefined> {
  const encoded = keyOf(entity, keyFields);
  return optionalRow(schema, await ctx.client.get(encoded.table, encoded.key), encoded.table);
}

export async function requireEntity<T>(ctx: RepoContext, schema: z.ZodType<T>, entity: EntityName, keyFields: object, what: string): Promise<T> {
  const value = await getEntity(ctx, schema, entity, keyFields);
  if (value === undefined) throw new ConnectorError("NOT_FOUND", `${what} not found`, keyOf(entity, keyFields).table);
  return value;
}

/** Rows of one partition whose sort key starts with `prefix`, parsed with `schema`. */
export async function listPrefix<T>(ctx: RepoContext, table: Table, schema: z.ZodType<T>, partition: string, prefix: string, options: { limit?: number; descending?: boolean } = {}): Promise<T[]> {
  return parseRows(schema, await ctx.client.query(table, { hashValue: partition, range: { prefix }, ...options }), table);
}

/**
 * Update patch of an entity: the fields (normalized as the codec stores them) plus every GSI
 * attribute recomputed from the merged row; one the merged row no longer has is removed, which
 * takes the row out of a sparse index (a timer that stops being SCHEDULED, a case no longer TAKEN).
 */
export function entityPatch(entity: EntityName, current: object, patch: Patch): { table: Table; key: Key; patch: Patch } {
  const before = current as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...before };
  for (const [name, value] of Object.entries(patch)) {
    if (value === null) delete merged[name];
    else if (value !== undefined) merged[name] = value;
  }
  const oldRow = encodeRow(entity, before);
  const newRow = encodeRow(entity, merged);
  const removed = Object.fromEntries(Object.keys(oldRow.gsi).filter((name) => !(name in newRow.gsi)).map((name) => [name, null]));
  const normalizedPatch = Object.fromEntries(Object.keys(patch).filter((name) => patch[name] !== null && patch[name] !== undefined).map((name) => [name, newRow.fields[name]]));
  return { table: oldRow.table, key: oldRow.key, patch: { ...patch, ...normalizedPatch, ...removed, ...newRow.gsi } };
}

/** Applies `patch` to the stored entity `current` under `condition` (default: its version). */
export async function patchEntity<T>(
  ctx: RepoContext,
  schema: z.ZodType<T>,
  entity: EntityName,
  current: T & { readonly version: number },
  patch: Patch,
  condition: WriteCondition = { ifVersion: current.version },
): Promise<T> {
  const built = entityPatch(entity, current, patch);
  return patchRow(ctx, built.table, schema, built.key, built.patch, condition);
}

/** A dated transition appended to `history[]`, keeping the last `HISTORY_LIMIT`. */
export function withHistory(ctx: RepoContext, history: readonly HistoryEntry[], field: string, from: unknown, to: unknown, transition: Transition): HistoryEntry[] {
  const entry: HistoryEntry = {
    field,
    ...(from === undefined ? {} : { from: String(from) }),
    to: String(to),
    ...(transition.atSim === undefined ? {} : { atSim: transition.atSim }),
    atReal: nowIso(ctx),
    actor: transition.actor,
    ...(transition.reason === undefined ? {} : { reason: transition.reason }),
  };
  return [...history, entry].slice(-HISTORY_LIMIT);
}

/** Retries `attempt` once per CONFLICT, up to `times` (sequence allocation under races). */
export async function retryOnConflict<T>(times: number, attempt: () => Promise<T>): Promise<T> {
  for (let tries = 1; ; tries += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof ConnectorError) || error.code !== "CONFLICT" || tries >= times) throw error;
    }
  }
}
