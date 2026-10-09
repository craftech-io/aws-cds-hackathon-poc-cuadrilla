// Every Lambda whose handler reaches the outbound pipeline of the stage (packages/bff/src/outbound/stage.ts,
// `stageOutboundDeps`) holds PIPELINE (G2, G3, SEND_EMAIL, SEND_WHATSAPP, TIMERS) and reads `Reference`:
// a live send loads the approved templates (policy/records.ts `reference.listTemplates`) and a template
// goes through G3. The simulated route skips both, so a missing grant only shows on the live number.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LAMBDA_CAPABILITIES, expectedTables, resolveCapabilities, type LambdaName } from "./iam-capabilities";

const ROOT = process.cwd();
const BFF = resolve(ROOT, "packages/bff/src");
const PIPELINE_ENTRY = resolve(BFF, "outbound/stage.ts");

/** The handler module of a Lambda of packages/bff, by the layout of infra (agent-tools, routers, handlers). */
function handlerFile(fn: LambdaName): string | undefined {
  if (fn.startsWith("Tool")) return resolve(BFF, `agent-tools/${fn.slice(4).toLowerCase()}/index.ts`);
  if (fn === "Bff") return resolve(BFF, "routers/handler.ts");
  if (fn === "InboundWhatsApp") return resolve(BFF, "handlers/inbound-whatsapp.ts");
  const file = resolve(BFF, `handlers/${fn.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()}.ts`);
  return existsSync(file) ? file : undefined;
}

function resolveImport(from: string, spec: string): string | undefined {
  const base = resolve(dirname(from), spec);
  return [`${base}.ts`, `${base}/index.ts`, base.replace(/\.js$/, ".ts")].find((candidate) => existsSync(candidate));
}

/** Whether `entry` imports `target`, directly or through any relative import. */
function reaches(entry: string, target: string): boolean {
  const seen = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    if (file === target) return true;
    for (const match of readFileSync(file, "utf8").matchAll(/(?:from|import)\s*\(?\s*"(\.{1,2}\/[^"]+)"/g)) {
      const next = resolveImport(file, match[1] as string);
      if (next !== undefined) pending.push(next);
    }
  }
  return false;
}

describe("holders of the outbound pipeline [W3 review B2/B3]", () => {
  const users = (Object.keys(LAMBDA_CAPABILITIES) as LambdaName[]).filter((fn) => {
    const file = handlerFile(fn);
    return file !== undefined && reaches(file, PIPELINE_ENTRY);
  });

  it("finds the worker, the channel's Lambda and the tools that send", () => {
    expect(users.sort()).toEqual(["InboundWhatsApp", "InstallerWorker", "ToolCases", "ToolEvidence", "ToolMessaging", "ToolOrders"]);
  });

  it.each(["InboundWhatsApp", "InstallerWorker", "ToolCases", "ToolEvidence", "ToolMessaging", "ToolOrders"] as const)("%s holds PIPELINE and reads Reference", (fn) => {
    expect(resolveCapabilities(LAMBDA_CAPABILITIES[fn].capabilities)).toEqual(expect.arrayContaining(["PIPELINE", "SEND_EMAIL", "SEND_WHATSAPP", "TIMERS"]));
    expect(expectedTables(fn).Reference).toMatch(/^(read|write)$/);
  });
});
