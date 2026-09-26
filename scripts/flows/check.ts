// Keeps the flow catalog, the traceability matrix and the tests in step (docs/test-plan.md §2.2,
// docs/architecture.md §18):
//
//   1. The matrix between <!-- MATRIX:START --> and <!-- MATRIX:END --> of docs/test-plan.md is
//      generated from the "Prueba" line of every flow of docs/flows-catalog.md; any difference fails
//      (`--write` rewrites the block instead).
//   2. Every test file a flow cites that exists must carry the flow's `[FL-xxx]` tag, and every
//      scenario (`SC-nn/…`, `SMK/…` in scripts/scenarios/) or evaluation step (`EV-nn/…` in
//      scripts/evaluation/) a flow cites whose file exists must list the flow in a `flows: [...]`.
//   3. A cited file that does not exist yet is pending and only reported, because the plan builds
//      them wave by wave; `--strict` (the "100 % probada" gate, WP-50) fails on it.
//   4. From the documents alone (plan.ts, oracle-keys.ts): every step citation resolves to a step or
//      part of §4.5, a step with several [det]/[agent] segments is written in parts, "(pendiente
//      P-01)" marks only SC-17 citations of the flows of §2.1, and the oracle keys of §4.3 follow
//      their grammar and precedence.
//
//   npm run flows:check [-- --write] [-- --strict]
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkOracleKeys } from "./oracle-keys";
import { checkStepCitations, parseScenarioPlan, pendingP01Flows } from "./plan";

export const CATALOG_FILE = "docs/flows-catalog.md";
export const TEST_PLAN_FILE = "docs/test-plan.md";
export const MATRIX_START = "<!-- MATRIX:START -->";
export const MATRIX_END = "<!-- MATRIX:END -->";

export const LEVELS = ["U", "LF", "UI", "SR", "SMK"] as const;
export type Level = (typeof LEVELS)[number];

export interface Flow {
  readonly id: string;
  readonly title: string;
  /** Cited tests and steps by level: the backticked items outside parentheses. */
  readonly tests: Readonly<Record<Level, readonly string[]>>;
  /** Each level's text as the catalog writes it, annotations included: the matrix cell. */
  readonly cells: Readonly<Partial<Record<Level, string>>>;
  readonly notes: string | undefined;
}

const HEADER = ["| Flujo | Título | U | LF | UI | SR | SMK | Notas |", "|---|---|---|---|---|---|---|---|"];

function emptyTests(): Record<Level, string[]> {
  return { U: [], LF: [], UI: [], SR: [], SMK: [] };
}

/** Text without its parenthesised annotations ("`SC-17/1` (pendiente P-01)" → "`SC-17/1` "). */
function withoutAnnotations(text: string): string {
  let previous = "";
  let current = text;
  while (current !== previous) {
    previous = current;
    current = current.replace(/\([^()]*\)/g, "");
  }
  return current;
}

/**
 * `- Prueba: U \`a\`, \`b\` · SR \`SC-01/1\` (pendiente P-01). Notas: …` → tests by level, the text of
 * each level and the notes. Backticked names inside an annotation (`open_case`, a clockId) are not
 * citations.
 */
