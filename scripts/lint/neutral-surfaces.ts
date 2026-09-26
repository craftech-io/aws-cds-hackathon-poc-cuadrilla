// Neutral public surfaces guard (ADR-0023 §3, flow FL-120): no text a person outside the team can
// read or hear names the contest or the people who assess the entries. It reads the visible sources
// of the ADR's table (comments included), the README up to its "## Submission notes" heading, the
// text of every versioned PDF (with the extractor of lint:forbidden) and the authentication emails
// rendered in memory (scripts/lint/neutral-renderers.ts); with `--dist`, the web build.
//
//   npm run lint:neutral-surfaces            sources, rendered emails, PDFs and the product README
//   npm run lint:neutral-surfaces -- --dist  packages/web/dist (fails when there is no build)
//
// The words are those of scripts/lint/neutral-terms.ts, matched without case or accents and by whole
// word. HTML character references and JavaScript escapes are decoded first, so an encoded accent or
// an escaped letter hides nothing. Every finding prints file, line and word; any finding exits 1.
// The internal places where the contest may be named (docs/, CLAUDE.md, CONTEXT.md, .claude/, tests,
// the README from "## Submission notes" on) are not among the sources; a new source, or a new
// exception, goes into ADR-0023's table and here in the same change.
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { distFiles, isBinary, pdfText, treeFiles } from "./forbidden-terms";
import { renderAuthEmails, type AuthEmailRenderer } from "./neutral-renderers";
import { findNeutralTerms, type NeutralFinding } from "./neutral-terms";

export const README_FILE = "README.md";
export const DIST_DIR = "packages/web/dist";
const SUBMISSION_NOTES = /^##\s+Submission notes\s*$/;

interface SourceRule {
  readonly path: RegExp;
  /** A test file under the rule is a visible source too (the seed's data has no exception). */
  readonly includesTests?: true;
}

