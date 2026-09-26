// Brand neutrality check (ADR-0008, ADR-0018, docs/architecture.md §18): no term of the operator's
// external list may appear in the repository tree (code, seed, the manual, the source texts the
// synthetic photos are drawn from), in the commit messages, in the text or metadata of a PDF, or in
// the web build. The list never enters the repository: CI reads it from the GitHub secret
// FORBIDDEN_TERMS, and a local run from the environment. The design partner's name stays on the
// list: the brand is runtime configuration (BrandConfig), never content of the repository.
//
//   FORBIDDEN_TERMS="$(cat <list outside the repo>)" npm run lint:forbidden            tree + commits + PDFs
//   FORBIDDEN_TERMS="$(cat <list outside the repo>)" npm run lint:forbidden -- --dist  packages/web/dist
//
// List format: one term per line; blank lines and lines starting with "#" are ignored. A term may
// end with `|<flags>`:
//   i  ignore case              c  match case
//   a  ignore accents           e  match accents exactly
// A single word defaults to `ia` (any case, any accents); a name of several words defaults to `ce`,
// so ordinary prose such as "el norte grande" never matches a brand "Norte Grande" written with
// capitals. Matching is by whole word, Unicode-aware.
//
// Fails closed: with CI=true an absent or empty list fails the job. The output never prints a term,
// only where it was found and the term's position in the list.
//
// The neutral-surfaces guard (scripts/lint/neutral-surfaces.ts, ADR-0023) reuses the accent folding,
// the whole-word pattern and the file and PDF readers exported here.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ForbiddenTerm {
  /** 1-based position in the list: what the report prints instead of the term. */
  readonly index: number;
  readonly pattern: RegExp;
  readonly ignoreAccents: boolean;
}

export interface Finding {
  readonly source: string;
  readonly line: number;
  readonly term: number;
}

const WORD = "[\\p{L}\\p{N}_]";
const FLAGS = /^[icae]+$/;

export function stripAccents(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whole-word pattern of `text` (letters, digits and `_` make a word; a hyphen separates), the words of
 * a name joined by any run of whitespace. With `ignoreAccents` the term is folded here and the caller
 * folds the line with `stripAccents` before testing it.
 */
export function termPattern(text: string, options: { readonly ignoreCase: boolean; readonly ignoreAccents: boolean }): RegExp {
  const body = (options.ignoreAccents ? stripAccents(text) : text).split(/\s+/).map(escapeRegExp).join("\\s+");
  return new RegExp(`(?<!${WORD})${body}(?!${WORD})`, options.ignoreCase ? "iu" : "u");
}

export function parseTerms(raw: string): ForbiddenTerm[] {
  const terms: ForbiddenTerm[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const entry = line.trim();
    if (entry === "" || entry.startsWith("#")) continue;
    const bar = entry.lastIndexOf("|");
    const hasFlags = bar > 0 && FLAGS.test(entry.slice(bar + 1));
    const text = (hasFlags ? entry.slice(0, bar) : entry).trim();
    if (text === "") continue;
    const multiWord = /\s/.test(text);
    const flags = hasFlags ? entry.slice(bar + 1) : multiWord ? "ce" : "ia";
    const ignoreCase = flags.includes("i") && !flags.includes("c");
    const ignoreAccents = flags.includes("a") && !flags.includes("e");
    terms.push({ index: terms.length + 1, ignoreAccents, pattern: termPattern(text, { ignoreCase, ignoreAccents }) });
  }
  return terms;
}

/** Every (line, term) of `text` that matches, in line order. */
export function findTerms(source: string, text: string, terms: readonly ForbiddenTerm[]): Finding[] {
  const findings: Finding[] = [];
  text.split("\n").forEach((line, index) => {
    const plain = stripAccents(line);
    for (const term of terms) {
      if (term.pattern.test(term.ignoreAccents ? plain : line)) findings.push({ source, line: index + 1, term: term.index });
    }
  });
  return findings;
}

export type ListStatus = { readonly ok: true; readonly terms: ForbiddenTerm[] } | { readonly ok: false; readonly fatal: boolean; readonly message: string };

/** The list from the environment; missing or empty fails closed in CI and only warns locally. */
export function listFromEnv(env: NodeJS.ProcessEnv): ListStatus {
  const terms = parseTerms(env.FORBIDDEN_TERMS ?? "");
  if (terms.length > 0) return { ok: true, terms };
  const ci = env.CI === "true";
  return {
    ok: false,
    fatal: ci,
    message: ci ? "FORBIDDEN_TERMS is absent or empty: the check fails closed in CI." : "FORBIDDEN_TERMS is not set: nothing was checked (local run).",
  };
}

// ---- Sources -----------------------------------------------------------------------------------

export function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8000).includes(0);
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
}

/** Tracked and untracked-but-not-ignored files of the working tree, relative to `cwd`. */
export function treeFiles(cwd: string): string[] {
  return git(cwd, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter((file) => file !== "" && existsSync(join(cwd, file)));
}

export function distFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) distFiles(path, out);
    else out.push(path);
  }
  return out;
}

/** Text and metadata of a PDF, one string. */
export async function pdfText(bytes: Buffer): Promise<string> {
  const { extractText, getMeta, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: true });
  const meta = await getMeta(pdf);
  const values = [...Object.values(meta.info ?? {}), ...Object.values(meta.metadata ?? {})].filter((value): value is string => typeof value === "string");
  return [text, ...values].join("\n");
}

async function scanFile(cwd: string, path: string, terms: readonly ForbiddenTerm[]): Promise<Finding[]> {
  const bytes = readFileSync(path);
  const source = relative(cwd, path);
  if (path.toLowerCase().endsWith(".pdf")) return findTerms(`${source} (pdf text and metadata)`, await pdfText(bytes), terms);
  if (isBinary(bytes)) return [];
  return findTerms(source, bytes.toString("utf8"), terms);
}

function commitMessages(cwd: string): string {
  try {
    return git(cwd, ["log", "--format=%B"]);
  } catch {
    // A repository without commits yet has no messages to check.
    return "";
  }
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const list = listFromEnv(process.env);
  if (!list.ok) {
    (list.fatal ? console.error : console.warn)(`forbidden-terms: ${list.message}`);
    if (list.fatal) process.exit(1);
    return;
  }
  const dist = process.argv.includes("--dist");
  const findings: Finding[] = [];
  let checked = 0;
  if (dist) {
    const dir = join(cwd, "packages/web/dist");
    if (!existsSync(dir)) {
      console.error("forbidden-terms: packages/web/dist does not exist; run `npm run build -w packages/web` first.");
      process.exit(1);
    }
    for (const file of distFiles(dir)) {
      findings.push(...(await scanFile(cwd, file, list.terms)));
      checked += 1;
    }
  } else {
    for (const file of treeFiles(cwd)) {
      findings.push(...(await scanFile(cwd, join(cwd, file), list.terms)));
      checked += 1;
    }
    findings.push(...findTerms("git log --format=%B", commitMessages(cwd), list.terms));
  }
  if (findings.length > 0) {
    console.error(`forbidden-terms: ${findings.length} match(es) of the external list (terms are never printed):`);
    for (const { source, line, term } of findings) console.error(`  ${source}:${line}  term #${term}`);
    process.exit(1);
  }
  console.log(`forbidden-terms: ${checked} file(s)${dist ? " of the web build" : " and the commit messages"} checked against ${list.terms.length} term(s), no match.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
