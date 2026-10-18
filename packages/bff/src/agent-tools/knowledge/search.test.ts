import { beforeEach, describe, expect, it } from "vitest";
import { CLOCK, ISP } from "../../connector/testing";
import { createKnowledgeCatalog, manualLabel, newestVersion } from "../../knowledge/catalog";
import type { KnowledgeClient, RetrieveOutcome, RetrieveRequest, RetrievedChunk } from "../../knowledge/client";
import { createToolHandler } from "../common/handler";
import { TURN_ID, type ToolTestKit, gatewayContext, seedDay, toolTestKit } from "../common/testing";
import { type KnowledgeRuntime, citationFormat, searchProcedures } from "./handler";
import { PASSAGE_MAX_CHARS } from "./schema";

const SECTIONS = [
  { sectionId: "COM-02", title: "Pagos y cobros en sitio", category: "COM" },
  { sectionId: "COM-04", title: "Reubicación de la roseta", category: "COM" },
  { sectionId: "DIAG-02", title: "ONU sin luz PON", category: "DIAG" },
  { sectionId: "MED-01", title: "Rangos de potencia por clase", category: "MED" },
] as const;

let kit: ToolTestKit;
let answer: RetrieveOutcome;
/** Answers of the next calls, in order, before `answer`. */
let queued: RetrieveOutcome[];
let asked: RetrieveRequest[];

const fakeKnowledge: KnowledgeClient = {
  retrieve: async (request) => {
    asked.push(request);
    return queued.shift() ?? answer;
  },
};

const chunk = (sectionId: string, score: number, text = `Texto de ${sectionId}.`, manualVersion = "v001"): RetrievedChunk => ({ sectionId, score, text, manualVersion, title: `chunk ${sectionId}` });
const found = (...chunks: RetrievedChunk[]): RetrieveOutcome => ({ kind: "OK", chunks, attempts: 1 });

function target() {
  const runtime = (): KnowledgeRuntime => ({ ...kit.runtime, knowledge: fakeKnowledge, catalog: createKnowledgeCatalog(kit.memory.connector.reference, kit.runtime.realClock, 0) });
  return createToolHandler({ target: "knowledge", deps: runtime, tools: [searchProcedures] });
}

async function search(args: Record<string, unknown>) {
  const token = await kit.openSession();
  return target().handler({ sessionToken: token, ...args }, gatewayContext("knowledge___search_procedures"));
}

async function loadManual(version = "v001", threshold?: { version: string; value: number }) {
  const { reference } = kit.memory.connector;
  for (const section of SECTIONS) await reference.put("ManualIndex", { manualVersion: version, ...section });
  if (threshold !== undefined) await reference.put("KbThreshold", { thresholdVersion: threshold.version, value: threshold.value, provisional: true });
}

beforeEach(async () => {
  kit = toolTestKit();
  asked = [];
  queued = [];
  answer = found();
  await seedDay(kit);
  await loadManual("v001", { version: "v001", value: 0.35 });
});

