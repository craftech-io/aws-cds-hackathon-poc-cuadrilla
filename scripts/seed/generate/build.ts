// The whole seed in memory (docs/seed-spec.md §1): every file of the data directory as bytes, built
// from the catalog, copy/, the manual and the datasheets of WP-18. `generate.ts` validates it and
// writes it; the determinism test builds it twice in separate processes and compares the bytes.
import { DATA_LAYOUT, tableFile, worldFile } from "../lib/paths";
import { SEED_TABLES, WORLD_TABLES, compareItems, emptyTables, type SeedItem, type SeedTable, type WorldTable } from "../lib/tables";
import { SEED, stableJson } from "../photos/prng";
import { SEED_CLOCK, GENERATOR } from "./context";
import { conversationItems } from "./conversations";
import { historyItems, overrideDecisions } from "./history";
import { MANUAL_SECTIONS, manualFiles } from "./manual/index";
import { historyPhotosByOrder, historyReadings, readMedia, type Media, type OrderHistoryPhotos } from "./media";
import { kpiItems } from "./metrics";
import { nameCheckItems } from "./namecheck";
import { dispatchItems, networkItems, workOrderItems } from "./orders";
import { ispItems } from "./org";
import { consentItems, customerCatalog, customerItems, personItems, profileItems, type CustomerDef } from "./people";
import { evalQuestions } from "./questions";
import { rateCardItems } from "./ratecard";
import { evalPhoto, referenceItems } from "./reference";
import { evalTemplate, modelsTemplate, qaMinTemplate, worldTemplate } from "./templates";
import { dayStartTimers } from "./timers";
import { demoWorld, judgeWorld, type WorldSpec } from "./world";

export interface BuiltSeed {
  /** Every file of the data directory but the manifest, by its path inside the directory. */
  readonly files: Map<string, string>;
  readonly media: Media;
}

function worldTables(world: WorldSpec, customers: readonly CustomerDef[], photos: ReadonlyMap<string, OrderHistoryPhotos>): Record<WorldTable, SeedItem[]> {
  const byNumber = new Map(customers.map((customer) => [customer.customer, customer]));
  const ownCustomers = world.kind === "DEMO" ? customers : customers.filter((customer) => world.orders.some((order) => order.customer === customer.customer));
  const history = historyItems(world, photos, byNumber);
  const conversation = conversationItems(world, byNumber);
  const timers = dayStartTimers(world);
  const personTimers = timers.filter((timer) => (timer.home as { kind: string }).kind === "PERSON");
  const orderTimers = timers.filter((timer) => (timer.home as { kind: string }).kind === "WORK_ORDER");
  const tables: Record<WorldTable, SeedItem[]> = {
    Isps: ispItems(world),
    People: [...personItems(world, conversation.lastInboundAtSim), ...consentItems(world), ...profileItems(world, history.profileEvents), ...customerItems(world, ownCustomers), ...personTimers],
    WorkOrders: [...workOrderItems(world), ...history.items, ...orderTimers],
    Cases: [],
    Conversations: conversation.messages,
    AuditLog: [...conversation.decisions, ...overrideDecisions(history.items, world.ispId)],
    CuadrillaMetrics: kpiItems(world, history.validations),
    Network: networkItems(world),
    Dispatch: dispatchItems(world),
  };
  for (const table of WORLD_TABLES) tables[table].sort(compareItems);
  return tables;
}

function tableFileText(table: SeedTable, items: readonly SeedItem[]): string {
  return stableJson({ table, generatedAt: SEED_CLOCK, seed: SEED, count: items.length, items });
}

export function buildSeed(): BuiltSeed {
  const media = readMedia();
  const photos = historyPhotosByOrder(media);
  const readings = historyReadings(media);
  const demo = demoWorld(readings);
  const judge = judgeWorld(readings);
  const customers = customerCatalog(demo.orders);
  const customersByNumber = new Map(customers.map((customer) => [customer.customer, customer]));
  const manual = manualFiles();
  const questions = evalQuestions();

  const tables = emptyTables();
  const demoTables = worldTables(demo, customers, photos);
  for (const table of WORLD_TABLES) tables[table] = demoTables[table];
  tables.Reference = referenceItems({ media, sections: MANUAL_SECTIONS, manualFiles: manual, questions, rateCard: rateCardItems(), nameChecks: nameCheckItems() }).sort(compareItems);

  const files = new Map<string, string>();
  for (const table of SEED_TABLES) files.set(tableFile(table), tableFileText(table, tables[table]));
  for (const [path, text] of manual) files.set(path, text);
  files.set(DATA_LAYOUT.questions, stableJson({ setVersion: "v001", manualVersion: "v001", generator: GENERATOR, seed: SEED, questions }));
  files.set(DATA_LAYOUT.photos, stableJson({ setVersion: "v001", generator: GENERATOR, seed: SEED, photos: media.set.map(evalPhoto) }));
  files.set(worldFile("demo"), stableJson(worldTemplate(demo, demoTables)));
  files.set(worldFile("judge"), stableJson(worldTemplate(judge, worldTables(judge, customers, photos))));
  files.set(worldFile("models"), stableJson(modelsTemplate(demo, customersByNumber)));
  files.set(worldFile("qa-min"), stableJson(qaMinTemplate()));
  files.set(worldFile("eval"), stableJson(evalTemplate(questions, media.set)));
  return { files, media };
}
