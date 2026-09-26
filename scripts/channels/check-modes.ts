// CI check of the WhatsApp transports and world modes (ADR-0002, docs/architecture.md §18):
//
//   1. `infra/channel-modes.ts`: email is "live" and the WhatsApp transports of the stage are a
//      plain literal list; "live" may be among them only when P-01 of docs/pending.md is closed
//      ("Cerrado el AAAA-MM-DD por <quién>" in its "Estado" cell).
//   2. Every world template of `scripts/seed/data/worlds/*.json` runs `whatsappMode: simulated`: a
//      world goes live only through `SeedOverrides.liveWorldClockId`, never from a template.
//   3. `scripts/seed/overrides.example.json` declares at most one live world.
//
// Templates and the overrides example arrive with the seed (WP-17); until then items 2 and 3 have
// nothing to check. Usage: `npm run channels:check-modes` (from the repository root). Exit 1 on any
// violation.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type WhatsAppTransport = "live" | "simulated";

export const MODES_FILE = "infra/channel-modes.ts";
export const PENDING_FILE = "docs/pending.md";
export const WORLDS_DIR = "scripts/seed/data/worlds";
export const OVERRIDES_EXAMPLE = "scripts/seed/overrides.example.json";

/** Pending item that must be closed before WhatsApp may have the live transport. */
export const WHATSAPP_GATE = "P-01";

export interface Modes {
  readonly email?: string;
  readonly transports?: readonly string[];
}

export function readModes(source: string): Modes {
  const email = /^\s*email\s*:\s*"([a-z]+)"\s*,?/m.exec(source)?.[1];
  const list = /^\s*whatsapp\s*:\s*\{\s*transports\s*:\s*\[([^\]]*)\]\s*\}\s*,?/m.exec(source)?.[1];
  const transports = list === undefined ? undefined : [...list.matchAll(/"([a-z]+)"/g)].map((match) => match[1] ?? "");
  return { ...(email === undefined ? {} : { email }), ...(transports === undefined ? {} : { transports }) };
}

// The pending table: `| P-01 | Pendiente | Dueño | Estado | Qué falta |`. Returns the Estado cell.
export function pendingStatus(markdown: string, id: string): string | undefined {
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map((cell) => cell.trim());
    // cells[0] is the empty string before the first pipe; the id is the first real cell.
    if (cells[1] !== id) continue;
    return cells[4];
  }
  return undefined;
}

export function isClosed(status: string): boolean {
  return /^Cerrad[oa] el \d{4}-\d{2}-\d{2} por \S.*$/.test(status.trim());
}

export function checkModes(modesSource: string, pendingMarkdown: string): string[] {
  const errors: string[] = [];
  const { email, transports } = readModes(modesSource);
  if (email !== "live") errors.push(`${MODES_FILE}: email must be "live" as a plain string literal on its own line.`);
  if (transports === undefined) {
    errors.push(`${MODES_FILE}: "whatsapp: { transports: [...] }" not found as a plain literal on its own line.`);
    return errors;
  }
  const unknown = transports.filter((transport) => transport !== "live" && transport !== "simulated");
  if (unknown.length > 0) errors.push(`${MODES_FILE}: unknown WhatsApp transport(s) ${unknown.map((name) => `"${name}"`).join(", ")}.`);
  if (!transports.includes("simulated")) errors.push(`${MODES_FILE}: the "simulated" transport must stay: every guest, QA and evaluation world uses it.`);
  if (!transports.includes("live")) return errors;

  const status = pendingStatus(pendingMarkdown, WHATSAPP_GATE);
  if (status === undefined) {
    errors.push(`${MODES_FILE}: "live" is a WhatsApp transport but ${PENDING_FILE} has no row for ${WHATSAPP_GATE}.`);
  } else if (!isClosed(status)) {
    errors.push(
      `${MODES_FILE}: "live" is a WhatsApp transport but ${WHATSAPP_GATE} in ${PENDING_FILE} is still open ` +
        `(Estado: "${status}"). The cell must read "Cerrado el <AAAA-MM-DD> por <quién>".`,
    );
  }
  return errors;
}

/** Paths (`a.b[0].c`) of every `whatsappMode` other than "simulated" inside a parsed JSON value. */
export function liveModePaths(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => liveModePaths(item, `${path}[${index}]`));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const here = `${path}.${key}`;
    if (key === "whatsappMode" && child !== "simulated") return [here];
    return liveModePaths(child, here);
  });
}

export function checkWorldTemplates(templates: ReadonlyArray<readonly [string, string]>): string[] {
  return templates.flatMap(([file, json]) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return [`${file}: not valid JSON.`];
    }
    return liveModePaths(parsed).map((path) => `${file}: ${path} must be "simulated"; a world goes live only through SeedOverrides.liveWorldClockId.`);
  });
}

export function checkOverridesExample(json: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [`${OVERRIDES_EXAMPLE}: not valid JSON.`];
  }
  const live = (parsed as { liveWorldClockId?: unknown } | null)?.liveWorldClockId;
  if (live === undefined || live === null || typeof live === "string") return [];
  const count = Array.isArray(live) ? live.length : "an unexpected value";
  return [`${OVERRIDES_EXAMPLE}: liveWorldClockId must be null or one clockId (found ${count}); there is at most one live world.`];
}

function main(): void {
  const cwd = process.cwd();
  const errors = checkModes(readFileSync(resolve(cwd, MODES_FILE), "utf8"), readFileSync(resolve(cwd, PENDING_FILE), "utf8"));
  const worldsDir = join(cwd, WORLDS_DIR);
  const templates = existsSync(worldsDir)
    ? readdirSync(worldsDir)
        .filter((file) => file.endsWith(".json"))
        .map((file) => [`${WORLDS_DIR}/${file}`, readFileSync(join(worldsDir, file), "utf8")] as const)
    : [];
  errors.push(...checkWorldTemplates(templates));
  if (existsSync(join(cwd, OVERRIDES_EXAMPLE))) errors.push(...checkOverridesExample(readFileSync(join(cwd, OVERRIDES_EXAMPLE), "utf8")));

  if (errors.length > 0) {
    console.error(`check-modes: ${errors.length} violation(s):`);
    for (const error of errors) console.error(`  ${error}`);
    process.exit(1);
  }
  const { email, transports } = readModes(readFileSync(resolve(cwd, MODES_FILE), "utf8"));
  console.log(`check-modes: ok (email=${email} whatsapp.transports=[${(transports ?? []).join(", ")}], ${templates.length} world template(s)).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
