// The invariants of docs/seed-spec.md §14 on the committed seed, and that each check would catch the
// fault it is written for. Invariant 10 runs here with the real contact policy
// (packages/bff/src/policy/): every outbound message of the history of the demo world and of the
// judge template, re-evaluated at the instant it left with the records of that instant, is allowed,
// and carries its ALLOW decision in the audit log.
import { describe, expect, it } from "vitest";
import type { Consent, Person } from "../../../packages/bff/src/domain/people";
import { Consent as ConsentSchema, Person as PersonSchema } from "../../../packages/bff/src/domain/people";
import { IspSettings, ShiftRoster } from "../../../packages/bff/src/domain/isps";
import { Message } from "../../../packages/bff/src/domain/conversations";
import { WorkOrder } from "../../../packages/bff/src/domain/work-orders";
import type { PolicyRecords } from "../../../packages/bff/src/policy/context";
import { evaluateSentAsOf } from "../../../packages/bff/src/policy/as-of";
import { localDate } from "../generate/time";
import { asLoaded } from "../lib/conformance";
import { DATA_LAYOUT, DATA_DIR, fromRoot, tableFile, worldFile } from "../lib/paths";
import type { SeedItem } from "../lib/tables";
import { bundleOf, readDataDir, worldsOf, type SeedWorld } from "../validate/bundle";
import { INVARIANTS, runInvariants, type InvariantResult } from "../validate/index";

const committed = readDataDir(fromRoot(DATA_DIR));
const env = { ci: false, ...(process.env.FORBIDDEN_TERMS === undefined ? {} : { forbiddenTerms: process.env.FORBIDDEN_TERMS }) };
const results = await runInvariants(bundleOf(committed), env);

/** The committed files with one JSON file changed by `mutate`. */
function mutated(path: string, mutate: (json: Record<string, unknown>) => void): Map<string, string> {
  const files = new Map(committed);
  const json = JSON.parse(files.get(path) ?? "{}") as Record<string, unknown>;
  mutate(json);
  files.set(path, JSON.stringify(json));
  return files;
}

async function errorsOf(files: ReadonlyMap<string, string>, id: number): Promise<readonly string[]> {
  const found = (await runInvariants(bundleOf(files), { ci: false })).find((result) => result.id === id);
  return found?.errors ?? [];
}

const itemsOf = (json: Record<string, unknown>): SeedItem[] => json.items as SeedItem[];
const judgeTables = (json: Record<string, unknown>): Record<string, SeedItem[]> => json.tables as Record<string, SeedItem[]>;

describe("seed invariants on the committed seed (docs/seed-spec.md §14)", () => {
  it("parses every file with its schema", () => {
    expect(results.find((result) => result.id === 0)).toBeUndefined();
  });

  it.each(INVARIANTS.map((invariant) => [invariant.id, invariant.title] as const))("invariant %i holds: %s", (id) => {
    const result = results.find((candidate) => candidate.id === id) as InvariantResult;
    expect(result.errors).toEqual([]);
  });
});

