// `npm run qa:deployed-surfaces` (docs/test-plan.md §6.1, row "Superficies neutrales"; ADR-0023): the
// neutral-surfaces guard and the forbidden-terms list over the build the stage SERVES, not the local
// `dist`. It fetches the public pages, follows every same-origin script, style, manifest and SVG they
// reference (and the chunks the scripts import), and scans each text file with the two guards of
// scripts/lint/. The external list comes from FORBIDDEN_TERMS, as `lint:forbidden` reads it; without
// it only the neutral words are checked (and it says so). A finding prints the file, the line and the
// word of ADR-0023 or the position of the external term, never the term.
//
// The runtime brand of the stage (`brand.get`, the design partner's name in co-branding) is data of the
// API, not of the build, and is not fetched here.
//
//   npm run qa:deployed-surfaces [-- --base-url https://cuadrilla.demo.craftech.io]
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFlags } from "../channels/cli-args";
import { type Finding, findTerms, listFromEnv } from "../lint/forbidden-terms";
import { formatFindings, scanText } from "../lint/neutral-surfaces";
import type { NeutralFinding } from "../lint/neutral-terms";
import { DEFAULT_BASE_URL } from "../smoke/interim";

export const ENTRY_PATHS = ["/", "/signup", "/login", "/join", "/legal/privacy.html", "/legal/terms.html"] as const;

const TEXT_ASSET = /\.(?:js|mjs|css|html|svg|json|webmanifest|txt)$/i;

/** Same-origin paths a text file references: attributes, CSS `url()`, and the chunks a module imports. */
export function referencedPaths(text: string, fromPath: string): string[] {
  const found = new Set<string>();
  const add = (raw: string) => {
    const value = raw.trim();
    if (value === "" || /^(?:https?:|data:|mailto:|#|\/\/)/i.test(value)) return;
    const path = value.startsWith("/") ? value : new URL(value, `https://x${fromPath}`).pathname;
    const clean = path.split(/[?#]/)[0] ?? "";
    if (TEXT_ASSET.test(clean)) found.add(clean);
  };
  for (const match of text.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)) add(match[1] ?? "");
  for (const match of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) add(match[1] ?? "");
  for (const match of text.matchAll(/["'`]((?:\.{1,2}\/|\/|assets\/)[\w./-]+\.(?:js|css|svg|json))["'`]/g)) {
    const value = match[1] ?? "";
    add(value.startsWith("assets/") ? `/${value}` : value);
  }
  return [...found];
}

export interface CrawlResult {
  readonly files: ReadonlyMap<string, string>;
  readonly failures: readonly string[];
}

export async function crawl(baseUrl: string, fetcher: typeof fetch = fetch): Promise<CrawlResult> {
  const files = new Map<string, string>();
  const failures: string[] = [];
  const queue: string[] = [...ENTRY_PATHS];
  while (queue.length > 0) {
    const path = queue.shift() ?? "";
    if (files.has(path)) continue;
    const response = await fetcher(`${baseUrl}${path}`, { signal: AbortSignal.timeout(15_000) });
    if (response.status !== 200) {
      failures.push(`${path} answered ${response.status}`);
      files.set(path, "");
      continue;
    }
    const text = await response.text();
    files.set(path, text);
    for (const next of referencedPaths(text, path)) if (!files.has(next)) queue.push(next);
  }
  return { files, failures };
}

async function main(): Promise<void> {
  let baseUrl = DEFAULT_BASE_URL;
  parseFlags(process.argv.slice(2), {
    "--base-url": (value) => {
      baseUrl = value().replace(/\/$/, "");
    },
  });
  const { files, failures } = await crawl(baseUrl);
  const neutral: NeutralFinding[] = [];
  const forbidden: Finding[] = [];
  const list = listFromEnv(process.env);
  for (const [path, text] of files) {
    neutral.push(...scanText(`deployed ${path}`, text));
    if (list.ok) forbidden.push(...findTerms(`deployed ${path}`, text, list.terms));
  }
  console.log(`qa:deployed-surfaces: ${files.size} file(s) of the deployed build read from ${baseUrl}.`);
  if (!list.ok) console.warn(`qa:deployed-surfaces: ${list.message}`);
  let failed = failures.length > 0;
  for (const failure of failures) console.error(`  ${failure}`);
  if (neutral.length > 0) {
    failed = true;
    console.error(`qa:deployed-surfaces: ${neutral.length} word(s) of ADR-0023 in the deployed build:`);
    for (const line of formatFindings(neutral)) console.error(line);
  } else console.log("qa:deployed-surfaces: no word of ADR-0023.");
  if (list.ok) {
    if (forbidden.length > 0) {
      failed = true;
      console.error(`qa:deployed-surfaces: ${forbidden.length} match(es) of the external list (terms are never printed):`);
      for (const { source, line, term } of forbidden) console.error(`  ${source}:${line}  term #${term}`);
    } else console.log(`qa:deployed-surfaces: ${list.terms.length} external term(s), no match.`);
  }
  if (failed) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error: unknown) => {
    console.error(`qa:deployed-surfaces: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
