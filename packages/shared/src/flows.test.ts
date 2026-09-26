import { describe, expect, it } from "vitest";
import {
  ALL_FLOW_IDS,
  FLOW_AREAS,
  FLOW_COUNT,
  FlowArea,
  FlowId,
  FlowLevel,
  ScenarioId,
  StepCitation,
  StepDeclaration,
  flowId,
  flowTag,
  flowTagsIn,
  parseStepCitation,
} from "./flows";
import { backticked, between, readDoc, tableRows } from "./testing";

const CATALOG = readDoc("docs/flows-catalog.md");
const TEST_PLAN = readDoc("docs/test-plan.md");
const MATRIX = tableRows(TEST_PLAN, "| Flujo | Título | U | LF | UI | SR | SMK | Notas");

/** A cell without its parenthesised annotations, whose backticks are not citations. */
function citations(cell: string): string[] {
  let text = cell;
  for (let previous = ""; previous !== text; ) {
    previous = text;
    text = text.replace(/\([^()]*\)/g, "");
  }
  return backticked(text);
}

describe("flow ids and tags", () => {
  it(`FL-001 … FL-${FLOW_COUNT} and their [FL-xxx] tags`, () => {
    expect(FlowId.safeParse("FL-017").success).toBe(true);
    for (const id of ["FL-000", "FL-123", "FL-7", "F017", "fl-017"]) expect(FlowId.safeParse(id).success, id).toBe(false);
    expect(flowId(17)).toBe("FL-017");
    expect(ALL_FLOW_IDS).toHaveLength(FLOW_COUNT);
    expect(flowTag("FL-017")).toBe("[FL-017]");
    expect(() => flowTag("FL-17")).toThrow();
    expect(flowTagsIn("transcribes the voice note [FL-017] [FL-085] and again [FL-017]")).toEqual(["FL-017", "FL-085"]);
    expect(flowTagsIn("no tag here")).toEqual([]);
  });

  it("step citations: steps, parts, ranges, express steps and smoke steps", () => {
    expect(parseStepCitation("SC-18/4.b")).toEqual({ scenario: "SC-18", steps: ["4"], part: "b" });
    expect(parseStepCitation("SC-04/3..8")).toEqual({ scenario: "SC-04", steps: ["3", "4", "5", "6", "7", "8"] });
    expect(parseStepCitation("SC-18/X2")).toEqual({ scenario: "SC-18", steps: ["X2"] });
    expect(parseStepCitation("SMK/5")).toEqual({ scenario: "SC-00", steps: ["5"] });
    expect(parseStepCitation("EV-01/2")).toEqual({ scenario: "EV-01", steps: ["2"] });
    expect(() => parseStepCitation("SC-04/8..3")).toThrow(RangeError);
    for (const ref of ["SC-4/1", "SC-18/4.B", "SC-18/4.b..5", "SC-18", "SMK-5"]) expect(StepCitation.safeParse(ref).success, ref).toBe(false);
  });
});

describe("step declarations (docs/test-plan.md §4.3, ADR-0021)", () => {
  it("one kind, one after, flows of the catalog", () => {
    expect(StepDeclaration.safeParse({ id: "4.b", flows: ["FL-017", "FL-082"], kind: "agent", after: "4.a", oracleFlow: "FL-017" }).success).toBe(true);
    expect(StepDeclaration.safeParse({ id: "12", flows: ["FL-043"], kind: "det", after: "preset", expect: "DUPLICATE_EVIDENCE" }).success).toBe(true);
    expect(StepDeclaration.safeParse({ id: "X3", flows: ["FL-047"], kind: "det", after: "scene" }).success).toBe(true);
    expect(StepDeclaration.safeParse({ id: "1", flows: [], kind: "det", after: "preset" }).success).toBe(false);
    expect(StepDeclaration.safeParse({ id: "1", flows: ["FL-123"], kind: "det", after: "preset" }).success).toBe(false);
    expect(StepDeclaration.safeParse({ id: "1", flows: ["FL-001", "FL-001"], kind: "det", after: "preset" }).success).toBe(false);
    expect(StepDeclaration.safeParse({ id: "1", flows: ["FL-001"], kind: "det", after: "later" }).success).toBe(false);
    expect(StepDeclaration.safeParse({ id: "2", flows: ["FL-001"], kind: "det", after: "2" }).success).toBe(false);
  });

  it("oracleFlow only in an agent step, and one of its flows", () => {
    expect(StepDeclaration.safeParse({ id: "3", flows: ["FL-017", "FL-020"], kind: "det", after: "preset", oracleFlow: "FL-017" }).success).toBe(false);
    expect(StepDeclaration.safeParse({ id: "3", flows: ["FL-017"], kind: "agent", after: "preset", oracleFlow: "FL-020" }).success).toBe(false);
    expect(StepDeclaration.safeParse({ id: "3", flows: ["FL-017"], kind: "agent", after: "preset", extra: true }).success).toBe(false);
  });
});

describe("docs/flows-catalog.md", () => {
  it("has the areas of FLOW_AREAS, in order", () => {
    const letters = [...(/^Áreas: (.+)$/m.exec(CATALOG)?.[1] ?? "").matchAll(/(?:^|· )([A-Z]) /g)].map((match) => match[1]);
    expect(letters).toEqual(FlowArea.options);
    const sections = [...CATALOG.matchAll(/^## Área ([A-Z]) · /gm)].map((match) => match[1]);
    expect(sections).toEqual(Object.keys(FLOW_AREAS));
  });

  it(`numbers ${FLOW_COUNT} flows FL-001 … FL-${FLOW_COUNT}, each under an area`, () => {
    expect(CATALOG.split("\n")[0]).toBe(`# Catálogo de flujos (FL-001 a FL-${FLOW_COUNT})`);
    const ids = [...CATALOG.matchAll(/^### (FL-\d{3}) · /gm)].map((match) => match[1] ?? "");
    expect(ids).toEqual([...ALL_FLOW_IDS]);
    expect(CATALOG.indexOf("## Área A")).toBeLessThan(CATALOG.indexOf("### FL-001"));
  });
});

describe("docs/test-plan.md", () => {
  it("the matrix has one column per test level and one row per flow", () => {
    const header = TEST_PLAN.split("\n").find((line) => line.startsWith("| Flujo | Título"));
    expect(header?.split(" | ").slice(2, 7)).toEqual(FlowLevel.options);
    expect(MATRIX.map((cells) => cells[0])).toEqual([...ALL_FLOW_IDS]);
  });

  it("every SR and SMK cell cites valid step references", () => {
    const refs = MATRIX.flatMap((cells) => [...citations(cells[5] ?? ""), ...citations(cells[6] ?? "")]);
    expect(refs.length).toBeGreaterThan(FLOW_COUNT);
    expect(refs.filter((ref) => !StepCitation.safeParse(ref).success)).toEqual([]);
    for (const ref of refs) expect(() => parseStepCitation(ref), ref).not.toThrow();
  });

  it("every scenario of §4.5 has a valid id", () => {
    const scenarios = [...between(TEST_PLAN, "### 4.5", "\n## 5").matchAll(/^\| `((?:SC|EV)-\d{2})`/gm)].map((match) => match[1] ?? "");
    expect(scenarios).toContain("SC-00");
    expect(scenarios).toContain("EV-02");
    expect(scenarios.filter((id) => !ScenarioId.safeParse(id).success)).toEqual([]);
  });
});