describe("invariant 10: no seeded message breaks the contact policy", () => {
  function recordsFor(world: SeedWorld, message: Message): PolicyRecords {
    const people = world.tables.People;
    const settings = IspSettings.parse(world.tables.Isps.find((item) => item.entity === "IspSettings"));
    const person: Person = PersonSchema.parse(people.find((item) => item.entity === "Person" && item.personId === message.personId));
    const consentItem = people.find((item) => item.entity === "Consent" && item.personId === message.personId);
    const consent: Consent | undefined = consentItem === undefined ? undefined : ConsentSchema.parse(consentItem);
    const thread = world.tables.Conversations.filter((item) => item.entity === "Message" && item.personId === message.personId).map((item) => Message.parse(item));
    const orderItem = world.tables.WorkOrders.find((item) => item.entity === "WorkOrder" && item.workOrderId === message.workOrderId);
    const workOrder = orderItem === undefined ? undefined : WorkOrder.parse(asLoaded(orderItem, 1));
    const crewId = workOrder?.crewId ?? person.crewId;
    const rosterItem = world.tables.Isps.find((item) => item.entity === "ShiftRoster" && item.crewId === crewId && item.date === localDate(message.sentAtSim));
    return {
      settings,
      person,
      ...(consent === undefined ? {} : { consent }),
      inbound: thread.filter((item) => item.direction === "IN").map((item) => ({ atSim: item.sentAtSim, live: !item.simulated })),
      dayStarts: thread.filter((item) => item.direction === "OUT" && item.kind === "DAY_START").map((item) => ({ messageId: item.messageId, sentAtSim: item.sentAtSim })),
      ...(workOrder === undefined ? {} : { workOrder }),
      cases: [],
      ...(rosterItem === undefined ? {} : { shiftRoster: ShiftRoster.parse(rosterItem) }),
    };
  }

  const worlds = worldsOf(bundleOf(committed));

  it.each(worlds.map((world) => [world.name, world] as const))("every outbound message of the %s history is allowed at its instant, with its ALLOW decision", (_name, world) => {
    const outbound = world.tables.Conversations.filter((item) => item.entity === "Message" && item.direction === "OUT").map((item) => Message.parse(item));
    expect(outbound.length).toBeGreaterThan(10);
    const decisions = new Map(world.tables.AuditLog.filter((item) => item.entity === "Decision").map((item) => [item.messageId, item]));
    for (const message of outbound) {
      const decision = evaluateSentAsOf(message, recordsFor(world, message));
      expect({ messageId: message.messageId, kind: message.kind, outcome: decision.outcome, deniedBy: decision.deniedBy }).toEqual({ messageId: message.messageId, kind: message.kind, outcome: "ALLOW", deniedBy: undefined });
      const audit = decisions.get(message.messageId);
      expect(audit).toMatchObject({ decision: "ALLOW", action: "SEND_WHATSAPP" });
      expect(message.policy?.decisionId).toBe(audit?.decisionId);
    }
  });

  it("would catch a message the policy denies: the day start moved into quiet hours, or sent to someone without opt-in", () => {
    const [demo] = worlds;
    if (demo === undefined) throw new Error("no demo world");
    const dayStart = demo.tables.Conversations.map((item) => Message.parse(item)).find((item) => item.kind === "DAY_START");
    if (dayStart === undefined) throw new Error("no day start in the history");
    const night = { ...dayStart, sentAtSim: "2026-10-12T22:30:00-06:00" };
    expect(evaluateSentAsOf(night, recordsFor(demo, night))).toMatchObject({ outcome: "DEFER", deniedBy: "CP-QUIET-HOURS" });
    const toJulian = { ...dayStart, personId: "inst-julian" };
    expect(evaluateSentAsOf(toJulian, recordsFor(demo, toJulian))).toMatchObject({ outcome: "DENY", deniedBy: "CP-OPTIN" });
  });
});

