// In-memory TableClient with the semantics of dynamo/client.ts: keys, `begins_with` and range queries
// on the primary index and on the GSIs of infra/storage-keys.ts (sparse: a row without the index key
// is not in the index), conditional writes, optimistic locking, counters with a ceiling, string sets
// and all-or-nothing transactions. Used by vitest and by the local flows (`tests/flows/`).
import { ConnectorError } from "@cuadrilla/shared";
import {
  TRANSACT_MAX_OPS,
  indexKeys,
  isExistenceOnly,
  type IncrementOptions,
  type Item,
  type Key,
  type Patch,
  type QuerySpec,
  type RangeCondition,
  type SetUpdateOptions,
  type Table,
  type TableClient,
  type TransactOp,
  type WriteCondition,
} from "../table-client";

const rowId = (key: Key): string => `${key.PK}\u0000${key.SK}`;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function stringAttribute(item: Item, attribute: string): string | undefined {
  const value = item[attribute];
  return typeof value === "string" ? value : undefined;
}

function matchesRange(value: string, range: RangeCondition): boolean {
  if ("prefix" in range) return value.startsWith(range.prefix);
  if ("between" in range) return value >= range.between[0] && value <= range.between[1];
  if ("gte" in range) return value >= range.gte;
  if ("lte" in range) return value <= range.lte;
  return value === range.eq;
}

const compare = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

function conflict(table: Table, key: Key, what: string): ConnectorError {
  return new ConnectorError("CONFLICT", `${what} on ${table} ${key.PK}/${key.SK}`, table);
}

function checkCondition(table: Table, key: Key, existing: Item | undefined, cond: WriteCondition | undefined): void {
  if (!cond) return;
  if (cond.ifNotExists && existing !== undefined) throw conflict(table, key, "item already exists");
  if (cond.ifExists && existing === undefined) throw conflict(table, key, "item does not exist");
  if (cond.ifNotExistsOrExpiredAt !== undefined && existing !== undefined) {
    const expiresAt = existing.expiresAt;
    if (typeof expiresAt !== "number" || expiresAt > cond.ifNotExistsOrExpiredAt) throw conflict(table, key, "item exists and has not expired");
  }
  if (cond.ifVersion !== undefined && existing?.version !== cond.ifVersion) throw conflict(table, key, "version mismatch");
  for (const [attribute, value] of Object.entries(cond.equals ?? {})) {
    if (existing?.[attribute] !== value) throw conflict(table, key, `${attribute} mismatch`);
  }
  for (const [attribute, values] of Object.entries(cond.oneOf ?? {})) {
    const current = existing?.[attribute];
    if (!values.some((value) => value === current)) throw conflict(table, key, `${attribute} not in the expected values`);
  }
  for (const attribute of cond.absent ?? []) {
    if (existing?.[attribute] !== undefined) throw conflict(table, key, `${attribute} already set`);
  }
}

function withDefaults(base: Record<string, unknown>, defaults: Patch | undefined): void {
  for (const [name, value] of Object.entries(defaults ?? {})) {
    if (value === undefined || value === null) continue;
    if (base[name] === undefined) base[name] = clone(value);
  }
}

export class MemoryTableClient implements TableClient {
  private tables = new Map<Table, Map<string, Item>>();

  private rows(table: Table): Map<string, Item> {
    let rows = this.tables.get(table);
    if (!rows) {
      rows = new Map();
      this.tables.set(table, rows);
    }
    return rows;
  }

  /** Test helper: every stored row of a table, as stored. */
  dump(table: Table): Item[] {
    return [...this.rows(table).values()].map(clone);
  }

  clear(): void {
    this.tables.clear();
  }

  async get(table: Table, key: Key): Promise<Item | undefined> {
    const row = this.rows(table).get(rowId(key));
    return row ? clone(row) : undefined;
  }