export function parseProofLine(line: string): Pick<Flow, "tests" | "cells" | "notes"> {
  const body = line.replace(/^- Prueba:\s*/, "").trim();
  const notesAt = body.indexOf(". Notas: ");
  const levels = (notesAt === -1 ? body : body.slice(0, notesAt)).replace(/\.$/, "");
  const notes = notesAt === -1 ? undefined : body.slice(notesAt + ". Notas: ".length).replace(/\.$/, "").trim();
  const tests = emptyTests();
  const cells: Partial<Record<Level, string>> = {};
  for (const part of levels.split(" · ")) {
    const match = /^(U|LF|UI|SR|SMK)\s+([\s\S]*)$/.exec(part.trim());
    const level = match?.[1] as Level | undefined;
    if (!level) continue;
    const text = (match?.[2] ?? "").trim();
    cells[level] = cells[level] === undefined ? text : `${cells[level]}, ${text}`;
    tests[level].push(...[...withoutAnnotations(text).matchAll(/`([^`]+)`/g)].map((found) => found[1] ?? ""));
  }
  return { tests, cells, notes: notes === "" ? undefined : notes };
}

export function parseCatalog(markdown: string): Flow[] {
  const flows: Flow[] = [];
  const blocks = markdown.split(/\n(?=### FL-\d{3} · )/);
  for (const block of blocks) {
    const heading = /^### (FL-\d{3}) · (.+)$/m.exec(block);
    if (!heading) continue;
    const proof = block.split("\n").find((line) => line.startsWith("- Prueba:"));
    const parsed = proof ? parseProofLine(proof) : { tests: emptyTests(), cells: {}, notes: undefined };
    flows.push({ id: heading[1] ?? "", title: (heading[2] ?? "").trim(), ...parsed });
  }
  return flows;
}

export function renderMatrix(flows: readonly Flow[]): string {
  const rows = flows.map((flow) => `| ${flow.id} | ${flow.title} | ${LEVELS.map((level) => flow.cells[level] ?? "—").join(" | ")} | ${flow.notes ?? "—"} |`);
  return [...HEADER, ...rows].join("\n");
}

export function committedMatrix(testPlan: string): string | undefined {
  const start = testPlan.indexOf(MATRIX_START);
  const end = testPlan.indexOf(MATRIX_END);
  if (start === -1 || end === -1 || end < start) return undefined;
  return testPlan.slice(start + MATRIX_START.length, end).trim();
}

/** Lines of the committed matrix that differ from the generated one, as `expected / found`. */
export function matrixDiff(generated: string, committed: string): string[] {
  const want = generated.split("\n");
  const have = committed.split("\n");
  const diff: string[] = [];
  for (let index = 0; index < Math.max(want.length, have.length); index += 1) {
    if (want[index] !== have[index]) diff.push(`line ${index + 1}: expected ${want[index] ?? "(nothing)"} / found ${have[index] ?? "(nothing)"}`);
  }
  return diff;
}

// ---- Citations ---------------------------------------------------------------------------------

/** Repository path of a test cited by its short form (docs/test-plan.md §2, "Etiquetas"). */
export function resolveTestPath(level: Level, cited: string): string {
  if (level === "LF") return cited.startsWith("tests/") ? cited : `tests/flows/${cited}`;
  if (cited.endsWith(".spec.ts")) return `packages/web/e2e/${cited}`;
  if (/^(infra|scripts|tests)\//.test(cited)) return cited;
  for (const pkg of ["network-mock", "dispatch-mock", "network-contract"]) if (cited.startsWith(`${pkg}/`)) return `packages/${pkg}/src/${cited.slice(pkg.length + 1)}`;
  if (cited.startsWith("views/")) return `packages/web/src/${cited}`;
  return `packages/bff/src/${cited}`;
}

export const SCENARIOS_DIR = "scripts/scenarios";
export const EVALUATION_DIR = "scripts/evaluation";

export interface StepFile {
  readonly dir: string;
  readonly prefix: string;
}

/** Directory and file prefix of a step (`SC-16/1` → sc-16-, `SMK/3` → sc-00-, `EV-01/2` → ev-01-). */
export function stepFile(step: string): StepFile | undefined {
  if (step.startsWith("SMK/")) return { dir: SCENARIOS_DIR, prefix: "sc-00-" };
  const scenario = /^SC-(\d{2})\//.exec(step)?.[1];
  if (scenario !== undefined) return { dir: SCENARIOS_DIR, prefix: `sc-${scenario}-` };
  const evaluation = /^EV-(\d{2})\//.exec(step)?.[1];
  return evaluation === undefined ? undefined : { dir: EVALUATION_DIR, prefix: `ev-${evaluation}-` };
}

export interface CitationReport {
  readonly errors: string[];
  readonly pending: string[];
}

export interface FileAccess {
  exists(path: string): boolean;
  read(path: string): string;
  /** Files of a directory (empty when it does not exist). */
  list(dir: string): string[];
}

export function checkCitations(flows: readonly Flow[], files: FileAccess): CitationReport {
  const errors: string[] = [];
  const pending: string[] = [];
  for (const flow of flows) {
    for (const level of ["U", "LF", "UI"] as const) {
      for (const cited of flow.tests[level]) {
        const path = resolveTestPath(level, cited);
        if (!files.exists(path)) pending.push(`${flow.id} ${level} ${path}`);
        else if (!files.read(path).includes(`[${flow.id}]`)) errors.push(`${flow.id}: ${path} has no test tagged [${flow.id}]`);
      }
    }
    for (const step of [...flow.tests.SR, ...flow.tests.SMK]) {
      const target = stepFile(step);
      const file = target === undefined ? undefined : files.list(target.dir).find((name) => name.startsWith(target.prefix));
      if (!target || !file) {
        pending.push(`${flow.id} ${step}`);
        continue;
      }
      const path = `${target.dir}/${file}`;
      if (!new RegExp(`flows:\\s*\\[[^\\]]*["']${flow.id}["']`).test(files.read(path))) errors.push(`${flow.id}: ${path} has no step with flows: [..."${flow.id}"...] (${step})`);
    }
  }
  return { errors, pending };
}

function diskAccess(cwd: string): FileAccess {
  return {
    exists: (path) => existsSync(join(cwd, path)),
    read: (path) => readFileSync(join(cwd, path), "utf8"),
    list: (dir) => (existsSync(join(cwd, dir)) ? readdirSync(join(cwd, dir)) : []),
  };
}

function main(): void {
  const cwd = process.cwd();
  const write = process.argv.includes("--write");
  const strict = process.argv.includes("--strict");
  const flows = parseCatalog(readFileSync(join(cwd, CATALOG_FILE), "utf8"));
  const planPath = join(cwd, TEST_PLAN_FILE);
  const plan = readFileSync(planPath, "utf8");
  const generated = renderMatrix(flows);
  const committed = committedMatrix(plan);
  const errors: string[] = [];

  if (committed === undefined) errors.push(`${TEST_PLAN_FILE}: the ${MATRIX_START} / ${MATRIX_END} markers are missing.`);
  else if (committed !== generated) {
    if (write) {
      writeFileSync(planPath, plan.replace(committed, generated));
      console.log(`flows:check: rewrote the matrix of ${TEST_PLAN_FILE}.`);
    } else {
      errors.push(`${TEST_PLAN_FILE}: the matrix differs from ${CATALOG_FILE} (run \`npm run flows:check -- --write\`):`);
      errors.push(...matrixDiff(generated, committed).slice(0, 20).map((line) => `  ${line}`));
    }
  }

  const catalog = readFileSync(join(cwd, CATALOG_FILE), "utf8");
  const scenarioPlan = parseScenarioPlan(plan);
  errors.push(...scenarioPlan.errors);
  errors.push(...checkStepCitations(flows, scenarioPlan.plan, pendingP01Flows(plan)));
  errors.push(...checkOracleKeys(plan, catalog, scenarioPlan.plan));

  const citations = checkCitations(flows, diskAccess(cwd));
  errors.push(...citations.errors);
  if (strict) errors.push(...citations.pending.map((item) => `pending (not in the repository yet): ${item}`));

  if (errors.length > 0) {
    console.error(`flows:check: ${errors.length} problem(s):`);
    for (const error of errors) console.error(`  ${error}`);
    process.exit(1);
  }
  const note = citations.pending.length > 0 ? `; ${citations.pending.length} cited test(s) or step(s) not written yet` : "";
  console.log(`flows:check: ${flows.length} flow(s), matrix in step${note}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
