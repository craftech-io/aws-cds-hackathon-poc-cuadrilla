import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CATALOG_FILE,
  TEST_PLAN_FILE,
  checkCitations,
  committedMatrix,
  matrixDiff,
  parseCatalog,
  parseProofLine,
  renderMatrix,
  resolveTestPath,
  stepFile,
  type FileAccess,
} from "./check";
import { checkOracleKeys, parseOracleKey } from "./oracle-keys";
import { checkStepCitations, kindOf, parseScenarioPlan, pendingP01Flows, resolveCitation } from "./plan";

const CATALOG = `
## Área A

### FL-001 · Alta de instalador
- Pasos: …
- Prueba: U \`routers/people.test.ts\`, \`connector/dynamo/people.test.ts\` · UI \`people.spec.ts\` · SR \`SC-10/1\`, \`EV-01/2\`.

### FL-002 · Instalador sin opt-in
- Prueba: LF \`onboarding.flow.test.ts\` · SMK \`SMK/3\`. Notas: Clon de \`wo-4472\`.
`;

function files(contents: Record<string, string>): FileAccess {
  const list = (dir: string): string[] =>
    Object.keys(contents)
      .filter((path) => path.startsWith(`${dir}/`))
      .map((path) => path.slice(dir.length + 1));
  return { exists: (path) => path in contents, read: (path) => contents[path] ?? "", list };
}

describe("catalog and matrix", () => {
  it("parses the proof line by level, with the notes apart", () => {
    const parsed = parseProofLine("- Prueba: U `a.test.ts`, `b.test.ts` · SR `SC-01/1..3`. Notas: Oráculo §4.3.");
    expect(parsed.tests).toEqual({ U: ["a.test.ts", "b.test.ts"], LF: [], UI: [], SR: ["SC-01/1..3"], SMK: [] });
    expect(parsed.cells).toEqual({ U: "`a.test.ts`, `b.test.ts`", SR: "`SC-01/1..3`" });
    expect(parsed.notes).toBe("Oráculo §4.3");
  });

  it("keeps annotations in the cell but never cites what they name", () => {
    const parsed = parseProofLine("- Prueba: SR `SC-06/2` (det: preset con el `open_case` real), `SC-17/1` (pendiente P-01).");
    expect(parsed.tests.SR).toEqual(["SC-06/2", "SC-17/1"]);
    expect(parsed.cells.SR).toBe("`SC-06/2` (det: preset con el `open_case` real), `SC-17/1` (pendiente P-01)");
  });

  it("renders one row per flow with dashes for empty levels", () => {
    const matrix = renderMatrix(parseCatalog(CATALOG));
    expect(matrix.split("\n").slice(2)).toEqual([
      "| FL-001 | Alta de instalador | `routers/people.test.ts`, `connector/dynamo/people.test.ts` | — | `people.spec.ts` | `SC-10/1`, `EV-01/2` | — | — |",
      "| FL-002 | Instalador sin opt-in | — | `onboarding.flow.test.ts` | — | — | `SMK/3` | Clon de `wo-4472` |",
    ]);
  });

  it("reports the rows that differ", () => {
    expect(matrixDiff("a\nb", "a\nc")).toEqual(["line 2: expected b / found c"]);
    expect(matrixDiff("a", "a")).toEqual([]);
  });

  it("keeps the committed matrix of docs/test-plan.md in step with docs/flows-catalog.md", () => {
    const flows = parseCatalog(readFileSync(resolve(process.cwd(), CATALOG_FILE), "utf8"));
    expect(flows).toHaveLength(103);
    expect(committedMatrix(readFileSync(resolve(process.cwd(), TEST_PLAN_FILE), "utf8"))).toBe(renderMatrix(flows));
  });
});

