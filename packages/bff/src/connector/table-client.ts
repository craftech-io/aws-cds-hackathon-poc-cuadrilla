// Storage primitive under the connector: a semantic, expression-free view of a DynamoDB table. The
// repositories of connector/dynamo/ speak only this interface, so the same repository code runs over
// DocumentClient (dynamo/client.ts) in a Lambda and over a map (memory/table-client.ts) in vitest
// and in the local flows. Keys, GSIs and TTL are those of infra/storage-keys.ts (WP-06): every table
// is keyed by `PK` + `SK`, GSI key attributes are strings, and `expiresAt` is epoch seconds.
import type { DomainTable } from "../domain/registry";

/**
 * Tables the client reaches: the domain's, plus the mocks' `Network` and `Dispatch`, which only the
 * world factory writes through this client (their rows are the mocks' own shapes, never an entity).
 */
export type MockTable = "Network" | "Dispatch";
export type Table = DomainTable | MockTable;

export const TTL_ATTRIBUTE = "expiresAt";

export interface Key {
  readonly PK: string;
  readonly SK: string;
}

/** A stored row: the key, the `entity` discriminator and whatever the entity carries. */
export type Item = Key & Record<string, unknown>;

export type IndexName = "GSI1" | "GSI2" | "GSI3" | "GSI4";

export interface IndexKeys {
  readonly hash: string;
  readonly range?: string;
}

const CLOCK_DUE: IndexKeys = { hash: "clockDueKey", range: "dueAtSim" };

/**
 * Global secondary indexes per table, exactly as infra/storage-keys.ts declares them
 * (`domain/domain.test.ts` compares the two). The memory client filters by these attributes; the
 * DynamoDB client names them in the key condition.
 */
export const INDEXES: Readonly<Partial<Record<Table, Readonly<Partial<Record<IndexName, IndexKeys>>>>>> = {
  Isps: { GSI1: { hash: "cognitoSubKey" } },
  People: { GSI1: { hash: "phoneKey" }, GSI2: { hash: "ispKindKey", range: "sortName" } },
  WorkOrders: {
    GSI1: { hash: "installerDayKey", range: "windowStartSim" },
    GSI2: { hash: "ispDayKey", range: "status" },
    GSI3: CLOCK_DUE,
    GSI4: { hash: "evidenceHash" },
  },
  Cases: {
    GSI1: { hash: "workOrderKey", range: "createdAtSim" },
    GSI2: { hash: "takenByKey" },
    GSI3: { hash: "ispStatusKey", range: "createdAtSim" },
    GSI4: CLOCK_DUE,
  },
  Conversations: { GSI1: { hash: "providerMessageId" }, GSI2: { hash: "workOrderKey", range: "sentAtSim" } },
  AuditLog: { GSI1: { hash: "workOrderKey", range: "ts" }, GSI2: { hash: "decisionKey", range: "ts" } },
};

/** Tables whose items DynamoDB expires by `expiresAt` (all but `Reference`). */
export const TTL_TABLES: readonly Table[] = ["Isps", "People", "WorkOrders", "Cases", "Conversations", "AuditLog", "Runtime", "CuadrillaMetrics", "Network", "Dispatch"];

export function indexKeys(table: Table, index: IndexName): IndexKeys {
  const keys = INDEXES[table]?.[index];
  if (!keys) throw new RangeError(`table ${table} has no index ${index}`);
  return keys;
}

export type RangeCondition =
  | { readonly prefix: string }
  | { readonly between: readonly [string, string] }
  | { readonly gte: string }
  | { readonly lte: string }
  | { readonly eq: string };

export interface QuerySpec {
  /** Omitted: the primary index (PK + SK). */
  readonly index?: IndexName;
  readonly hashValue: string;
  readonly range?: RangeCondition;
  readonly descending?: boolean;
  readonly limit?: number;
}

export type Scalar = string | number | boolean;

export interface WriteCondition {
  /** CONFLICT when the key already exists (create). */
  readonly ifNotExists?: boolean;
  /** CONFLICT (NOT_FOUND on a plain update) when the key does not exist. */
  readonly ifExists?: boolean;
  /** Optimistic locking: CONFLICT unless the stored `version` matches. */
  readonly ifVersion?: number;
  /** CONFLICT unless each attribute equals the value (`status = OPEN`, `rungVersion = 3`). */
  readonly equals?: Readonly<Record<string, Scalar>>;
  /** CONFLICT unless each attribute is one of the values. */
  readonly oneOf?: Readonly<Record<string, readonly Scalar[]>>;
  /** CONFLICT when any of these attributes exists (a code already used). */
  readonly absent?: readonly string[];
  /** Create, or replace a row whose `expiresAt` (epoch seconds) is at or before this value. */
  readonly ifNotExistsOrExpiredAt?: number;
}

