// The operator's demo world (`GLOBAL#isp-demo`, docs/seed-spec.md §3-§7) from `Seed/worlds/demo.json`,
// row by row, with what the template cannot know:
//
//   Isps/META          the visible name of `resolveBrand` and the operations mailbox of the overrides
//   Isps/SETTINGS      `whatsappMode: live` only when the overrides name this world as the live one
//   Isps/USER#         the Cognito `sub` `console:invite` bound is kept across reloads
//   People/PERSON      the team's real phones of `SeedOverrides.personPhones` (this is the operator's demo
//                      world, the only one they may enter) and the zone chiefs' mailboxes; the phone hash
//   WorkOrders         the world's epoch on orders and evidence; historical certificates `pdfPending`
//                      until they are rendered (worlds/certificates.ts)
//
// The clock is created once (`PAUSED` at the template's start, a fresh epoch); a world that exists is
// reloaded through "Reiniciar demo" (worlds/rebuild.ts), never written over in place.
import { ConnectorError, DEMO_CLOCK_ID, DEMO_ISP_ID } from "@cuadrilla/shared";
import type { Item, MockTable, Table } from "../connector/table-client";
import { defaultWorldPolicy } from "../connector/world";
import type { DomainTable } from "../domain/registry";
import type { SeedOverridesValue } from "../lib/secret-schemas";
import { worldDisplayName } from "./brand";
import { MOCK_TABLES, stampWorkOrderRow } from "./clone";
import { type WorldsDeps, liveWorldOf, readOverrides } from "./deps";
import { writeWorldRows } from "./factory";
import { whatsappModeOf } from "./live-world";
import { TemplateError } from "./template";
import { type DemoTemplate, loadTemplate } from "./templates";

export const DEMO_TEMPLATE = "demo";

export interface DemoRowsInput {
  readonly template: DemoTemplate;
  readonly worldEpoch: number;
  readonly displayName: string;
  readonly whatsappMode: "live" | "simulated";
  readonly overrides: SeedOverridesValue;
  readonly phoneHash: (phone: string) => string;
  /** The `sub` of each console user already bound. */
  readonly boundSubs: ReadonlyMap<string, string>;
  readonly now: Date;
}

export interface DemoRows {
  readonly domain: Map<DomainTable, Item[]>;
  readonly mocks: Map<MockTable, Item[]>;
}

function adaptIsps(row: Item, input: DemoRowsInput): Item {
  switch (row.entity) {
    case "Isp":
      return { ...row, displayName: input.displayName, ...(input.overrides.opsMailbox === undefined ? {} : { opsMailbox: input.overrides.opsMailbox }) };
    case "IspSettings":
      return { ...row, whatsappMode: input.whatsappMode };
    case "ConsoleUser": {
      const sub = input.boundSubs.get(String(row.userId));
      return sub === undefined || sub === "" ? row : { ...row, cognitoSub: sub };
    }
    default:
      return row;
  }
}

function adaptPeople(row: Item, input: DemoRowsInput): Item {
  if (row.entity !== "Person") return row;
  const personId = String(row.personId);
  const phone = input.overrides.personPhones?.[personId] ?? (typeof row.phone === "string" ? row.phone : undefined);
  const email = input.overrides.zoneChiefEmails?.[personId];
  return { ...row, ...(phone === undefined ? {} : { phone, phoneHash: input.phoneHash(phone) }), ...(email === undefined ? {} : { email }) };
}

function adaptWorkOrders(row: Item, input: DemoRowsInput): Item {
  const stamped = stampWorkOrderRow(row, input.worldEpoch, DEMO_CLOCK_ID);
  return stamped.entity === "Certificate" && (stamped.sha256 === undefined || stamped.s3Key === undefined) ? { ...stamped, pdfPending: true } : stamped;
}

