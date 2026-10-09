// `seed:load` over memory (docs/seed-spec.md §15, invariant 16, docs/test-plan.md §3): idempotent by
// fingerprint, the media and the manual uploaded, the Knowledge Base ingested only when the manual
// changed, the demo world created and then reset (epoch 3 after two reloads, the old actors' Memory
// purged), the brand rewritten when `BrandConfig` changes, every pending certificate rendered, and the
// partner's logos checked and uploaded only with their flags.
import { describe, expect, it } from "vitest";
import { DEMO_CLOCK_ID, DEMO_ISP_ID } from "@cuadrilla/shared";
import { createLogger } from "../../../packages/bff/src/lib/log";
import type { BrandConfigValue } from "../../../packages/bff/src/lib/secret-schemas";
import type { WorldRef } from "../../../packages/bff/src/worlds/certificates";
import { factoryDepsOf } from "../../../packages/bff/src/worlds/deps";
import { buildWorld } from "../../../packages/bff/src/worlds/factory";
import { purgeRemainingPasses } from "../../../packages/bff/src/worlds/memory-purge";
import { COBRAND, type WorldsHarness, allRows, worldsHarness } from "../../../packages/bff/src/worlds/testing";
import { parseLoadArgs } from "../load/args";
import { type SeedOnDisk, readSeedFromDisk } from "../load/disk";
import { type JobStatus, pollingIngestion } from "../load/kb";
import { LOADED_KEY, LOGO_KEYS, type LoadPorts, runLoad } from "../load/run";
import { LogoRejected, validateLogoSvg } from "../load/svg";

const SEED = readSeedFromDisk();
const svg = (body: string): Uint8Array => new TextEncoder().encode(`<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${body}</svg>`);
const LOGO = svg('<defs><linearGradient id="g"><stop offset="0"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)"/><use href="#g"/>');

interface Stage {
  readonly harness: WorldsHarness;
  readonly ports: LoadPorts;
  readonly seed: Map<string, Uint8Array>;
  readonly manual: Map<string, Uint8Array>;
  readonly ingestions: string[];
  readonly files: Map<string, Uint8Array>;
}

function stage(options: { readonly brand?: BrandConfigValue; readonly ingestion?: JobStatus } = {}): Stage {
  const harness = worldsHarness(options.brand === undefined ? {} : { brand: options.brand });
  const seed = new Map<string, Uint8Array>();
  const manual = new Map<string, Uint8Array>();
  const ingestions: string[] = [];
  const files = new Map<string, Uint8Array>();
  const log = createLogger({ sink: () => undefined });
  const purge = { memory: harness.memory, data: harness.connector, log, now: harness.now, sleep: async () => undefined };
  const worlds = { ...harness.deps, continuePurge: async (target: Parameters<typeof purgeRemainingPasses>[1]) => void (await purgeRemainingPasses(purge, target)) };
  const listWorlds = async (): Promise<WorldRef[]> =>
    allRows(harness)
      .filter(({ table, row }) => table === "Isps" && row.SK === "META" && row.entity === "Isp")
      .map(({ row }) => ({ ispId: String(row.ispId), clockId: String(row.clockId) }));
  const ports: LoadPorts = {
    seed: { put: async (key, body) => void seed.set(key, body), getText: async (key) => (seed.has(key) ? new TextDecoder().decode(seed.get(key)) : undefined) },
    manual: { put: async (key, body) => void manual.set(key, body) },
    ingestion: pollingIngestion(
      {
        start: async () => {
          ingestions.push(`job-${ingestions.length + 1}`);
          return { jobId: `job-${ingestions.length}`, status: "STARTING" };
        },
        status: async () => ({ status: options.ingestion ?? "COMPLETE", ...(options.ingestion === "FAILED" ? { failureReasons: ["synthetic failure"] } : {}) }),
      },
      { sleep: async () => undefined, now: () => harness.now().getTime() },
    ),
    worlds,
    listWorlds,
    readFile: (path) => {
      const bytes = files.get(path);
      if (bytes === undefined) throw new Error(`no file ${path}`);
      return bytes;
    },
    report: () => undefined,
  };
  return { harness, ports, seed, manual, ingestions, files };
}

const brandKeys = (world: Stage): string[] => [...world.seed.keys()].filter((key) => key.startsWith("brand/"));

