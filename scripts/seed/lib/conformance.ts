// Every seeded item against the product's own schemas: a domain item must be a valid entity of its
// table (domain/registry.ts) stored at the key, with the GSI attributes and in the normalized form its
// codec computes (connector/codecs.ts), exactly as the seed store of the connector would accept it;
// `Network` and `Dispatch` items must be rows the mocks read (their own zod schemas). The generator
// builds rows through the same codecs, the validator and `conforms-to-domain.test.ts` check them here,
// and the loader (WP-39) stamps what only a load knows with `asLoaded`.
//
// What the seed never carries (docs/seed-spec.md §14, invariant 16): the world epoch. The loader takes
// it from `Runtime/COUNTER#EPOCH#<clockId>` and stamps it on work orders and evidence, together with
// the evidence's repeated-photo key (`GSI4`), which embeds it.
import { DispatchEventItem, DispatchOrderItem } from "../../../packages/dispatch-mock/src/items";
import { OnuRow } from "../../../packages/network-mock/src/rows";
import { encodeRow } from "../../../packages/bff/src/connector/codecs";
import type { EntityName } from "../../../packages/bff/src/domain/common";
import { checkEntity } from "../../../packages/bff/src/domain/registry";
import { isDomainSeedTable, type SeedItem, type SeedTable } from "./tables";

/** Fields (and GSI attributes) of an entity that only the loader can write, because they depend on the world epoch. */
export const LOADER_STAMPED: Readonly<Partial<Record<EntityName, readonly string[]>>> = {
  WorkOrder: ["worldEpoch"],
  Evidence: ["worldEpoch", "evidenceHash"],
};

/** Epoch the checks stamp when they need a loaded item; any valid epoch gives the same verdict. */
export const CHECK_EPOCH = 1;

function entityOf(item: SeedItem): string | undefined {
  return typeof item.entity === "string" ? item.entity : undefined;
}

/** The item as the loader writes it in a world of epoch `worldEpoch`: work orders and evidence get the epoch. */
export function asLoaded(item: SeedItem, worldEpoch: number): SeedItem {
  const entity = entityOf(item);
  return entity !== undefined && (LOADER_STAMPED[entity as EntityName] ?? []).includes("worldEpoch") ? { ...item, worldEpoch } : item;
}

function describe(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function checkDomainItem(table: SeedTable, item: SeedItem): string[] {
  const loaded = asLoaded(item, CHECK_EPOCH);
  if (!isDomainSeedTable(table)) return [`${table} is not a domain table`];
  const check = checkEntity(table, loaded);
  if (!check.ok) return [check.error];
  const entity = check.entity;
  const stamped = new Set(LOADER_STAMPED[entity] ?? []);
  const errors: string[] = [];
  for (const field of stamped) if (field in item) errors.push(`${entity} carries ${field}, which only the loader writes`);
  let encoded: ReturnType<typeof encodeRow>;
  try {
    encoded = encodeRow(entity, loaded);
  } catch (error) {
    return [`${entity}: ${(error as Error).message}`];
  }
  if (encoded.table !== table) errors.push(`${entity} belongs to ${encoded.table}, not ${table}`);
  if (encoded.key.PK !== item.PK || encoded.key.SK !== item.SK) {
    errors.push(`${entity} is stored at ${describe(item.PK)} / ${describe(item.SK)} instead of ${encoded.key.PK} / ${encoded.key.SK}`);
  }
  for (const [name, value] of Object.entries(encoded.gsi)) {
    if (stamped.has(name)) continue;
    if (item[name] !== value) errors.push(`${entity} GSI attribute ${name} is ${describe(item[name])} instead of ${describe(value)}`);
  }
  for (const [name, value] of Object.entries(encoded.fields)) {
    if (stamped.has(name)) continue;
    if (typeof value === "string" && item[name] !== value) errors.push(`${entity} field ${name} is not in its stored form (${describe(value)})`);
  }
  return errors;
}

function checkMockItem(table: SeedTable, item: SeedItem): string[] {
  if (table === "Network") {
    const parsed = OnuRow.safeParse(item);
    return parsed.success ? [] : parsed.error.issues.map((issue) => `Onu ${issue.path.join(".")} ${issue.message}`);
  }
  const schema = entityOf(item) === "DispatchOrder" ? DispatchOrderItem : entityOf(item) === "DispatchEvent" ? DispatchEventItem : undefined;
  if (schema === undefined) return [`unknown Dispatch entity ${describe(item.entity)}`];
  const parsed = schema.safeParse(item);
  return parsed.success ? [] : parsed.error.issues.map((issue) => `${describe(item.entity)} ${issue.path.join(".")} ${issue.message}`);
}

/** Why `item` is not a row `table` accepts; empty when it conforms. */
export function checkSeedItem(table: SeedTable, item: SeedItem): string[] {
  return isDomainSeedTable(table) ? checkDomainItem(table, item) : checkMockItem(table, item);
}

export interface ConformanceError {
  readonly table: SeedTable;
  readonly index: number;
  readonly key: string;
  readonly error: string;
}

/** Every error of every item of `items`, with where it is. */
export function checkTable(table: SeedTable, items: readonly SeedItem[]): ConformanceError[] {
  return items.flatMap((item, index) => checkSeedItem(table, item).map((error) => ({ table, index, key: `${describe(item.PK)} / ${describe(item.SK)}`, error })));
}
