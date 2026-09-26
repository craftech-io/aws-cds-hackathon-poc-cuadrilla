// The domain against its sources: the registry covers every entity with a table and a row codec,
// the connector's index map is exactly infra/storage-keys.ts (WP-06), the world policy scopes items
// as docs/architecture.md §5 and docs/seed-spec.md §13 say, and the rows ops/ writes for the cost
// caps and the kill switch (ADR-0019) parse with the schemas the registry holds for them.
import { describe, expect, it } from "vitest";
import { TABLE_SPECS } from "../../../../infra/storage-keys";
import { CODECS, encodeRow } from "../connector/codecs";
import { INDEXES, TTL_TABLES } from "../connector/table-client";
import { defaultWorldPolicy } from "../connector/world";
import { CapLedger, CapPeriod, CostResource } from "../ops/cost-caps";
import { KillActor, KillState, KillSwitchRecord } from "../ops/kill-switch";
import { EntityName, HistoryEntry, NewEntity } from "./common";
import { DOMAIN_TABLES, ENTITIES, checkEntity, entitiesOf } from "./registry";
import { CapCounter, KillSwitch } from "./runtime";
import { WorkOrder } from "./work-orders";

const NOW = new Date("2026-10-13T13:00:00.000Z");
const EPOCH_NOW = Math.floor(NOW.getTime() / 1000);

describe("registry", () => {
  it("gives every entity a schema, a home table and a row codec", () => {
    expect(Object.keys(ENTITIES).sort()).toEqual([...EntityName.options].sort());
    expect(Object.keys(CODECS).sort()).toEqual([...EntityName.options].sort());
    for (const table of DOMAIN_TABLES) expect(entitiesOf(table).length).toBeGreaterThan(0);
    expect(entitiesOf("WorkOrders")).toContain("Timer");
    expect(entitiesOf("Cases")).toEqual(["Timer", "Case"]);
  });

  it("validates an item by its own discriminator and table, without echoing values", () => {
    const row = {
      entity: "Isp",
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      version: 1,
      ispId: "isp-demo",
      kind: "DEMO",
      clockId: "GLOBAL#isp-demo",
    };
    expect(checkEntity("Isps", row)).toMatchObject({ ok: true, entity: "Isp" });
    expect(checkEntity("People", row)).toEqual({ ok: false, error: "Isp does not belong to People" });
    expect(checkEntity("Isps", { ...row, entity: "Nope" })).toEqual({ ok: false, error: "unknown entity" });
    const bad = checkEntity("Isps", { ...row, opsMailbox: "+525501010001" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).not.toContain("+525501010001");
    expect(checkEntity("Isps", null)).toEqual({ ok: false, error: "item is not an object" });
  });

  it("keeps a dated history entry and lets callers skip what the connector stamps", () => {
    expect(HistoryEntry.safeParse({ field: "status", to: "CLOSED", atReal: NOW.toISOString(), actor: "AGENT" }).success).toBe(true);
    expect(HistoryEntry.safeParse({ field: "status", to: "CLOSED", atReal: NOW.toISOString(), actor: "robot" }).success).toBe(false);
    const input: NewEntity<typeof WorkOrder> = {
      workOrderId: "wo-24817",
      workOrderNumber: "24817",
      ispId: "isp-demo",
      clockId: "GLOBAL#isp-demo",
      worldEpoch: 1,
      installerId: "inst-rogelio",
      customerId: "cust-10421",
      crewId: "crew-n3",
      zoneId: "zone-norte",
      date: "2026-10-13",
      appointmentWindow: { startSim: "2026-10-13T11:00:00-06:00", endSim: "2026-10-13T09:00:00-06:00" },
      plan: "Fibra 300",
      onuSerial: "DEMO3F2C19A0",
      onuModel: "ONU-G1",
      oltPort: "OLT-N3/1/4",
      opticalClass: "B+",
      status: "SCHEDULED",
    };
    const parsed = WorkOrder.safeParse({ ...input, entity: "WorkOrder", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), version: 1 });
    expect(parsed.success).toBe(false);
  });
});

