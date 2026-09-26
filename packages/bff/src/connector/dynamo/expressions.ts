// Builds DynamoDB expressions from the semantic specs of table-client.ts: the one place that knows
// about placeholders, `begins_with`, `attribute_exists`, optimistic locking, counters with a ceiling
// and string sets. Pure: dynamo/client.ts sends what this returns, and expressions.test.ts pins it.
import { indexKeys, type Patch, type QuerySpec, type RangeCondition, type Table, type WriteCondition } from "../table-client";

export interface Expression {
  readonly names: Record<string, string>;
  readonly values: Record<string, unknown>;
}

export interface KeyConditionExpression extends Expression {
  readonly expression: string;
  readonly indexName?: string;
}

export interface ConditionExpression extends Expression {
  readonly expression: string | undefined;
}

export interface UpdateExpression extends Expression {
  readonly expression: string;
  readonly conditionExpression: string | undefined;
}

export class Placeholders {
  readonly names: Record<string, string> = {};
  readonly values: Record<string, unknown> = {};
  private counter = 0;

  name(attribute: string): string {
    const existing = Object.entries(this.names).find(([, value]) => value === attribute);
    if (existing) return existing[0];
    const placeholder = `#n${this.counter++}`;
    this.names[placeholder] = attribute;
    return placeholder;
  }

  value(value: unknown): string {
    const placeholder = `:v${this.counter++}`;
    this.values[placeholder] = value;
    return placeholder;
  }
}

function rangeClause(ph: Placeholders, attribute: string, range: RangeCondition): string {
  const name = ph.name(attribute);
  if ("prefix" in range) return `begins_with(${name}, ${ph.value(range.prefix)})`;
  if ("between" in range) return `${name} BETWEEN ${ph.value(range.between[0])} AND ${ph.value(range.between[1])}`;
  if ("gte" in range) return `${name} >= ${ph.value(range.gte)}`;
  if ("lte" in range) return `${name} <= ${ph.value(range.lte)}`;
  return `${name} = ${ph.value(range.eq)}`;
}

export function keyCondition(table: Table, spec: QuerySpec): KeyConditionExpression {
  const ph = new Placeholders();
  const keys = spec.index ? indexKeys(table, spec.index) : { hash: "PK", range: "SK" };
  const clauses = [`${ph.name(keys.hash)} = ${ph.value(spec.hashValue)}`];
  if (spec.range) {
    if (!keys.range) throw new RangeError(`index ${spec.index ?? "primary"} of ${table} has no range key`);
    clauses.push(rangeClause(ph, keys.range, spec.range));
  }
  return { expression: clauses.join(" AND "), names: ph.names, values: ph.values, indexName: spec.index };
}

export function condition(cond: WriteCondition | undefined, ph = new Placeholders()): ConditionExpression {
  const clauses: string[] = [];
  if (cond?.ifNotExists) clauses.push(`attribute_not_exists(${ph.name("PK")})`);
  if (cond?.ifExists) clauses.push(`attribute_exists(${ph.name("PK")})`);
  if (cond?.ifNotExistsOrExpiredAt !== undefined) {
    clauses.push(`(attribute_not_exists(${ph.name("PK")}) OR ${ph.name("expiresAt")} <= ${ph.value(cond.ifNotExistsOrExpiredAt)})`);
  }
  if (cond?.ifVersion !== undefined) clauses.push(`${ph.name("version")} = ${ph.value(cond.ifVersion)}`);
  for (const [attribute, value] of Object.entries(cond?.equals ?? {})) clauses.push(`${ph.name(attribute)} = ${ph.value(value)}`);
  for (const [attribute, values] of Object.entries(cond?.oneOf ?? {})) {
    if (values.length === 0) throw new RangeError(`oneOf ${attribute} needs at least one value`);
    clauses.push(`${ph.name(attribute)} IN (${values.map((value) => ph.value(value)).join(", ")})`);
  }
  for (const attribute of cond?.absent ?? []) clauses.push(`attribute_not_exists(${ph.name(attribute)})`);
  return { expression: clauses.length > 0 ? clauses.join(" AND ") : undefined, names: ph.names, values: ph.values };
}

