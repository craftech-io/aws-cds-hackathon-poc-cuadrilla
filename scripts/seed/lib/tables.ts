// The table files of the seed (docs/seed-spec.md §1): one JSON per table with the items the loader
// writes as they are (`PK`, `SK`, GSI attributes, `entity`, record metadata, `synthetic: true`).
// `Runtime` is never seeded (invariant 14): the loader creates the world clocks itself.
import { z } from "zod";
import { IsoInstant } from "@cuadrilla/shared";
import { SEED } from "../photos/prng";

/** Tables of the domain (packages/bff/src/domain/registry.ts) the seed writes. */
export const DOMAIN_SEED_TABLES = ["Isps", "People", "WorkOrders", "Cases", "Conversations", "AuditLog", "Reference", "CuadrillaMetrics"] as const;
export type DomainSeedTable = (typeof DOMAIN_SEED_TABLES)[number];

/** Tables owned by the mocks of external systems (network orchestrator, dispatch). */
export const MOCK_SEED_TABLES = ["Network", "Dispatch"] as const;

export const SEED_TABLES = [...DOMAIN_SEED_TABLES, ...MOCK_SEED_TABLES] as const;
export const SeedTable = z.enum(SEED_TABLES);
export type SeedTable = z.infer<typeof SeedTable>;

/** Tables whose items belong to a world (everything but the reference catalogs). */
export const WORLD_TABLES = SEED_TABLES.filter((table) => table !== "Reference");
export type WorldTable = Exclude<SeedTable, "Reference">;

export const SeedItem = z.record(z.string(), z.unknown());
export type SeedItem = z.infer<typeof SeedItem>;

export const TableFile = z
  .object({
    table: SeedTable,
    generatedAt: IsoInstant,
    seed: z.literal(SEED),
    count: z.int().min(0),
    items: z.array(SeedItem),
  })
  .strict()
  .refine((file) => file.count === file.items.length, { message: "count differs from items.length", path: ["count"] });
export type TableFile = z.infer<typeof TableFile>;

export function isDomainSeedTable(table: SeedTable): table is DomainSeedTable {
  return (DOMAIN_SEED_TABLES as readonly string[]).includes(table);
}

export function emptyTables(): Record<SeedTable, SeedItem[]> {
  return Object.fromEntries(SEED_TABLES.map((table) => [table, []])) as unknown as Record<SeedTable, SeedItem[]>;
}

/** Sort key of an item inside its table file: partition, then sort key. */
export function compareItems(a: SeedItem, b: SeedItem): number {
  const left = `${String(a.PK)}\u0000${String(a.SK)}`;
  const right = `${String(b.PK)}\u0000${String(b.SK)}`;
  return left < right ? -1 : left > right ? 1 : 0;
}
