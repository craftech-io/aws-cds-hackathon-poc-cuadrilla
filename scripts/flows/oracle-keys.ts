// Keys of the oracle table of docs/test-plan.md §4.3 ("Oráculos de los pasos `agent`"): their
// grammar, their scope and their precedence (ADR-0021).
//
//   clave    = flujos [ " (variante " letra ")" ] [ " (" alcance ")" ]
//   flujos   = "FL-xxx" | "FL-xxx..FL-yyy" | "FL-xxx, FL-zzz[, …]"
//   alcance  = cita { ", " cita } [ " y demás pasos" ]
//   cita     = "SC-nn/m" | "SC-nn/m.p" | "SC-nn/Xm" | "SC-nn/m..k"
//
// Backticks around citations are ignored. A scope without "y demás pasos" is the row of exactly the
// steps and parts it cites, which must be `agent` when cited directly (a range reaches only its
// `agent` ones); a scope with it is a general row whose citations are examples that must exist; a
// variant goes only with a scope of its own and must exist in the flow's catalog entry.
import { kindOf, resolveCitation, type ScenarioPlan } from "./plan";

export interface OracleKey {
  readonly flows: readonly string[];
  readonly shape: "single" | "range" | "list";
  readonly variant?: string;
  readonly scope?: { readonly citations: readonly string[]; readonly general: boolean };
}

const CITE = String.raw`SC-\d{2}/(?:X?\d+(?:\.[a-z])?|\d+\.\.\d+)`;
const KEY = new RegExp(
  String.raw`^(FL-\d{3}(?:\.\.FL-\d{3}|(?:, FL-\d{3})+)?)(?: \(variante ([a-z])\))?(?: \((${CITE}(?:, ${CITE})*)( y demás pasos)?\))?$`,
);

function expandFlows(text: string): { flows: string[]; shape: OracleKey["shape"] } {
  const range = /^FL-(\d{3})\.\.FL-(\d{3})$/.exec(text);
  if (range) {
    const from = Number(range[1]);
    const to = Number(range[2]);
    return { flows: Array.from({ length: to - from + 1 }, (_, index) => `FL-${String(from + index).padStart(3, "0")}`), shape: "range" };
  }
  const list = text.split(", ");
  return { flows: list, shape: list.length > 1 ? "list" : "single" };
}

export function parseOracleKey(raw: string): OracleKey | undefined {
  const match = KEY.exec(raw.replace(/`/g, "").trim());
  if (!match) return undefined;
  const { flows, shape } = expandFlows(match[1] ?? "");
  const scope = match[3] === undefined ? undefined : { citations: match[3].split(", "), general: match[4] !== undefined };
  return { flows, shape, ...(match[2] === undefined ? {} : { variant: match[2] }), ...(scope === undefined ? {} : { scope }) };
}

/** First cells of the oracle table. */
export function oracleKeys(testPlan: string): string[] {
  const start = testPlan.indexOf("**Oráculos de los pasos `agent`.**");
  if (start === -1) return [];
  const end = testPlan.indexOf("\n\n", testPlan.indexOf("\n|", start) + 1);
  return testPlan
    .slice(start, end === -1 ? undefined : end)
    .split("\n")
    .filter((line) => line.startsWith("| ") && !line.startsWith("| Flujo |") && !line.startsWith("|---"))
    .map((line) => (line.split(" | ")[0] ?? "").replace(/^\| /, ""));
}

/** The catalog entry of a flow, from its heading to the next one. */
function catalogEntry(catalog: string, flow: string): string {
  const start = catalog.indexOf(`### ${flow} · `);
  if (start === -1) return "";
  const next = catalog.indexOf("\n### ", start + 1);
  return catalog.slice(start, next === -1 ? undefined : next);
}

export function checkOracleKeys(testPlan: string, catalog: string, plan: ScenarioPlan): string[] {
  const errors: string[] = [];
  const scoped = new Map<string, string>();
  const general = new Map<string, string>();
  for (const raw of oracleKeys(testPlan)) {
    const key = parseOracleKey(raw);
    if (!key) {
      errors.push(`oracle key "${raw}": outside the grammar of docs/test-plan.md §4.3`);
      continue;
    }
    for (const flow of key.flows) if (!catalog.includes(`### ${flow} · `)) errors.push(`oracle key "${raw}": ${flow} is not in docs/flows-catalog.md`);
    if (key.variant !== undefined) {
      if (!key.scope || key.scope.general) errors.push(`oracle key "${raw}": a variant needs a scope of its own (without "y demás pasos")`);
      for (const flow of key.flows) if (!catalogEntry(catalog, flow).includes(`(${key.variant})`)) errors.push(`oracle key "${raw}": ${flow} has no variant (${key.variant})`);
    }
    if (key.scope && !key.scope.general) {
      for (const citation of key.scope.citations) {
        const { targets, error } = resolveCitation(plan, citation);
        if (error) errors.push(`oracle key "${raw}": ${error}`);
        const agent = targets.filter((target) => kindOf(plan, target) === "agent");
        if (!citation.includes("..") && targets.length > 0 && agent.length === 0) errors.push(`oracle key "${raw}": ${citation} is not an agent step or part`);
        for (const target of agent) {
          for (const flow of key.flows) {
            const pair = `${target} ${flow}`;
            const previous = scoped.get(pair);
            if (previous !== undefined) errors.push(`oracle keys "${previous}" and "${raw}": both are the row of ${pair} (precedence tie)`);
            scoped.set(pair, raw);
          }
        }
      }
      continue;
    }
    for (const citation of key.scope?.citations ?? []) {
      const { error } = resolveCitation(plan, citation);
      if (error) errors.push(`oracle key "${raw}": ${error}`);
    }
    for (const flow of key.flows) {
      const level = `${key.shape === "single" ? "single" : "group"} ${flow}${key.variant === undefined ? "" : ` (${key.variant})`}`;
      const previous = general.get(level);
      if (previous !== undefined) errors.push(`oracle keys "${previous}" and "${raw}": both are the general row of ${flow} (precedence tie)`);
      general.set(level, raw);
    }
  }
  return errors;
}
