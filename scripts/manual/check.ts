// `npm run manual:check` (docs/architecture.md §18): the manual of the Knowledge Base as the product
// needs it. Fails on a section without id, title or version, a repeated id, a sidecar that does not
// match its section, a section over its token budget, a section the evaluation set cites that does
// not exist, the text of §SEG-01 differing from `safetyInstruction` of copy/es-MX.ts (ADR-0016), or
// any text naming the default operator of copy/brand.ts (ADR-0018). `seed:validate` runs the same
// check (invariant 6), and the generator before writing.
//
//   npm run manual:check                         the committed manual (scripts/seed/data)
//   npm run manual:check -- --dir <data dir>     another copy of the seed's data directory
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_OPERATOR_NAME } from "../../packages/bff/src/copy/brand";
import { esMX } from "../../packages/bff/src/copy/es-MX";
import { parseFlags } from "../channels/cli-args";
import { MANUAL_SECTION_COUNT, ManualSidecar, paragraphsOf, parseSectionFile } from "../seed/lib/manual";
import { DATA_DIR, DATA_LAYOUT, MANUAL_VERSION, fromRoot } from "../seed/lib/paths";
import { QuestionsFile, parseOutcome } from "../seed/lib/questions";
import { SECTION_TOKEN_BUDGET, containsPhrase, estimateTokens } from "../seed/lib/text";
import { readDataDir } from "../seed/validate/bundle";

/** The section whose text is the fixed safety instruction (ADR-0016). */
export const SAFETY_SECTION = "SEG-01";

export interface ManualReport {
  readonly errors: string[];
  /** Sections found, by id. */
  readonly sections: ReadonlyMap<string, { readonly title: string; readonly body: string }>;
}

function sectionsCitedBy(questionsText: string | undefined, errors: string[]): Set<string> {
  const cited = new Set<string>();
  if (questionsText === undefined) {
    errors.push(`${DATA_LAYOUT.questions}: missing`);
    return cited;
  }
  const parsed = QuestionsFile.safeParse(JSON.parse(questionsText));
  if (!parsed.success) {
    errors.push(`${DATA_LAYOUT.questions}: does not match its schema`);
    return cited;
  }
  for (const question of parsed.data.questions) {
    for (const section of question.expectedSections) cited.add(section);
    for (const outcome of question.acceptedOutcomes) {
      const parsedOutcome = parseOutcome(outcome);
      if (parsedOutcome?.kind === "CITED_ANSWER") for (const section of parsedOutcome.sections) cited.add(section);
    }
  }
  return cited;
}

/** Every problem of the manual in `files` (paths relative to the data directory). */
export function checkManual(files: ReadonlyMap<string, string>): ManualReport {
  const errors: string[] = [];
  const sections = new Map<string, { title: string; body: string }>();
  const prefix = `${DATA_LAYOUT.manual}/`;
  const markdown = [...files.keys()].filter((path) => path.startsWith(prefix) && path.endsWith(".md")).sort();
  for (const path of markdown) {
    const text = files.get(path) ?? "";
    const parsed = parseSectionFile(text);
    const fileId = path.slice(prefix.length, -".md".length);
    if (parsed === undefined) {
      errors.push(`${path}: the first line is not "# <id> · <title>"`);
      continue;
    }
    if (parsed.sectionId !== fileId) errors.push(`${path}: the heading says ${parsed.sectionId}`);
    if (!parsed.hasVersionLine) errors.push(`${path}: no version line`);
    if (parsed.body === "") errors.push(`${path}: empty section`);
    if (sections.has(parsed.sectionId)) errors.push(`${path}: section ${parsed.sectionId} repeated`);
    sections.set(parsed.sectionId, { title: parsed.title, body: parsed.body });
    const tokens = estimateTokens(text);
    if (tokens > SECTION_TOKEN_BUDGET) errors.push(`${path}: about ${tokens} tokens, over ${SECTION_TOKEN_BUDGET}`);
    if (containsPhrase(text, DEFAULT_OPERATOR_NAME)) errors.push(`${path}: names the default operator; the manual says "la operadora"`);
    const sidecarText = files.get(`${path}.metadata.json`);
    const sidecar = sidecarText === undefined ? undefined : ManualSidecar.safeParse(JSON.parse(sidecarText));
    if (sidecar === undefined || !sidecar.success) {
      errors.push(`${path}: missing or invalid sidecar`);
      continue;
    }
    const attributes = sidecar.data.metadataAttributes;
    if (attributes.sectionId !== parsed.sectionId || attributes.title !== parsed.title) errors.push(`${path}: the sidecar names another section or title`);
    if (attributes.manualVersion !== MANUAL_VERSION) errors.push(`${path}: the sidecar declares version ${attributes.manualVersion}`);
  }
  if (sections.size !== MANUAL_SECTION_COUNT) errors.push(`the manual has ${sections.size} sections, not ${MANUAL_SECTION_COUNT}`);
  const safety = sections.get(SAFETY_SECTION);
  if (safety === undefined || !paragraphsOf(safety.body).includes(esMX.safetyInstruction)) errors.push(`§${SAFETY_SECTION} does not carry the text of safetyInstruction of copy/es-MX.ts verbatim`);
  for (const cited of sectionsCitedBy(files.get(DATA_LAYOUT.questions), errors)) if (!sections.has(cited)) errors.push(`the evaluation set cites §${cited}, which does not exist`);
  return { errors, sections };
}

function main(): void {
  let dir = fromRoot(DATA_DIR);
  parseFlags(process.argv.slice(2), { "--dir": (value) => (dir = resolve(value())) });
  const { errors, sections } = checkManual(readDataDir(dir));
  if (errors.length > 0) {
    console.error(`manual:check: ${errors.length} problem(s):`);
    for (const error of errors) console.error(`  ${error}`);
    process.exit(1);
  }
  console.log(`manual:check: ${sections.size} sections of ${MANUAL_VERSION}, §${SAFETY_SECTION} identical to copy/es-MX.ts, every cited section present.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