  async query(table: Table, spec: QuerySpec): Promise<Item[]> {
    const keys = spec.index ? indexKeys(table, spec.index) : { hash: "PK", range: "SK" };
    if (spec.range && !keys.range) throw new RangeError(`index ${spec.index ?? "primary"} of ${table} has no range key`);
    const rangeAttribute = keys.range;
    const matches = [...this.rows(table).values()].filter((item) => {
      if (stringAttribute(item, keys.hash) !== spec.hashValue) return false;
      if (rangeAttribute === undefined) return true;
      // A GSI only contains rows that carry both of its key attributes.
      const rangeValue = stringAttribute(item, rangeAttribute);
      if (rangeValue === undefined) return false;
      return spec.range ? matchesRange(rangeValue, spec.range) : true;
    });
    matches.sort((a, b) => {
      const byRange = rangeAttribute === undefined ? 0 : compare(stringAttribute(a, rangeAttribute) ?? "", stringAttribute(b, rangeAttribute) ?? "");
      return byRange !== 0 ? byRange : compare(rowId(a), rowId(b));
    });
    if (spec.descending) matches.reverse();
    const limited = spec.limit === undefined ? matches : matches.slice(0, spec.limit);
    return limited.map(clone);
  }

  async put(table: Table, item: Item, cond?: WriteCondition): Promise<void> {
    const rows = this.rows(table);
    checkCondition(table, item, rows.get(rowId(item)), cond);
    rows.set(rowId(item), clone(item));
  }

