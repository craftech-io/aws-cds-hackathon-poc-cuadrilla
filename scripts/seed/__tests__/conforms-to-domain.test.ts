// Every seeded item against the product's own schemas (docs/seed-spec.md §1, §15): each item of each
// table file and of the demo and judge templates is a valid entity of its table, stored at the key and
// with the GSI attributes its codec computes, and the connector's seed store (the one `seed:load`
// and the world factory use) accepts it once the loader stamps the world epoch. The mock tables are
// rows their mocks read, and the model templates only point to orders, questions and photos that exist.
import { describe, expect, it } from "vitest";
import { testConnector } from "../../../packages/bff/src/connector/testing";
import { REFERENCE_ENTITIES } from "../../../packages/bff/src/domain/reference";
import { asLoaded, checkSeedItem, checkTable } from "../lib/conformance";
import { DATA_DIR, fromRoot } from "../lib/paths";
import { DOMAIN_SEED_TABLES, SEED_TABLES, WORLD_TABLES, isDomainSeedTable, type SeedItem } from "../lib/tables";
import { bundleOf, readDataDir } from "../validate/bundle";

const bundle = bundleOf(readDataDir(fromRoot(DATA_DIR)));
const worlds: ReadonlyArray<{ readonly name: string; readonly tables: Partial<Record<string, readonly SeedItem[]>> }> = [
  { name: "table files", tables: bundle.tables },
  { name: "judge template", tables: bundle.judge?.tables ?? {} },
];

describe("seed items conform to the domain", () => {
  it("every file of the seed parses with its schema", () => {
    expect(bundle.problems).toEqual([]);
  });

  it.each(SEED_TABLES.map((table) => [table] as const))("every item of %s.json is a valid row of its table", (table) => {
    expect(bundle.tables[table].length).toBeGreaterThanOrEqual(table === "Cases" ? 0 : 1);
    expect(checkTable(table, bundle.tables[table])).toEqual([]);
  });

  it.each(WORLD_TABLES.map((table) => [table] as const))("every item of %s in the judge template is a valid row of its table", (table) => {
    const items = bundle.judge?.tables[table] ?? [];
    expect(checkTable(table, items)).toEqual([]);
  });

  it("the demo template is the world of the table files, item by item", () => {
    for (const table of WORLD_TABLES) expect(bundle.demo?.tables[table]).toEqual(bundle.tables[table]);
  });

  it.each(worlds.map((world) => [world.name, world.tables] as const))("the connector's seed store loads every domain item of the %s once the loader stamps the epoch", async (_name, tables) => {
    const { connector } = testConnector();
    for (const table of DOMAIN_SEED_TABLES) {
      const items = tables[table] ?? [];
      if (items.length === 0) continue;
      const loaded = items.map((item) => asLoaded(item, 3) as SeedItem & { PK: string; SK: string });
      const result = await connector.seed.loadItems(table, loaded);
      expect(result.written).toBeGreaterThanOrEqual(items.length);
    }
  });

  it("every Reference catalog row parses with the schema of its entity", () => {
    const schemas: Record<string, { safeParse(value: unknown): { success: boolean } }> = REFERENCE_ENTITIES;
    for (const item of bundle.tables.Reference) expect({ entity: item.entity, ok: schemas[String(item.entity)]?.safeParse(item).success }).toEqual({ entity: item.entity, ok: true });
  });

  it("refuses an item at the wrong key, one of another table and a work order that carries the epoch", () => {
    const order = bundle.tables.WorkOrders.find((item) => item.entity === "WorkOrder") as SeedItem;
    expect(checkSeedItem("WorkOrders", { ...order, SK: "CHECK#ONU_ONLINE" })).toEqual([expect.stringMatching(/is stored at/)]);
    expect(checkSeedItem("People", order)).toEqual(["WorkOrder does not belong to People"]);
    expect(checkSeedItem("WorkOrders", { ...order, worldEpoch: 2 })).toEqual(["WorkOrder carries worldEpoch, which only the loader writes"]);
    const onu = bundle.tables.Network[0] as SeedItem;
    expect(checkSeedItem("Network", { ...onu, PK: "ONU#GLOBAL#isp-demo#DEMO00000000" })).not.toEqual([]);
    expect(isDomainSeedTable("Network")).toBe(false);
  });
});

describe("the model templates point to what exists", () => {
  const models = new Set((bundle.models?.models ?? []).map((model) => model.model));
  const orders = bundle.tables.WorkOrders.filter((item) => item.entity === "WorkOrder").map((item) => item.workOrderId);

  it("the models are every order of the demo world (docs/seed-spec.md §3, `models`)", () => {
    expect([...models].sort()).toEqual([...orders].sort());
  });

  it("qa-min clones 24817 and 24820 and eval clones a model per question and per photo of the set", () => {
    expect(bundle.qaMin?.operations.map((operation) => operation.model)).toEqual(["wo-24817", "wo-24820"]);
    for (const operation of bundle.qaMin?.operations ?? []) expect(models.has(operation.model)).toBe(true);
    const evalTemplate = bundle.evalTemplate;
    expect(evalTemplate?.questions.map((question) => question.questionId)).toEqual(bundle.questions?.questions.map((question) => question.questionId));
    expect(evalTemplate?.photos.map((photo) => photo.photoId)).toEqual(bundle.media.set.map((photo) => photo.photoId));
    for (const entry of [...(evalTemplate?.questions ?? []), ...(evalTemplate?.photos ?? [])]) expect(models.has(entry.model)).toBe(true);
    for (const photo of evalTemplate?.photos ?? []) {
      const sheet = bundle.media.set.find((candidate) => candidate.photoId === photo.photoId);
      expect(photo.onu).toEqual({ behaviour: "ONLINE_OK", rxPowerDbm: sheet?.orchestratorRxDbm, operState: "ONLINE" });
    }
    expect(evalTemplate?.photos.find((photo) => photo.photoId === "ph-adv-04")?.precondition).toEqual({ seedPassEvidence: { photoId: "ph-meter-01", item: "POWER_READING_PHOTO", on: "separate-order" } });
  });
});