describe("[FL-028] a policy question answered from the manual, with its section", () => {
  it("[FL-028] returns the passages over the threshold, best first, with the index's titles and the citation format", async () => {
    answer = found(chunk("COM-04", 0.71, "Hasta 15 m de cable dentro del domicilio no tiene costo."), chunk("COM-02", 0.52), chunk("DIAG-02", 0.2));
    const response = await search({ query: "¿se le cobra si la roseta va en otro cuarto?" });
    expect(response).toEqual({
      ok: true,
      coverage: "FOUND",
      manualVersion: "v001",
      citationFormat: "(Manual v1, §{sectionId})",
      passages: [
        { sectionId: "COM-04", title: "Reubicación de la roseta", text: "Hasta 15 m de cable dentro del domicilio no tiene costo.", score: 0.71 },
        { sectionId: "COM-02", title: "Pagos y cobros en sitio", text: "Texto de COM-02.", score: 0.52 },
      ],
    });
    expect(asked).toEqual([expect.objectContaining({ clockId: CLOCK, manualVersion: "v001", query: "¿se le cobra si la roseta va en otro cuarto?" })]);
  });

  it("[FL-028] keeps the passages for the turn: the sections CP-CITATION accepts and G2's grounding source", async () => {
    answer = found(chunk("COM-04", 0.71));
    await search({ query: "roseta en otro cuarto" });
    const stored = await kit.memory.connector.runtime.listTurnResults(TURN_ID, "search_procedures");
    expect(stored[0]?.output).toMatchObject({ coverage: "FOUND", passages: [{ sectionId: "COM-04" }] });
  });

  it("[FL-028] one passage per section, clipped, never a section outside the index or of another version", async () => {
    answer = found(chunk("COM-04", 0.6, "a"), chunk("COM-04", 0.8, "x".repeat(PASSAGE_MAX_CHARS + 50)), chunk("CAL-01", 0.9), chunk("MED-01", 0.9, "versión vieja", "v000"));
    const response = await search({ query: "roseta" });
    const passages = response.ok ? (response.passages as Array<{ sectionId: string; text: string; score: number }>) : [];
    expect(passages.map((passage) => [passage.sectionId, passage.score])).toEqual([["COM-04", 0.8]]);
    expect(passages[0]?.text.length).toBe(PASSAGE_MAX_CHARS);
  });

  it("[FL-028] narrows the search to the category the model asked for", async () => {
    answer = found(chunk("MED-01", 0.66));
    expect(await search({ query: "potencia mínima para cerrar", category: "MED" })).toMatchObject({ ok: true, coverage: "FOUND", passages: [{ sectionId: "MED-01" }] });
    expect(asked[0]?.category).toBe("MED");
  });

  it("[FL-028] a wrong category never hides a covered topic: nothing worth citing in it → once more over the whole manual", async () => {
    queued = [found(chunk("DIAG-02", 0.2))];
    answer = found(chunk("COM-04", 0.66));
    expect(await search({ query: "¿qué equipos le dejo al cliente?", category: "DIAG" })).toMatchObject({ ok: true, coverage: "FOUND", passages: [{ sectionId: "COM-04" }] });
    expect(asked.map((request) => request.category)).toEqual(["DIAG", undefined]);
  });

  it("[FL-030] a topic the whole manual does not cover stays NONE after the second search, and a search without category runs once", async () => {
    expect(await search({ query: "¿le dejo la contraseña de administrador?", category: "INS" })).toMatchObject({ ok: true, coverage: "NONE", passages: [] });
    expect(asked.map((request) => request.category)).toEqual(["INS", undefined]);
    asked = [];
    expect(await search({ query: "¿le dejo la contraseña de administrador?" })).toMatchObject({ ok: true, coverage: "NONE" });
    expect(asked).toHaveLength(1);
  });

  it("[FL-034] a category search that cannot be read is UNAVAILABLE at once, never asked again without the category", async () => {
    answer = { kind: "UNAVAILABLE", reason: "SERVICE_ERROR", attempts: 3 };
    expect(await search({ query: "roseta", category: "COM" })).toMatchObject({ ok: true, coverage: "UNAVAILABLE" });
    expect(asked).toHaveLength(1);
  });

  it("[FL-028] uses the manual and the threshold in force: the newest versions in Reference", async () => {
    await loadManual("v002", { version: "v002", value: 0.5 });
    answer = found(chunk("COM-04", 0.62, "nuevo", "v002"), chunk("COM-02", 0.45, "bajo", "v002"));
    expect(await search({ query: "roseta" })).toMatchObject({ ok: true, manualVersion: "v002", citationFormat: "(Manual v2, §{sectionId})", passages: [{ sectionId: "COM-04" }] });
    expect(asked[0]?.manualVersion).toBe("v002");
  });
});