/** Every row of the demo world, adapted; throws before any write for a row outside the demo world. */
export function demoRows(input: DemoRowsInput): DemoRows {
  const domain = new Map<DomainTable, Item[]>();
  const mocks = new Map<MockTable, Item[]>();
  const at = input.now.toISOString();
  for (const [table, rows] of Object.entries(input.template.tables)) {
    const items = rows.map((raw, index) => {
      if (typeof raw.PK !== "string" || typeof raw.SK !== "string") throw new TemplateError(`demo ${table} row ${index} has no key`);
      if (raw.clockId !== undefined && raw.clockId !== DEMO_CLOCK_ID) throw new TemplateError(`demo ${table} row ${index} names another world`);
      let row: Item = { ...raw, PK: raw.PK, SK: raw.SK };
      if (table === "Isps") row = adaptIsps(row, input);
      else if (table === "People") row = adaptPeople(row, input);
      else if (table === "WorkOrders") row = adaptWorkOrders(row, input);
      const stamp = defaultWorldPolicy(DEMO_CLOCK_ID, table as Table, input.now);
      return { ...row, ...(stamp.expiresAt === undefined ? {} : { expiresAt: stamp.expiresAt }), createdAt: at, updatedAt: at };
    });
    if (items.length === 0) continue;
    if ((MOCK_TABLES as readonly string[]).includes(table)) mocks.set(table as MockTable, items);
    else domain.set(table as DomainTable, items);
  }
  return { domain, mocks };
}

async function boundSubs(deps: Pick<WorldsDeps, "connector">): Promise<Map<string, string>> {
  const users = await deps.connector.isps.listUsers(DEMO_ISP_ID);
  return new Map(users.filter((user) => user.cognitoSub !== "").map((user) => [user.userId, user.cognitoSub]));
}

/** Writes the demo world's rows at `worldEpoch` (its clock exists); answers the template's start. */
export async function writeDemoWorld(deps: WorldsDeps, worldEpoch: number): Promise<{ readonly startAtSim: string; readonly counts: Record<string, number> }> {
  const template = await loadTemplate(deps.templates, "demo");
  const live = liveWorldOf(deps);
  const rows = demoRows({
    template,
    worldEpoch,
    displayName: worldDisplayName(deps.brand(), DEMO_CLOCK_ID),
    whatsappMode: whatsappModeOf(DEMO_CLOCK_ID, live),
    overrides: readOverrides(deps),
    phoneHash: deps.phoneHash,
    boundSubs: await boundSubs(deps),
    now: deps.now(),
  });
  await writeWorldRows(deps, rows);
  await deps.certificates?.render({ clockId: DEMO_CLOCK_ID, ispId: DEMO_ISP_ID }, "PENDING");
  const counts: Record<string, number> = {};
  for (const [table, items] of [...rows.domain, ...rows.mocks]) counts[table] = items.length;
  return { startAtSim: template.startAtSim, counts };
}

/** Creates the demo world (clock and rows); CONFLICT when its clock already exists (reset it instead). */
export async function createDemoWorld(deps: WorldsDeps): Promise<{ readonly clockId: string; readonly worldEpoch: number; readonly counts: Record<string, number> }> {
  if ((await deps.connector.runtime.getClock(DEMO_CLOCK_ID)) !== undefined) throw new ConnectorError("CONFLICT", "the demo world exists: reset it", "Runtime");
  const template = await loadTemplate(deps.templates, "demo");
  const worldEpoch = await deps.connector.runtime.nextEpoch(DEMO_CLOCK_ID);
  await deps.connector.runtime.createClock({
    clockId: DEMO_CLOCK_ID,
    ispId: DEMO_ISP_ID,
    kind: "DEMO",
    mode: "PAUSED",
    offsetMs: 0,
    pausedSimNow: template.startAtSim,
    worldEpoch,
    template: DEMO_TEMPLATE,
    settings: { startAtSim: template.startAtSim },
  });
  const written = await writeDemoWorld(deps, worldEpoch);
  return { clockId: DEMO_CLOCK_ID, worldEpoch, counts: written.counts };
}