describe("seed:load", () => {
  it("uploads the media and the manual, ingests the Knowledge Base, creates the demo world and renders its certificates", async () => {
    const world = stage();
    const result = await runLoad(SEED, parseLoadArgs([]), world.ports);
    expect(result).toMatchObject({ skipped: false, ingested: true, demo: { worldEpoch: 1, action: "CREATED" } });
    expect([...world.seed.keys()].filter((key) => /^photos\/ph-[a-z]+-\d{2}\.jpg$/.test(key)).length).toBe(60 + 40 + 1);
    expect([...world.seed.keys()].filter((key) => key.startsWith("photos/ph-seed-")).length).toBe(48);
    expect([...world.seed.keys()].filter((key) => key.startsWith("audio/vn-")).length).toBe(12);
    expect(world.seed.has("photos/catalog.json") && world.seed.has("eval/questions.json") && world.seed.has("eval/photos.json") && world.seed.has("templates/acta-muestra.pdf")).toBe(true);
    expect([...world.seed.keys()].some((key) => key.startsWith("worlds/"))).toBe(false);
    expect(world.manual.size).toBe(64);
    expect(world.ingestions).toEqual(["job-1"]);
    expect((await world.harness.connector.reference.listManualIndex("v001")).length).toBe(32);
    expect((await world.harness.connector.runtime.getClock(DEMO_CLOCK_ID))?.worldEpoch).toBe(1);
    expect(allRows(world.harness).filter(({ row }) => row.entity === "Certificate" && row.pdfPending === true)).toEqual([]);
    expect((await world.harness.connector.audit.listByMonth(DEMO_ISP_ID, world.harness.now().toISOString().slice(0, 7))).map((row) => row.action)).toContain("SEED_LOADED");
    expect(JSON.parse(new TextDecoder().decode(world.seed.get(LOADED_KEY)))).toMatchObject({ fingerprint: result.fingerprint, manualFingerprint: SEED.manualFingerprint });
    expect(brandKeys(world)).toEqual([]);
  });

  it("does nothing again with the same fingerprint, and a forced reload resets without ingesting an unchanged manual", async () => {
    const world = stage();
    await runLoad(SEED, parseLoadArgs([]), world.ports);
    expect(await runLoad(SEED, parseLoadArgs(["--stage", "poc"]), world.ports)).toMatchObject({ skipped: true, ingested: false });
    expect((await world.harness.connector.runtime.getClock(DEMO_CLOCK_ID))?.worldEpoch).toBe(1);
    expect(await runLoad(SEED, parseLoadArgs(["--force"]), world.ports)).toMatchObject({ skipped: false, ingested: false, demo: { worldEpoch: 2, action: "RESET" } });
    expect(world.ingestions).toEqual(["job-1"]);
    const changed: SeedOnDisk = { ...SEED, manualFingerprint: "f".repeat(64) };
    expect(await runLoad(changed, parseLoadArgs(["--force"]), world.ports)).toMatchObject({ ingested: true });
    expect(world.ingestions).toEqual(["job-1", "job-2"]);
    expect(() => parseLoadArgs(["--stage", "prod"])).toThrow(/poc/);
  });

  it("fails the load when the ingestion fails, before the demo world is touched", async () => {
    const world = stage({ ingestion: "FAILED" });
    await expect(runLoad(SEED, parseLoadArgs([]), world.ports)).rejects.toThrow(/failed/);
    expect(await world.harness.connector.runtime.getClock(DEMO_CLOCK_ID)).toBeUndefined();
  });

  it("invariant 16: two reloads leave the epoch at 3 with new actors and 0 Memory records of the old ones", async () => {
    const world = stage();
    await runLoad(SEED, parseLoadArgs([]), world.ports);
    world.harness.memory.addRecord("inst-rogelio-e1", "tips-1");
    world.harness.memory.addEvent("inst-rogelio-e1", "session-1", "event-1");
    await runLoad(SEED, parseLoadArgs(["--force"]), world.ports);
    world.harness.memory.addRecord("inst-rogelio-e2", "tips-2");
    world.harness.memory.addRecord("inst-karina-e2", "tips-3", "preferences");
    await runLoad(SEED, parseLoadArgs(["--force"]), world.ports);
    expect((await world.harness.connector.runtime.getClock(DEMO_CLOCK_ID))?.worldEpoch).toBe(3);
    expect((await world.harness.connector.runtime.currentEpoch(DEMO_CLOCK_ID))).toBe(3);
    for (const actor of ["inst-rogelio-e1", "inst-rogelio-e2", "inst-karina-e2"]) {
      expect(world.harness.memory.recordsOf(actor)).toBe(0);
      expect(world.harness.memory.eventsOf(actor)).toBe(0);
    }
    expect((await world.harness.connector.workOrders.requireWorkOrder("wo-24817")).worldEpoch).toBe(3);
  });

  it("keeps the id and review status P-01 gave a WhatsApp template", async () => {
    const world = stage();
    await runLoad(SEED, parseLoadArgs([]), world.ports);
    const key = { PK: "REF#TEMPLATE#WHATSAPP", SK: "ordenes_del_dia" };
    const stored = await world.harness.client.get("Reference", key);
    await world.harness.client.put("Reference", { ...stored, PK: key.PK, SK: key.SK, status: "APPROVED", metaTemplateId: "1234567890" });
    await runLoad(SEED, parseLoadArgs(["--force"]), world.ports);
    expect(await world.harness.client.get("Reference", key)).toMatchObject({ status: "APPROVED", metaTemplateId: "1234567890" });
  });

  it("a change of BrandConfig renames every world and renders its certificates again; a guest world's pending ones too", async () => {
    const world = stage();
    await runLoad(SEED, parseLoadArgs([]), world.ports);
    await buildWorld(factoryDepsOf(world.harness.deps), { ispId: "isp-guest-07", origin: "INVITED" });
    expect(allRows(world.harness).filter(({ row }) => row.entity === "Certificate" && row.pdfPending === true).length).toBeGreaterThan(0);
    world.harness.setBrand(COBRAND);
    const result = await runLoad(SEED, parseLoadArgs([]), world.ports);
    expect(result).toMatchObject({ skipped: true, renamedWorlds: 2 });
    expect((await world.harness.connector.isps.getIsp(DEMO_ISP_ID))?.displayName).toBe(COBRAND.partnerDisplayName);
    expect((await world.harness.connector.isps.getIsp("isp-guest-07"))?.displayName).toBe(COBRAND.partnerDisplayName);
    expect(allRows(world.harness).filter(({ row }) => row.entity === "Certificate" && row.pdfPending === true)).toEqual([]);
    expect((await world.harness.connector.runtime.getClock(DEMO_CLOCK_ID))?.worldEpoch).toBe(1);
  });
});