describe("row codecs", () => {
  it("index exactly the GSIs and TTLs infra/storage-keys.ts creates", () => {
    for (const table of DOMAIN_TABLES) {
      const infra = Object.fromEntries(Object.entries(TABLE_SPECS[table].indexes).map(([name, spec]) => [name, { hash: spec.hashKey, ...("rangeKey" in spec ? { range: spec.rangeKey } : {}) }]));
      expect(INDEXES[table] ?? {}, table).toEqual(infra);
      expect(TTL_TABLES.includes(table), table).toBe(TABLE_SPECS[table].ttl);
    }
  });

  it("build the keys of docs/architecture.md §5 and normalize sort-key instants to UTC", () => {
    expect(encodeRow("Message", { personId: "inst-rogelio", sentAtSim: "2026-10-13T09:20:00-06:00", messageId: "m1", workOrderId: "wo-24817" })).toMatchObject({
      table: "Conversations",
      key: { PK: "PERSON#inst-rogelio", SK: "MSG#2026-10-13T15:20:00.000Z#m1" },
      gsi: { workOrderKey: "WO#wo-24817", sentAtSim: "2026-10-13T15:20:00.000Z" },
    });
    expect(encodeRow("Timer", { home: { kind: "CASE", id: "case-x" }, kind: "CASE_TIMEOUT", timerId: "PRIMARY", clockId: "JUDGE#isp-judge-07", status: "FIRED", dueAtSim: "2026-10-13T12:00:00-06:00" })).toMatchObject({
      table: "Cases",
      key: { PK: "CASE#case-x", SK: "TIMER#CASE_TIMEOUT#PRIMARY" },
      gsi: {},
    });
    expect(encodeRow("Decision", { ispId: "isp-demo", ts: "2026-10-31T23:30:00-06:00", decisionId: "d1", decision: "ALLOW", refs: {} }).key).toEqual({ PK: "ISP#isp-demo#2026-11", SK: "2026-11-01T05:30:00.000Z#d1" });
    expect(encodeRow("KillSwitch", { scope: "AGENT", clockId: "qa-812-1-sc-02" }).key).toEqual({ PK: "KILL#AGENT#qa-812-1-sc-02", SK: "META" });
    expect(encodeRow("ManualIndex", { manualVersion: "v001", sectionId: "COM-04" }).key).toEqual({ PK: "REF#MANUALINDEX#v001", SK: "COM-04" });
    expect(() => encodeRow("Person", { personId: "" })).toThrow(/Person: missing key field personId/);
    expect(() => encodeRow("Message", { personId: "inst-rogelio", sentAtSim: "yesterday", messageId: "m1" })).toThrow(expect.objectContaining({ code: "VALIDATION" }));
  });
});

describe("world policy", () => {
  it("scopes QA and evaluation worlds for 48 h, tags judge worlds and keeps the demo world", () => {
    const qa = defaultWorldPolicy("qa-812-1-sc-02", "WorkOrders", NOW);
    expect(qa).toEqual({ world: "qa", expiresAt: EPOCH_NOW + 48 * 3600 });
    expect(defaultWorldPolicy("eval-812-1", "Cases", NOW)).toEqual({ world: "eval", expiresAt: EPOCH_NOW + 48 * 3600 });
    expect(defaultWorldPolicy("JUDGE#isp-judge-test", "People", NOW)).toEqual({ world: "qa" });
    expect(defaultWorldPolicy("JUDGE#isp-judge-07", "People", NOW)).toEqual({ world: "judge" });
    expect(defaultWorldPolicy("GLOBAL#isp-demo", "WorkOrders", NOW)).toEqual({});
    expect(defaultWorldPolicy("GLOBAL#isp-demo", "Conversations", NOW)).toEqual({ expiresAt: EPOCH_NOW + 90 * 86400 });
    expect(defaultWorldPolicy("JUDGE#isp-judge-07", "AuditLog", NOW)).toEqual({ world: "judge", expiresAt: EPOCH_NOW + 365 * 86400 });
    expect(defaultWorldPolicy(undefined, "Runtime", NOW)).toEqual({});
    expect(defaultWorldPolicy("qa-812-1-sc-02", "Reference", NOW)).toEqual({});
  });
});

describe("rows ops/ writes in Runtime", () => {
  it("cap counters and kill switches parse with the registry's schemas", () => {
    expect(CapCounter.shape.ledger.options).toEqual(CapLedger.options);
    expect(CapCounter.shape.resource.options).toEqual(CostResource.options);
    expect(CapCounter.shape.period.options).toEqual(CapPeriod.options);
    expect(KillSwitch.shape.state.options).toEqual(KillState.options);
    expect(KillSwitch.shape.setBy.options).toEqual(KillActor.options);
    const counter = { PK: "SIMCAP#JUDGE#isp-judge-07#turns#2026-10-13", SK: "META", entity: "CapCounter", used: 3, ledger: "SIMULATOR", resource: "turns", period: "DAY", capLimit: 300, expiresAt: EPOCH_NOW, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() };
    expect(checkEntity("Runtime", counter)).toMatchObject({ ok: true, entity: "CapCounter" });
    expect(encodeRow("CapCounter", counter).key).toEqual({ PK: counter.PK, SK: "META" });
    const record = KillSwitchRecord.parse({ scope: "AGENT", clockId: "qa-812-1-sc-02", state: "on", setBy: "QA", setAtReal: NOW.toISOString() });
    expect(checkEntity("Runtime", { PK: "KILL#AGENT#qa-812-1-sc-02", SK: "META", entity: "KillSwitch", ...record, updatedAt: record.setAtReal })).toMatchObject({ ok: true, entity: "KillSwitch" });
  });
});