/** Attributes to set; `null` removes the attribute; `undefined` is ignored. */
export type Patch = Record<string, unknown>;

export interface IncrementOptions {
  /** Real instant stamped as `updatedAt`. */
  readonly updatedAt: string;
  /** CONFLICT when the counter would exceed this value. */
  readonly max?: number;
  /** Attributes set only when this call creates the row (entity, expiresAt, createdAt…). */
  readonly defaults?: Patch;
}

export interface SetUpdateOptions {
  readonly updatedAt: string;
  /** Attributes set only when this call creates the row. */
  readonly defaults?: Patch;
  readonly condition?: WriteCondition;
}

export type TransactOp =
  | { readonly op: "put"; readonly table: Table; readonly item: Item; readonly condition?: WriteCondition }
  | { readonly op: "update"; readonly table: Table; readonly key: Key; readonly patch: Patch; readonly condition?: WriteCondition }
  | { readonly op: "delete"; readonly table: Table; readonly key: Key; readonly condition?: WriteCondition }
  | { readonly op: "increment"; readonly table: Table; readonly key: Key; readonly attribute: string; readonly by: number; readonly max?: number; readonly defaults?: Patch }
  | { readonly op: "addToSet"; readonly table: Table; readonly key: Key; readonly attribute: string; readonly values: readonly string[]; readonly defaults?: Patch };

export interface TableClient {
  get(table: Table, key: Key): Promise<Item | undefined>;
  /** Pages through the whole result unless `limit` is given; always one call for the caller. */
  query(table: Table, spec: QuerySpec): Promise<Item[]>;
  put(table: Table, item: Item, condition?: WriteCondition): Promise<void>;
  /** SET/REMOVE the patch, bump `version`, stamp `updatedAt`; returns the stored row. */
  update(table: Table, key: Key, patch: Patch, updatedAt: string, condition?: WriteCondition): Promise<Item>;
  delete(table: Table, key: Key, condition?: WriteCondition): Promise<void>;
  /** Atomic ADD on a numeric attribute; returns the new value. */
  increment(table: Table, key: Key, attribute: string, by: number, options: IncrementOptions): Promise<number>;
  /** ADD values to a string set (creating the row with `defaults`); returns the stored row. */
  addToSet(table: Table, key: Key, attribute: string, values: readonly string[], options: SetUpdateOptions): Promise<Item>;
  /** DELETE values from a string set; an emptied set disappears; returns the stored row, if any. */
  removeFromSet(table: Table, key: Key, attribute: string, values: readonly string[], options: SetUpdateOptions): Promise<Item | undefined>;
  /** All-or-nothing across tables (TransactWriteItems, ≤ 100 ops); CONFLICT when any condition fails. */
  transact(ops: readonly TransactOp[], updatedAt: string): Promise<void>;
  /** Unconditional upsert of many rows (seed loader, world factory); chunks and retries unprocessed items. */
  batchPut(table: Table, items: readonly Item[]): Promise<void>;
  /** Unconditional delete of many rows (world reset); chunks and retries unprocessed keys. */
  batchDelete(table: Table, keys: readonly Key[]): Promise<void>;
}

/**
 * Whether `cond` checks nothing but existence: a failed update under it means the row is simply
 * missing (NOT_FOUND), while any other failed condition is a CONFLICT.
 */
export function isExistenceOnly(cond: WriteCondition | undefined): boolean {
  return (
    cond?.ifVersion === undefined &&
    !cond?.ifNotExists &&
    cond?.ifNotExistsOrExpiredAt === undefined &&
    Object.keys(cond?.equals ?? {}).length === 0 &&
    Object.keys(cond?.oneOf ?? {}).length === 0 &&
    (cond?.absent ?? []).length === 0
  );
}

/** Most operations TransactWriteItems accepts in one call. */
export const TRANSACT_MAX_OPS = 100;

/** Epoch seconds for the TTL attribute from an ISO instant or a Date. */
export function ttlEpoch(expiresAt: string | Date): number {
  const ms = expiresAt instanceof Date ? expiresAt.getTime() : Date.parse(expiresAt);
  if (Number.isNaN(ms)) throw new RangeError(`invalid expiry: ${String(expiresAt)}`);
  return Math.floor(ms / 1000);
}

/** UTC ISO form of an instant: the only form stored in sort keys, so lexical order is time order. */
export function utcIso(instant: string | Date): string {
  const ms = instant instanceof Date ? instant.getTime() : Date.parse(instant);
  if (Number.isNaN(ms)) throw new RangeError(`invalid instant: ${String(instant)}`);
  return new Date(ms).toISOString();
}