/** Visible sources of ADR-0023's table, as repository-relative paths; PDFs have their own rule. */
export const VISIBLE_SOURCES: readonly SourceRule[] = [
  // Landing, signup, login, recovery, console, simulator, public and legal pages.
  { path: /^packages\/web\/src\// },
  { path: /^packages\/web\/index\.html$/ },
  { path: /^packages\/web\/public\// },
  // Staff texts, WhatsApp templates, product emails, the certificate, the lead notice, the main story
  // and the authentication emails of the Cognito trigger (copy/auth-emails*.ts).
  { path: /^packages\/bff\/src\/(copy|certificates|leads|story)\// },
  // Fixed inputs of the model's replies.
  { path: /^packages\/bff\/src\/agent\/system-prompt\.ts$/ },
  { path: /^packages\/bff\/src\/agent-tools\/[^/]+\/schema\.ts$/ },
  { path: /^infra\/agent-tool-schemas\.ts$/ },
  // Default templates of the user pool.
  { path: /^infra\/auth-email\.ts$/ },
  // Seed texts a user reads or hears.
  { path: /^scripts\/seed\/data\//, includesTests: true },
  { path: /^scripts\/seed\/(photos|audio)\/texts\.ts$/ },
  // What the landing's renders and captures draw.
  { path: /^scripts\/landing\// },
];

/** Tests (ADR-0023 §2): internal, never a visible source unless a rule says so. */
const TEST_FILE = /\.(test|spec)\.tsx?$|^tests\/|^packages\/web\/e2e\//;
/** Internal documents: their PDFs are not surfaces either. */
const INTERNAL_DOCS = /^(docs|\.claude)\//;

export function isVisibleSource(path: string): boolean {
  if (path.toLowerCase().endsWith(".pdf")) return !INTERNAL_DOCS.test(path);
  return VISIBLE_SOURCES.some((rule) => rule.path.test(path) && (rule.includesTests === true || !TEST_FILE.test(path)));
}

/** The product README: everything before the "## Submission notes" heading, with its line numbers. */
export function productReadme(text: string): string {
  const lines = text.split("\n");
  const notes = lines.findIndex((line) => SUBMISSION_NOTES.test(line));
  return notes === -1 ? text : lines.slice(0, notes).join("\n");
}

const NAMED_REFERENCES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

// A control character (a line break too) becomes a space: it separates words like the escape it came
// from, and the finding keeps the line of the file.
function codePoint(code: number, original: string): string {
  if (code > 0x10ffff) return original;
  return code < 0x20 || code === 0x7f ? " " : String.fromCodePoint(code);
}

/** HTML character references and JavaScript/JSON string escapes, decoded in place. */
export function decodeEscapes(text: string): string {
  return text
    .replace(/\\[bfnrt]/g, " ")
    .replace(/\\u\{([0-9a-f]{1,6})\}|\\u([0-9a-f]{4})|\\x([0-9a-f]{2})/gi, (match, braced?: string, four?: string, two?: string) =>
      codePoint(Number.parseInt(braced ?? four ?? two ?? "", 16), match),
    )
    .replace(/&#x([0-9a-f]{1,6});|&#(\d{1,7});|&([a-z]+);/gi, (match, hex?: string, decimal?: string, name?: string) => {
      if (hex !== undefined) return codePoint(Number.parseInt(hex, 16), match);
      if (decimal !== undefined) return codePoint(Number.parseInt(decimal, 10), match);
      // An accented letter (`&oacute;`) keeps its base letter: matching ignores accents anyway.
      const accented = /^([a-z])(acute|grave|circ|tilde|uml)$/i.exec(name ?? "");
      return NAMED_REFERENCES[(name ?? "").toLowerCase()] ?? accented?.[1] ?? match;
    });
}

export function scanText(source: string, text: string): NeutralFinding[] {
  return findNeutralTerms(source, decodeEscapes(text));
}

export type PdfExtractor = (bytes: Buffer) => Promise<string>;

/** One file of the repository or the build; binary files other than PDFs have no text to read. */
async function scanFile(root: string, path: string, extractPdf: PdfExtractor): Promise<NeutralFinding[]> {
  const bytes = readFileSync(join(root, path));
  if (path.toLowerCase().endsWith(".pdf")) return scanText(`${path} (pdf text and metadata)`, await extractPdf(bytes));
  if (isBinary(bytes)) return [];
  const text = bytes.toString("utf8");
  return scanText(path, path === README_FILE ? productReadme(text) : text);
}

export interface ScanResult {
  readonly findings: NeutralFinding[];
  /** Files, rendered emails and build files read. */
  readonly checked: number;
}

export interface SourceScanOptions {
  /** Repository-relative paths to consider; the working tree's by default. */
  readonly files?: readonly string[];
  readonly renderers?: readonly AuthEmailRenderer[];
  readonly extractPdf?: PdfExtractor;
}

/** Visible sources, the product README, versioned PDFs and the rendered authentication emails. */
export async function scanSources(root: string, options: SourceScanOptions = {}): Promise<ScanResult> {
  const extractPdf = options.extractPdf ?? pdfText;
  const files = (options.files ?? treeFiles(root)).filter((file) => file === README_FILE || isVisibleSource(file)).sort();
  const findings: NeutralFinding[] = [];
  for (const file of files) findings.push(...(await scanFile(root, file, extractPdf)));
  const emails = renderAuthEmails(options.renderers);
  for (const email of emails) findings.push(...scanText(email.source, email.text));
  return { findings, checked: files.length + emails.length };
}

/** Every file of the web build; without a build it throws, so the check fails closed. */
export async function scanDist(root: string, extractPdf: PdfExtractor = pdfText): Promise<ScanResult> {
  const dir = join(root, DIST_DIR);
  if (!existsSync(dir)) throw new Error(`${DIST_DIR} does not exist; run \`npm run build -w packages/web\` first.`);
  const files = distFiles(dir)
    .map((path) => relative(root, path))
    .sort();
  const findings: NeutralFinding[] = [];
  for (const file of files) findings.push(...(await scanFile(root, file, extractPdf)));
  return { findings, checked: files.length };
}

export function formatFindings(findings: readonly NeutralFinding[]): string[] {
  return findings.map(({ source, line, term }) => `  ${source}:${line}  "${term}"`);
}

async function main(): Promise<void> {
  const root = process.cwd();
  const dist = process.argv.includes("--dist");
  let result: ScanResult;
  try {
    result = dist ? await scanDist(root) : await scanSources(root);
  } catch (error) {
    console.error(`neutral-surfaces: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  if (result.findings.length > 0) {
    console.error(`neutral-surfaces: ${result.findings.length} word(s) of ADR-0023 on a visible surface:`);
    for (const line of formatFindings(result.findings)) console.error(line);
    process.exit(1);
  }
  const what = dist ? "file(s) of the web build" : "visible source(s) and rendered email(s)";
  console.log(`neutral-surfaces: ${result.checked} ${what} checked, no word of ADR-0023.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
