import { describe, expect, it } from "vitest";
import { ConnectorError } from "@cuadrilla/shared";
import { resolveBrand } from "../copy/brand";
import { signupGenerationExpiresAt } from "../connector/world";
import { buildWorld, displayNameFor, worldExists } from "./factory";
import { GENERATION_ATTEMPTS, GenerationCollisionError, generationExists, openGeneration } from "./guest-lifecycle";
import { COBRAND, NEUTRAL, SIGNUP_CLOCK, SIGNUP_ISP, SIGNUP_USER, TEMPLATE_TEXT, allRows, worldHarness } from "./testing";

const TEMPLATE = JSON.parse(TEMPLATE_TEXT) as { tables: Record<string, unknown[]> };
const TEMPLATE_COUNTS = Object.fromEntries(Object.entries(TEMPLATE.tables).filter(([, rows]) => rows.length > 0).map(([table, rows]) => [table, rows.length]));
const TAG = "gs261001abcde";

describe("[FL-107] minimal world factory", () => {
  it("[FL-107] builds a sign-up world equal to the template: gs… ids, phones of the 0300 block, tagged simulator emails, expiresAt on every item", async () => {
    const world = worldHarness();
    const result = await buildWorld(world.factoryDeps(), { ispId: SIGNUP_ISP, origin: "SIGNUP", ownerUserId: SIGNUP_USER });
    expect(result).toMatchObject({ clockId: SIGNUP_CLOCK, worldEpoch: 1 });
    expect(result.counts).toEqual(TEMPLATE_COUNTS);

    const expiry = signupGenerationExpiresAt(SIGNUP_ISP);
    const rows = allRows(world);
    const persons = rows.filter(({ row }) => row.entity === "Person");
    for (const { table, row } of rows) {
      // Everything the factory wrote, the address claims and the epoch counter aside, carries the world's scope.
      if (row.entity === "Counter") continue;
      expect(row.expiresAt, `${table} ${String(row.PK)}`).toBe(expiry);
      expect(row.world, `${table} ${String(row.PK)}`).toBe("guest");
      expect(String(row.PK).includes(SIGNUP_ISP) || String(row.PK).includes(`-${TAG}`) || String(row.PK).startsWith("ADDR#") || String(row.PK) === `CLOCK#${SIGNUP_CLOCK}`, String(row.PK)).toBe(true);
    }
    for (const { row } of persons) {
      if (typeof row.phone === "string") expect(row.phone).toMatch(/^\+52550300\d{4}$/);
      expect(String(row.personId)).toMatch(new RegExp(`-${TAG}$`));
    }
    expect(persons.filter(({ row }) => typeof row.phoneHash === "string").length).toBe(persons.filter(({ row }) => typeof row.phone === "string").length);
    const customers = rows.filter(({ row }) => row.entity === "Customer");
    for (const { row } of customers) expect(String(row.email)).toMatch(new RegExp(`^[a-z]+\\+${TAG}-c\\d{5}@simulator\\.amazonses\\.com$`));
    expect(rows.every(({ row }) => !JSON.stringify(row).includes("{{"))).toBe(true);
  });

  it("[FL-107] writes the operator's name with resolveBrand, the caps of the SIGNUP profile, the owner, a paused clock and DAY_START timers as data", async () => {
    const world = worldHarness();
    await buildWorld(world.factoryDeps(COBRAND), { ispId: SIGNUP_ISP, origin: "SIGNUP", ownerUserId: SIGNUP_USER });
    const isp = await world.connector.isps.getIsp(SIGNUP_ISP);
    // A sign-up world stays neutral while `signupMode` is not `cobrand` (ADR-0025 §2).
    expect(isp?.displayName).toBe(resolveBrand(NEUTRAL).operatorName);
    const settings = await world.connector.isps.getSettings(SIGNUP_ISP);
    expect(settings).toMatchObject({ capsProfile: "SIGNUP", ownerUserId: SIGNUP_USER, simulatorCaps: { turnsPerDay: 60, turnsPerHour: 20, validationsPerDay: 20, transcribeSecPerDay: 300, emailsPerDay: 10, messagesPerRealHourPerIdentity: 15, sceneJumpsPerRealHour: 15 }, turnCaps: { perHour: 20, perDay: 60 }, whatsappMode: "simulated" });
    const clock = await world.connector.runtime.getClock(SIGNUP_CLOCK);
    expect(clock).toMatchObject({ mode: "PAUSED", pausedSimNow: "2026-10-13T07:00:00-06:00", worldEpoch: 1, kind: "GUEST", settings: { ownerUserId: SIGNUP_USER } });
    const due = await world.connector.timers.listDueTimers(SIGNUP_CLOCK);
    expect(due.length).toBeGreaterThan(0);
    expect(due.every((timer) => timer.kind === "DAY_START" && timer.status === "SCHEDULED")).toBe(true);
    const certificates = world.client.dump("WorkOrders").filter((row) => row.entity === "Certificate");
    expect(certificates.length).toBeGreaterThan(0);
    expect(certificates.every((row) => row.pdfPending === true)).toBe(true);
    const evidence = world.client.dump("WorkOrders").filter((row) => row.entity === "Evidence");
    expect(evidence.every((row) => String(row.s3Key).startsWith("guest/") && row.worldEpoch === 1)).toBe(true);
  });

  it("co-brands an invited guest's world, and a sign-up world only with signupMode cobrand", () => {
    expect(displayNameFor(COBRAND, "INVITED")).toBe("Operadora Socia");
    expect(displayNameFor(COBRAND, "SIGNUP")).toBe(resolveBrand(NEUTRAL).operatorName);
    expect(displayNameFor({ ...COBRAND, signupMode: "cobrand" }, "SIGNUP")).toBe("Operadora Socia");
  });

  it("[FL-107] an invited guest's world has no TTL and the phones of its own block", async () => {
    const world = worldHarness();
    await buildWorld(world.factoryDeps(), { ispId: "isp-guest-07", origin: "INVITED" });
    const people = world.client.dump("People").filter((row) => row.entity === "Person");
    expect(people.every((row) => row.expiresAt === undefined && row.world === "guest")).toBe(true);
    expect(people.filter((row) => typeof row.phone === "string").every((row) => String(row.phone).startsWith("+52550207"))).toBe(true);
    expect((await world.connector.isps.getSettings("isp-guest-07"))?.simulatorCaps.turnsPerDay).toBe(300);
    await expect(buildWorld(world.factoryDeps(), { ispId: "isp-guest-07", origin: "SIGNUP" })).rejects.toThrow(RangeError);
  });

  it("[FL-107] a second build of the same world is idempotent: same rows, same epoch", async () => {
    const world = worldHarness();
    await buildWorld(world.factoryDeps(), { ispId: SIGNUP_ISP, origin: "SIGNUP", ownerUserId: SIGNUP_USER });
    const first = allRows(world).map(({ table, row }) => `${table}|${String(row.PK)}|${String(row.SK)}`).sort();
    const again = await buildWorld(world.factoryDeps(), { ispId: SIGNUP_ISP, origin: "SIGNUP", ownerUserId: SIGNUP_USER });
    expect(again.worldEpoch).toBe(1);
    expect(allRows(world).map(({ table, row }) => `${table}|${String(row.PK)}|${String(row.SK)}`).sort()).toEqual(first);
    expect(await worldExists(world.factoryDeps(), SIGNUP_ISP)).toBe(true);
  });

  it("[FL-107] a clock that belongs to another guest is a collision, and nothing of that world changes", async () => {
    const world = worldHarness();
    await buildWorld(world.factoryDeps(), { ispId: SIGNUP_ISP, origin: "SIGNUP", ownerUserId: SIGNUP_USER });
    const before = JSON.stringify(allRows(world));
    await expect(buildWorld(world.factoryDeps(), { ispId: SIGNUP_ISP, origin: "SIGNUP", ownerUserId: "usr-g01K60000000000000000000002" })).rejects.toBeInstanceOf(GenerationCollisionError);
    expect(JSON.stringify(allRows(world))).toBe(before);
  });
});