  async update(table: Table, key: Key, patch: Patch, updatedAt: string, cond?: WriteCondition): Promise<Item> {
    const rows = this.rows(table);
    const existing = rows.get(rowId(key));
    if (existing === undefined && isExistenceOnly(cond)) throw new ConnectorError("NOT_FOUND", `${table} item ${key.PK}/${key.SK} not found`, table);
    checkCondition(table, key, existing, { ifExists: true, ...cond });
    if (existing === undefined) throw conflict(table, key, "item does not exist");
    const next: Record<string, unknown> = { ...existing };
    for (const [attribute, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (attribute === "PK" || attribute === "SK") throw new RangeError("keys are immutable");
      if (attribute === "version" || attribute === "updatedAt") throw new RangeError(`${attribute} is stamped by the connector`);
      if (value === null) delete next[attribute];
      else next[attribute] = clone(value);
    }
    next.updatedAt = updatedAt;
    next.version = (typeof existing.version === "number" ? existing.version : 0) + 1;
    const stored: Item = { ...next, PK: key.PK, SK: key.SK };
    rows.set(rowId(key), stored);
    return clone(stored);
  }

  async delete(table: Table, key: Key, cond?: WriteCondition): Promise<void> {
    const rows = this.rows(table);
    checkCondition(table, key, rows.get(rowId(key)), cond);
    rows.delete(rowId(key));
  }

  async increment(table: Table, key: Key, attribute: string, by: number, options: IncrementOptions): Promise<number> {
    if (options.max !== undefined && by > options.max) throw new RangeError(`increment ${by} exceeds the ceiling ${options.max}`);
    const rows = this.rows(table);
    const existing = rows.get(rowId(key));
    const raw = existing?.[attribute];
    const current = typeof raw === "number" ? raw : 0;
    if (options.max !== undefined && raw !== undefined && current > options.max - by) {
      throw new ConnectorError("CONFLICT", `counter ${attribute} on ${table} would exceed ${options.max}`, table);
    }
    const base: Record<string, unknown> = existing ? { ...existing } : {};
    withDefaults(base, options.defaults);
    base[attribute] = current + by;
    base.updatedAt = options.updatedAt;
    rows.set(rowId(key), { ...base, PK: key.PK, SK: key.SK });
    return current + by;
  }

  async addToSet(table: Table, key: Key, attribute: string, values: readonly string[], options: SetUpdateOptions): Promise<Item> {
    if (values.length === 0) throw new RangeError("a set update needs at least one value");
    const rows = this.rows(table);
    const existing = rows.get(rowId(key));
    checkCondition(table, key, existing, options.condition);
    const base: Record<string, unknown> = existing ? { ...existing } : {};
    withDefaults(base, options.defaults);
    const current = base[attribute];
    base[attribute] = new Set<string>([...(current instanceof Set ? (current as Set<string>) : []), ...values]);
    base.updatedAt = options.updatedAt;
    const stored: Item = { ...base, PK: key.PK, SK: key.SK };
    rows.set(rowId(key), stored);
    return clone(stored);
  }

  async removeFromSet(table: Table, key: Key, attribute: string, values: readonly string[], options: SetUpdateOptions): Promise<Item | undefined> {
    if (values.length === 0) throw new RangeError("a set update needs at least one value");
    const rows = this.rows(table);
    const existing = rows.get(rowId(key));
    if (existing === undefined && isExistenceOnly(options.condition)) return undefined;
    checkCondition(table, key, existing, { ifExists: true, ...options.condition });
    if (existing === undefined) return undefined;
    const base: Record<string, unknown> = { ...existing };
    const current = base[attribute];
    const next = new Set<string>(current instanceof Set ? (current as Set<string>) : []);
    for (const value of values) next.delete(value);
    if (next.size === 0) delete base[attribute];
    else base[attribute] = next;
    base.updatedAt = options.updatedAt;
    const stored: Item = { ...base, PK: key.PK, SK: key.SK };
    rows.set(rowId(key), stored);
    return clone(stored);
  }

  // Every condition is checked against the state before the transaction and nothing is written
  // unless all pass, like TransactWriteItems (which also rejects two operations on one item).
  async transact(ops: readonly TransactOp[], updatedAt: string): Promise<void> {
    if (ops.length > TRANSACT_MAX_OPS) throw new ConnectorError("VALIDATION", `a transaction takes at most ${TRANSACT_MAX_OPS} operations`);
    const touched = new Set<string>();
    for (const op of ops) {
      const id = `${op.table}\u0000${rowId(op.op === "put" ? op.item : op.key)}`;
      if (touched.has(id)) throw new ConnectorError("VALIDATION", "a transaction cannot touch the same item twice", op.table);
      touched.add(id);
    }
    const snapshot = new Map<Table, Map<string, Item>>();
    for (const [table, rows] of this.tables) snapshot.set(table, new Map(rows));
    try {
      for (const op of ops) await this.apply(op, updatedAt);
    } catch (error) {
      this.tables = snapshot;
      if (error instanceof ConnectorError) {
        const code = error.code === "NOT_FOUND" ? "CONFLICT" : error.code;
        throw new ConnectorError(code, `transaction cancelled: ${error.message}`, error.table, { cause: error });
      }
      throw error;
    }
  }

  private async apply(op: TransactOp, updatedAt: string): Promise<void> {
    switch (op.op) {
      case "put":
        return this.put(op.table, op.item, op.condition);
      case "update":
        await this.update(op.table, op.key, op.patch, updatedAt, op.condition);
        return;
      case "delete":
        return this.delete(op.table, op.key, op.condition);
      case "increment":
        await this.increment(op.table, op.key, op.attribute, op.by, { updatedAt, ...(op.max === undefined ? {} : { max: op.max }), ...(op.defaults ? { defaults: op.defaults } : {}) });
        return;
      case "addToSet":
        await this.addToSet(op.table, op.key, op.attribute, op.values, { updatedAt, ...(op.defaults ? { defaults: op.defaults } : {}) });
        return;
    }
  }

  async batchPut(table: Table, items: readonly Item[]): Promise<void> {
    for (const item of items) await this.put(table, item);
  }

  async batchDelete(table: Table, keys: readonly Key[]): Promise<void> {
    for (const key of keys) await this.delete(table, key);
  }
}