describe("citations", () => {
  it("resolves the short paths of the matrix", () => {
    expect(resolveTestPath("U", "routers/people.test.ts")).toBe("packages/bff/src/routers/people.test.ts");
    expect(resolveTestPath("U", "network-mock/network.test.ts")).toBe("packages/network-mock/src/network.test.ts");
    expect(resolveTestPath("U", "shared/media/keys.test.ts")).toBe("packages/shared/src/media/keys.test.ts");
    expect(resolveTestPath("U", "dispatch-mock/dispatch.test.ts")).toBe("packages/dispatch-mock/src/dispatch.test.ts");
    expect(resolveTestPath("U", "views/landing/landing.test.ts")).toBe("packages/web/src/views/landing/landing.test.ts");
    expect(resolveTestPath("U", "infra/policy-rules.test.ts")).toBe("infra/policy-rules.test.ts");
    expect(resolveTestPath("U", "scripts/channels/check-modes.test.ts")).toBe("scripts/channels/check-modes.test.ts");
    expect(resolveTestPath("UI", "people.spec.ts")).toBe("packages/web/e2e/people.spec.ts");
    expect(resolveTestPath("LF", "onboarding.flow.test.ts")).toBe("tests/flows/onboarding.flow.test.ts");
    expect(stepFile("SC-16/1")).toEqual({ dir: "scripts/scenarios", prefix: "sc-16-" });
    expect(stepFile("SC-04/15.a")).toEqual({ dir: "scripts/scenarios", prefix: "sc-04-" });
    expect(stepFile("SMK/3")).toEqual({ dir: "scripts/scenarios", prefix: "sc-00-" });
    expect(stepFile("EV-02/2")).toEqual({ dir: "scripts/evaluation", prefix: "ev-02-" });
    expect(stepFile("tool.invoke")).toBeUndefined();
  });

  it("fails a cited test without the flow's tag and only reports a missing one", () => {
    const flows = parseCatalog(CATALOG);
    const report = checkCitations(flows, files({ "packages/bff/src/routers/people.test.ts": 'describe("people", () => {})' }));
    expect(report.errors).toEqual(["FL-001: packages/bff/src/routers/people.test.ts has no test tagged [FL-001]"]);
    expect(report.pending).toContain("FL-001 U packages/bff/src/connector/dynamo/people.test.ts");
    expect(report.pending).toContain("FL-001 EV-01/2");
    expect(report.pending).toContain("FL-002 SMK/3");
  });

  it("accepts a tagged test and a scenario or evaluation step that lists the flow", () => {
    const flows = parseCatalog(CATALOG);
    const report = checkCitations(
      flows,
      files({
        "packages/bff/src/routers/people.test.ts": 'it("[FL-001] registers", () => {})',
        "scripts/scenarios/sc-10-onboarding.ts": "step({ id: '1', kind: 'det', flows: ['FL-001'] })",
        "scripts/evaluation/ev-01-manual.ts": "step({ id: '2', kind: 'agent', flows: ['FL-001'] })",
        "scripts/scenarios/sc-00-smoke.ts": 'step({ id: "3", kind: "det", flows: ["FL-005"] })',
      }),
    );
    expect(report.errors).toEqual(['FL-002: scripts/scenarios/sc-00-smoke.ts has no step with flows: [..."FL-002"...] (SMK/3)']);
  });
});

// ---- Steps, parts and oracle keys of docs/test-plan.md (plan.ts, oracle-keys.ts) ------------------

const PLAN = `
### 2.1 Excepciones al paso en \`poc\`

| Flujo | Por qué | Cómo |
|---|---|---|
| FL-091, FL-095 | WhatsApp vivo depende de la WABA (P-01) | fixtures |

### 2.2 Matriz

### 4.3 Asserts

**Oráculos de los pasos \`agent\`.** Patrones prohibidos comunes.

| Flujo | Hechos exigidos | Alternativas aceptadas | Sin oráculo duro |
|---|---|---|---|
${"@ROWS@"}

### 4.5 Escenarios

| Escenario | Presets | Pasos |
|---|---|---|
| \`SC-04\` fotos | preset | 1 [det] alta · 2 [agent] foto · 3-4 [agent] fotos · 9 (una acción) 9.a [det] x · 9.b [agent] y |
| \`SC-17\` vivo | preset | 1 [det] plantilla · 7 [det] evento ajeno |
| \`EV-01\` evaluación | mundo | 1 \`world.create\` · 2 \`eval.runQuestions\` |

## 5. Evaluación
`;

const withRows = (rows: string[]) => PLAN.replace("@ROWS@", rows.map((key) => `| ${key} | hechos | — | — |`).join("\n"));
const CATALOG_FOR_KEYS = "### FL-036 · Foto (a) nítida\n### FL-037 · Foto\n### FL-046 · Candidata (a) sin ítem\n### FL-091 · Vivo\n### FL-095 · Ajeno\n";