describe("seed:load --brand-logo-on-light / --brand-logo-on-dark", () => {
  it.each([
    ["a <script>", svg("<script>alert(1)</script>")],
    ["a <foreignObject>", svg("<foreignObject><div/></foreignObject>")],
    ["an on* attribute", svg('<rect width="1" height="1" onload="x()"/>')],
    ["an external href", svg('<image href="https://example.com/a.png"/>')],
    ["an external url()", svg('<rect style="fill:url(https://example.com/a)"/>')],
    ["a DOCTYPE", new TextEncoder().encode('<!DOCTYPE svg [<!ENTITY a "b">]><svg xmlns="http://www.w3.org/2000/svg"/>')],
    ["broken XML", svg("<g><rect></g>")],
    ["two roots", new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/><svg xmlns="http://www.w3.org/2000/svg"/>')],
    ["over 50 KB", svg(`<desc>${"a".repeat(51 * 1024)}</desc>`)],
  ])("rejects a logo with %s and writes nothing", async (_case, bytes) => {
    expect(() => validateLogoSvg(bytes)).toThrow(LogoRejected);
    const world = stage({ brand: COBRAND });
    world.files.set("/tmp/partner/logo-light.svg", bytes);
    await expect(runLoad(SEED, parseLoadArgs(["--stage", "poc", "--brand-logo-on-light", "/tmp/partner/logo-light.svg"]), world.ports)).rejects.toThrow(LogoRejected);
    expect(brandKeys(world)).toEqual([]);
    expect(world.seed.size).toBe(0);
  });

  it("uploads valid logos to Seed/brand/ when BrandConfig names those keys; a neutral brand has no logos", async () => {
    expect(validateLogoSvg(LOGO)).toContain("<svg");
    const world = stage({ brand: COBRAND });
    world.files.set("/tmp/partner/light.svg", LOGO);
    world.files.set("/tmp/partner/dark.svg", LOGO);
    const result = await runLoad(SEED, parseLoadArgs(["--brand-logo-on-light", "/tmp/partner/light.svg", "--brand-logo-on-dark", "/tmp/partner/dark.svg"]), world.ports);
    expect(result.logos).toEqual([LOGO_KEYS.onLight, LOGO_KEYS.onDark]);
    expect(brandKeys(world).sort()).toEqual([LOGO_KEYS.onDark, LOGO_KEYS.onLight].sort());
    const neutral = stage();
    neutral.files.set("/tmp/partner/light.svg", LOGO);
    await expect(runLoad(SEED, parseLoadArgs(["--brand-logo-on-light", "/tmp/partner/light.svg"]), neutral.ports)).rejects.toThrow(/neutral/);
    expect(() => parseLoadArgs(["--brand-logo-on-light", "scripts/seed/data/logo.svg"])).toThrow(/outside the repository/);
  });

  it("a load without the flags never touches Seed/brand/", async () => {
    const world = stage({ brand: COBRAND });
    world.seed.set(LOGO_KEYS.onLight, LOGO);
    await runLoad(SEED, parseLoadArgs([]), world.ports);
    await runLoad(SEED, parseLoadArgs(["--force"]), world.ports);
    expect(brandKeys(world)).toEqual([LOGO_KEYS.onLight]);
    expect(world.seed.get(LOGO_KEYS.onLight)).toBe(LOGO);
  });
});