describe("each invariant catches its fault", () => {
  it("1: an order of 13/10 with an item already PASSED", async () => {
    const files = mutated(tableFile("WorkOrders"), (json) => {
      const check = itemsOf(json).find((item) => item.entity === "ChecklistItem" && item.PK === "WO#wo-24817" && item.item === "ROSETTE_PHOTO");
      if (check !== undefined) check.status = "PASSED";
    });
    expect(await errorsOf(files, 1)).toEqual([expect.stringMatching(/wo-24817: the five CHECK# are not all PENDING/)]);
  });

  it("3 and 17: a customer's phone outside the synthetic blocks and a repeated email", async () => {
    const files = mutated(tableFile("People"), (json) => {
      const customers = itemsOf(json).filter((item) => item.entity === "Customer");
      if (customers[0] !== undefined) customers[0].phone = "+525512345678";
      if (customers[1] !== undefined && customers[2] !== undefined) customers[2].email = customers[1].email;
    });
    const errors = await errorsOf(files, 3);
    expect(errors).toEqual(expect.arrayContaining([expect.stringMatching(/phone outside the synthetic blocks/), expect.stringMatching(/used more than once/)]));
  });

  it("5: a crew without its roster for a day with orders", async () => {
    const files = mutated(tableFile("Isps"), (json) => {
      json.items = itemsOf(json).filter((item) => !(item.entity === "ShiftRoster" && item.crewId === "crew-s1" && item.date === "2026-10-13"));
      json.count = itemsOf(json).length;
    });
    expect(await errorsOf(files, 5)).toEqual(["demo: no roster of crew-s1 on 2026-10-13"]);
  });

  it("7: a question that repeats nine words of the manual", async () => {
    const files = mutated(DATA_LAYOUT.questions, (json) => {
      const questions = json.questions as Array<{ questionId: string; text: string }>;
      const target = questions.find((question) => question.questionId === "q-A-13");
      if (target !== undefined) target.text = "Instálala a una altura de 30 a 40 cm sobre el piso?";
    });
    expect(await errorsOf(files, 7)).toEqual([expect.stringMatching(/q-A-13: repeats a phrase of the manual/)]);
  });

  it("11: without the list in CI the check fails closed; a listed term found in the seed fails without printing it", async () => {
    const closed = (await runInvariants(bundleOf(committed), { ci: true })).find((result) => result.id === 11);
    expect(closed?.errors).toEqual([expect.stringMatching(/fails closed in CI/)]);
    const listed = (await runInvariants(bundleOf(committed), { ci: true, forbiddenTerms: "Jacaranda" })).find((result) => result.id === 11);
    expect(listed?.errors.length).toBeGreaterThan(0);
    expect(listed?.errors.join("\n")).not.toMatch(/Jacaranda/);
  });

  it("16 and 24: a work order with an epoch and an operator with a visible name", async () => {
    const orders = mutated(tableFile("WorkOrders"), (json) => {
      const order = itemsOf(json).find((item) => item.entity === "WorkOrder");
      if (order !== undefined) order.worldEpoch = 1;
    });
    expect(await errorsOf(orders, 16)).toEqual([expect.stringMatching(/carries worldEpoch/)]);
    const isps = mutated(tableFile("Isps"), (json) => {
      const isp = itemsOf(json).find((item) => item.entity === "Isp");
      if (isp !== undefined) isp.displayName = "Operadora de ejemplo";
    });
    expect(await errorsOf(isps, 24)).toEqual([expect.stringMatching(/carries displayName/)]);
  });

  it("15: a table file changed after the manifest was written", async () => {
    const files = mutated(tableFile("Network"), (json) => {
      json.generatedAt = "2026-09-27T00:00:00.000Z";
    });
    expect(await errorsOf(files, 15)).toEqual(["manifest: checksum of Network.json differs"]);
  });

  it("18: a synthetic CURP with a valid check digit", async () => {
    const files = mutated(tableFile("People"), (json) => {
      const customer = itemsOf(json).find((item) => item.customerId === "cust-10425");
      if (customer !== undefined) customer.note = "CURP registrada en el alta: SEPN000101MNESPR05.";
    });
    expect(await errorsOf(files, 18)).toEqual(["demo: the synthetic CURP has a valid check digit"]);
  });

  it("19 and 20: a timer inside the tour window and a live world in the judge template", async () => {
    const files = mutated(worldFile("judge"), (json) => {
      const timer = judgeTables(json).WorkOrders?.find((item) => item.entity === "Timer");
      if (timer !== undefined) {
        timer.kind = "CASE_TIMEOUT";
        timer.dueAtSim = "2026-10-13T18:00:00.000Z";
      }
      const settings = judgeTables(json).Isps?.find((item) => item.entity === "IspSettings");
      if (settings !== undefined) settings.whatsappMode = "live";
    });
    expect(await errorsOf(files, 19)).toEqual(expect.arrayContaining([expect.stringMatching(/inside the tour window/)]));
    expect(await errorsOf(files, 20)).toEqual(expect.arrayContaining([expect.stringMatching(/whatsappMode/)]));
  });
});