describe("[FL-107] generation ids (collision)", () => {
  const noOps = () => [];

  it("[FL-107] with the suffix forced to repeat, the second generation's first transaction fails on META or CLOCK#, retries with another suffix and the first world is untouched", async () => {
    const world = worldHarness();
    const clock = { pausedSimNow: "2026-10-13T07:00:00-06:00", template: "guest" };
    const first = await openGeneration({ client: world.client, now: world.now(), suffix: () => "abcde", clock, ops: noOps, idTaken: (generation) => generationExists(world.client, generation) });
    expect(first.ispId).toBe(SIGNUP_ISP);
    const before = JSON.stringify(allRows(world));
    const suffixes = ["abcde", "abcdf"];
    const second = await openGeneration({ client: world.client, now: world.now(), suffix: () => suffixes.shift() ?? "zzzzz", clock, ops: noOps, idTaken: (generation) => generationExists(world.client, generation) });
    expect(second.ispId).toBe("isp-guest-s261001abcdf");
    const firstRows = allRows(world).filter(({ row }) => JSON.stringify(row).includes(SIGNUP_ISP));
    expect(JSON.stringify(firstRows)).toBe(JSON.stringify(JSON.parse(before).filter(({ row }: { row: unknown }) => JSON.stringify(row).includes(SIGNUP_ISP))));
    expect(await world.connector.runtime.currentEpoch(second.clockId)).toBe(1);
  });

  it("[FL-107] a clock left without its operator also counts as taken", async () => {
    const world = worldHarness();
    await world.connector.runtime.createClock({ clockId: SIGNUP_CLOCK, ispId: SIGNUP_ISP, kind: "GUEST", mode: "PAUSED", offsetMs: 0, pausedSimNow: "2026-10-13T07:00:00-06:00", worldEpoch: 1 });
    const suffixes = ["abcde", "bbbbb"];
    const next = await openGeneration({ client: world.client, now: world.now(), suffix: () => suffixes.shift() ?? "ccccc", clock: { pausedSimNow: "2026-10-13T07:00:00-06:00", template: "guest" }, ops: noOps, idTaken: (generation) => generationExists(world.client, generation) });
    expect(next.ispId).toBe("isp-guest-s261001bbbbb");
  });

  it("[FL-107] five collisions in a row → the generation fails; a conflict of the caller's own rows is not retried", async () => {
    const world = worldHarness();
    await openGeneration({ client: world.client, now: world.now(), suffix: () => "abcde", ops: noOps, idTaken: (generation) => generationExists(world.client, generation) });
    let tries = 0;
    const always = () => {
      tries += 1;
      return "abcde";
    };
    await expect(openGeneration({ client: world.client, now: world.now(), suffix: always, ops: noOps, idTaken: (generation) => generationExists(world.client, generation) })).rejects.toBeInstanceOf(GenerationCollisionError);
    expect(tries).toBe(GENERATION_ATTEMPTS);

    const own = { op: "put" as const, table: "Runtime" as const, item: { PK: "SIGNUPSUB#sub-1", SK: "META" }, condition: { ifNotExists: true } };
    await world.client.put("Runtime", own.item);
    await expect(openGeneration({ client: world.client, now: world.now(), suffix: () => "qqqqq", ops: () => [own], idTaken: (generation) => generationExists(world.client, generation) })).rejects.toBeInstanceOf(ConnectorError);
    expect(await generationExists(world.client, { ispId: "isp-guest-s261001qqqqq", clockId: "GUEST#isp-guest-s261001qqqqq" })).toBe(false);
  });
});