describe("[FL-030] a question the manual does not cover", () => {
  it("[FL-030] coverage NONE when nothing reaches the threshold: no passage to cite, nothing invented", async () => {
    answer = found(chunk("GEN-01", 0.31), chunk("COM-02", 0.22));
    expect(await search({ query: "¿le dejo la contraseña de administrador de la ONU?" })).toEqual({ ok: true, coverage: "NONE", manualVersion: "v001", citationFormat: "(Manual v1, §{sectionId})", passages: [] });
  });

  it("[FL-030] coverage NONE when the Knowledge Base returns nothing", async () => {
    expect(await search({ query: "algo que no está" })).toMatchObject({ ok: true, coverage: "NONE", passages: [] });
  });

  it("[FL-030] coverage UNAVAILABLE, not an error, when the manual cannot be read", async () => {
    answer = { kind: "UNAVAILABLE", reason: "SERVICE_ERROR", attempts: 3 };
    expect(await search({ query: "roseta" })).toEqual({ ok: true, coverage: "UNAVAILABLE", manualVersion: "v001", citationFormat: "(Manual v1, §{sectionId})", passages: [] });
  });

  it("[FL-030] coverage UNAVAILABLE when no manual has been loaded, without calling the Knowledge Base", async () => {
    kit = toolTestKit();
    await seedDay(kit);
    expect(await search({ query: "roseta" })).toEqual({ ok: true, coverage: "UNAVAILABLE", citationFormat: "(Manual, §{sectionId})", passages: [] });
    expect(asked).toEqual([]);
  });
});

describe("search_procedures fences and catalog", () => {
  it("refuses a query over 300 characters and serves the console's manual viewer", async () => {
    expect(await search({ query: "x".repeat(301) })).toMatchObject({ ok: false, error: { code: "INVALID" } });
    answer = found(chunk("DIAG-02", 0.7));
    const viewer = await target().invoke("search_procedures", { caller: { kind: "CONSOLE", ispId: ISP, clockId: CLOCK, userId: "usr-adriana", role: "SUPERVISOR" }, query: "luz PON" });
    expect(viewer).toMatchObject({ ok: true, coverage: "FOUND" });
    expect(await target().invoke("search_procedures", { caller: { kind: "WORKER", ispId: ISP, clockId: CLOCK }, query: "luz PON" })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });

  it("answers the QaDriver's kb.probe in a QA world and refuses QA anywhere else", async () => {
    answer = found(chunk("DIAG-02", 0.7));
    const qa = (clockId: string, ispId: string) => target().invoke("search_procedures", { caller: { kind: "QA", ispId, clockId, eventId: "qa-ev-kb-probe" }, query: "luz PON" });
    expect(await qa("qa-812-1-sc-00", "isp-qa-812-1-sc-00")).toMatchObject({ ok: true, coverage: "FOUND", passages: [{ sectionId: "DIAG-02" }] });
    expect(await qa(CLOCK, ISP)).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });

  it("reads versions up to the first gap and names the manual as citations do", async () => {
    const present = new Set(["v001", "v002", "v004"]);
    expect(await newestVersion(async (version) => present.has(version))).toBe("v002");
    expect(await newestVersion(async () => false)).toBeUndefined();
    expect(manualLabel("v012")).toBe("v12");
    expect(citationFormat("v001")).toBe("(Manual v1, §{sectionId})");
  });

  it("falls back to the provisional threshold 0,35 when no threshold row exists, and caches within its TTL", async () => {
    kit = toolTestKit();
    await loadManual("v001");
    let now = Date.parse("2026-10-13T15:20:00Z");
    const catalog = createKnowledgeCatalog(kit.memory.connector.reference, { now: async () => new Date(now) }, 60_000);
    expect(await catalog.current()).toMatchObject({ manualVersion: "v001", threshold: 0.35, provisional: true });
    await kit.memory.connector.reference.put("KbThreshold", { thresholdVersion: "v001", value: 0.4, provisional: false });
    expect((await catalog.current()).threshold).toBe(0.35);
    now += 60_001;
    expect(await catalog.current()).toMatchObject({ threshold: 0.4, provisional: false, thresholdVersion: "v001" });
  });
});