describe("scenario plan of §4.5", () => {
  const { plan, errors } = parseScenarioPlan(withRows([]));

  it("reads steps, ranges, parts and their kinds", () => {
    expect(errors).toEqual([]);
    expect(kindOf(plan, "SC-04/2")).toBe("agent");
    expect(kindOf(plan, "SC-04/4")).toBe("agent");
    expect(kindOf(plan, "SC-04/9.a")).toBe("det");
    expect(resolveCitation(plan, "SC-04/9").targets).toEqual(["SC-04/9.a", "SC-04/9.b"]);
    expect(resolveCitation(plan, "SC-04/1..3").targets).toEqual(["SC-04/1", "SC-04/2", "SC-04/3"]);
    expect(resolveCitation(plan, "EV-01/2").targets).toEqual(["EV-01/2"]);
  });

  it("fails citations to missing scenarios, steps or parts", () => {
    expect(resolveCitation(plan, "SC-04/9.c").error).toContain("no part c");
    expect(resolveCitation(plan, "SC-04/99").error).toContain("no step 99");
    expect(resolveCitation(plan, "SC-99/1").error).toContain("not a scenario");
    expect(resolveCitation(plan, "tool.invoke").error).toContain("not a step citation");
  });

  it("requires parts for a step with more than one typed segment", () => {
    const broken = PLAN.replace("@ROWS@", "").replace("1 [det] alta", "1 [det] alta · 1 [agent] luego");
    expect(parseScenarioPlan(broken).errors).toEqual(["SC-04/1: more than one [det]/[agent] segment; write it in parts 1.a, 1.b (§4.3)"]);
  });

  it("marks pending P-01 only on SC-17 citations of the flows §2.1 lists", () => {
    const flows = parseCatalog("### FL-091 · Vivo\n- Prueba: SR `SC-17/7` (pendiente P-01).\n\n### FL-036 · Foto\n- Prueba: SR `SC-04/2` (pendiente P-01).\n");
    expect(pendingP01Flows(withRows([]))).toEqual(new Set(["FL-091", "FL-095"]));
    expect(checkStepCitations(flows, plan, pendingP01Flows(withRows([])))).toEqual([
      "FL-036: SC-04/2 is marked pending P-01 but only SC-17 may be skipped (§2.1)",
      "FL-036: marked pending P-01 but §2.1 does not list it",
    ]);
  });
});

describe("oracle keys of §4.3", () => {
  const check = (rows: string[]) => {
    const markdown = withRows(rows);
    return checkOracleKeys(markdown, CATALOG_FOR_KEYS, parseScenarioPlan(markdown).plan);
  };

  it("accepts single flows, ranges, lists, scopes with and without 'y demás pasos' and variants", () => {
    expect(parseOracleKey("FL-036..FL-037 (`SC-04/2` y demás pasos)")).toEqual({ flows: ["FL-036", "FL-037"], shape: "range", scope: { citations: ["SC-04/2"], general: true } });
    expect(check(["FL-036", "FL-036..FL-037 (`SC-04/3..4`, `SC-04/9.b`)", "FL-046 (variante a) (`SC-04/2`)", "FL-091, FL-095"])).toEqual([]);
  });

  it("rejects keys outside the grammar and variants without a scope of their own", () => {
    expect(check(["FL-036 (solo en la demo)"])).toEqual(['oracle key "FL-036 (solo en la demo)": outside the grammar of docs/test-plan.md §4.3']);
    expect(check(["FL-046 (variante a)"])[0]).toContain("a variant needs a scope of its own");
    expect(check(["FL-037 (variante a) (`SC-04/2`)"])[0]).toContain("FL-037 has no variant (a)");
  });

  it("rejects a direct citation to a det step and a precedence tie", () => {
    expect(check(["FL-036 (`SC-04/9.a`)"])).toEqual(['oracle key "FL-036 (`SC-04/9.a`)": SC-04/9.a is not an agent step or part']);
    expect(check(["FL-036", "FL-036 (`SC-04/2` y demás pasos)"])[0]).toContain("precedence tie");
    expect(check(["FL-036 (`SC-04/2`)", "FL-036..FL-037 (`SC-04/2`)"])[0]).toContain("precedence tie");
  });
});