const KEY_ATTRIBUTES = new Set(["PK", "SK"]);

// SET every defined attribute, REMOVE the null ones, bump `version` and stamp `updatedAt`.
export function updateExpression(patch: Patch, updatedAt: string, cond: WriteCondition | undefined): UpdateExpression {
  const ph = new Placeholders();
  const sets: string[] = [];
  const removes: string[] = [];
  for (const [attribute, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (KEY_ATTRIBUTES.has(attribute)) throw new RangeError("keys are immutable");
    if (attribute === "version" || attribute === "updatedAt") throw new RangeError(`${attribute} is stamped by the connector`);
    if (value === null) removes.push(ph.name(attribute));
    else sets.push(`${ph.name(attribute)} = ${ph.value(value)}`);
  }
  sets.push(`${ph.name("updatedAt")} = ${ph.value(updatedAt)}`);
  sets.push(`${ph.name("version")} = if_not_exists(${ph.name("version")}, ${ph.value(0)}) + ${ph.value(1)}`);
  const parts = [`SET ${sets.join(", ")}`];
  if (removes.length > 0) parts.push(`REMOVE ${removes.join(", ")}`);
  const conditionPart = condition(cond, ph);
  return { expression: parts.join(" "), conditionExpression: conditionPart.expression, names: ph.names, values: ph.values };
}

function defaultsClauses(ph: Placeholders, defaults: Patch | undefined): string[] {
  const sets: string[] = [];
  for (const [name, value] of Object.entries(defaults ?? {})) {
    if (value === undefined || value === null) continue;
    if (KEY_ATTRIBUTES.has(name)) throw new RangeError("keys are immutable");
    sets.push(`${ph.name(name)} = if_not_exists(${ph.name(name)}, ${ph.value(value)})`);
  }
  return sets;
}

// ADD on the counter with an optional ceiling and `if_not_exists` defaults for a fresh row.
export function incrementExpression(attribute: string, by: number, updatedAt: string, max: number | undefined, defaults: Patch | undefined): UpdateExpression {
  if (max !== undefined && by > max) throw new RangeError(`increment ${by} exceeds the ceiling ${max}`);
  const ph = new Placeholders();
  const counter = ph.name(attribute);
  const increment = ph.value(by);
  const sets = [`${ph.name("updatedAt")} = ${ph.value(updatedAt)}`, ...defaultsClauses(ph, defaults)];
  const expression = `ADD ${counter} ${increment} SET ${sets.join(", ")}`;
  const conditionExpression = max === undefined ? undefined : `(attribute_not_exists(${counter}) OR ${counter} <= ${ph.value(max - by)})`;
  return { expression, conditionExpression, names: ph.names, values: ph.values };
}

// ADD or DELETE string-set members; DocumentClient marshals a JS Set to a DynamoDB SS.
export function setExpression(
  operation: "ADD" | "DELETE",
  attribute: string,
  values: readonly string[],
  updatedAt: string,
  defaults: Patch | undefined,
  cond: WriteCondition | undefined,
): UpdateExpression {
  if (values.length === 0) throw new RangeError("a set update needs at least one value");
  const ph = new Placeholders();
  const member = `${operation} ${ph.name(attribute)} ${ph.value(new Set(values))}`;
  const sets = [`${ph.name("updatedAt")} = ${ph.value(updatedAt)}`, ...defaultsClauses(ph, defaults)];
  const conditionPart = condition(cond, ph);
  return { expression: `${member} SET ${sets.join(", ")}`, conditionExpression: conditionPart.expression, names: ph.names, values: ph.values };
}

/** Drops a placeholder map when it is empty (DynamoDB rejects empty maps). */
export function omitEmpty<T extends Record<string, unknown>>(map: T): T | undefined {
  return Object.keys(map).length > 0 ? map : undefined;
}
