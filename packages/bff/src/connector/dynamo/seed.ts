// Seed store: bulk writes of validated rows for `seed:load` and the world factory. Every row must be
// a valid entity of its table and carry the key its codec computes (the seed and the product never
// disagree on where a row lives); GSI attributes and sort-key instants are recomputed here, and the
// world policy stamps `world`/`expiresAt` on rows of cloned worlds that do not bring their own.
// A person with a phone gets its `ADDR#<clockId>#<phoneHash>` claim in the same load, and two people
// of one world with the same phone make the whole load fail: the seed never bypasses uniqueness.
import { ConnectorError } from "@cuadrilla/shared";
import { AddressClaim } from "../../domain/people";
import { checkEntity, type DomainTable } from "../../domain/registry";
import { encodeRow } from "../codecs";
import type { SeedStore } from "../ports-runtime";
import { TTL_ATTRIBUTE, type Item } from "../table-client";
import { entityRow, type RepoContext } from "./repo";

export function seedStore(ctx: RepoContext): SeedStore {
  const { client } = ctx;

  function prepare(table: DomainTable, item: Item, index: number): Item {
    const check = checkEntity(table, item);
    if (!check.ok) throw new ConnectorError("VALIDATION", `${table} item ${index}: ${check.error}`, table);
    const encoded = encodeRow(check.entity, item);
    if (encoded.table !== table || encoded.key.PK !== item.PK || encoded.key.SK !== item.SK) {
      throw new ConnectorError("VALIDATION", `${table} item ${index} (${check.entity}) is not stored at the key its codec computes`, table);
    }
    const scope = ctx.worldPolicy(typeof item.clockId === "string" ? item.clockId : undefined, table, ctx.now());
    return {
      ...(scope.world === undefined ? {} : { world: scope.world }),
      ...(scope.expiresAt === undefined ? {} : { [TTL_ATTRIBUTE]: scope.expiresAt }),
      ...item,
      ...encoded.fields,
      ...encoded.gsi,
      ...encoded.key,
    };
  }

  /** Claims of the people in the load; a phone claimed twice in one world fails the load. */
  function claimsOf(rows: readonly Item[]): Item[] {
    const claims = new Map<string, Item>();
    for (const row of rows) {
      if (row.entity !== "Person" || typeof row.phoneHash !== "string") continue;
      const claim = entityRow(ctx, AddressClaim, "AddressClaim", { clockId: row.clockId, phoneHash: row.phoneHash, personId: row.personId, synthetic: row.synthetic === true });
      const holder = claims.get(claim.item.PK);
      if (holder !== undefined && holder.personId !== row.personId) throw new ConnectorError("VALIDATION", "two people of one world share a phone", "People");
      claims.set(claim.item.PK, claim.item);
    }
    const explicit = new Set(rows.filter((row) => row.entity === "AddressClaim").map((row) => row.PK));
    return [...claims.values()].filter((claim) => !explicit.has(claim.PK));
  }

  return {
    async loadItems(table, items) {
      const rows = items.map((item, index) => prepare(table, item, index));
      const all = table === "People" ? [...rows, ...claimsOf(rows)] : rows;
      await client.batchPut(table, all);
      return { table, written: all.length };
    },
    getItem: (table, key) => client.get(table, key),
    deleteItems: (table, keys) => client.batchDelete(table, keys),
  };
}
