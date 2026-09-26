// Invariants of the content (docs/seed-spec.md §14): 6 the manual; 7 the evaluation set; 11 forbidden
// terms and the names checked in NAMECHECK; 12 the WhatsApp templates; 13 the rate card; 24 nothing
// names the operator (the seed has no `displayName` and no text carries the default operator name).
import { DEFAULT_OPERATOR_NAME } from "../../../packages/bff/src/copy/brand";
import { checkManual } from "../../manual/check";
import { findTerms, parseTerms } from "../../lint/forbidden-terms";
import { allVoiceTexts } from "../audio/texts";
import { NAME_CHECKS, pendingWebSearches } from "../generate/namecheck";
import { parseOutcome } from "../lib/questions";
import { SEED_TABLES } from "../lib/tables";
import { containsPhrase, ngramsOf, stringsOf } from "../lib/text";
import { allPhotoTexts } from "../photos/texts";
import { entities, worldsOf, type SeedBundle } from "./bundle";
import { finding, type CheckEnv, type Finding, type Invariant } from "./types";

/** A question may share at most eight consecutive words with the manual (invariant 7). */
const MAX_SHARED_WORDS = 8;

function manual(bundle: SeedBundle): string[] {
  return checkManual(bundle.files).errors;
}

function questions(bundle: SeedBundle): string[] {
  const file = bundle.questions;
  if (file === undefined) return ["eval/questions.json: missing or invalid"];
  const { sections } = checkManual(bundle.files);
  const errors: string[] = [];
  const count = (type: "A" | "R"): number => file.questions.filter((question) => question.type === type).length;
  if (count("A") !== 40 || count("R") !== 10) errors.push(`the set has ${count("A")} A and ${count("R")} R questions, not 40 and 10`);
  const ids = file.questions.map((question) => question.questionId);
  if (new Set(ids).size !== ids.length) errors.push("question ids repeat");
  const manualGrams = new Set([...sections.values()].flatMap((section) => [...ngramsOf(section.body, MAX_SHARED_WORDS + 1)]));
  for (const question of file.questions) {
    const cited = [...question.expectedSections, ...question.acceptedOutcomes.flatMap((outcome) => {
      const parsed = parseOutcome(outcome);
      return parsed?.kind === "CITED_ANSWER" ? parsed.sections : [];
    })];
    for (const section of cited) if (!sections.has(section)) errors.push(`${question.questionId}: §${section} does not exist`);
    if (question.type === "A" && !question.acceptedOutcomes.some((outcome) => parseOutcome(outcome)?.kind === "CITED_ANSWER")) errors.push(`${question.questionId}: an A question must accept a cited answer`);
    const shared = [...ngramsOf(question.text, MAX_SHARED_WORDS + 1)].find((gram) => manualGrams.has(gram));
    if (shared !== undefined) errors.push(`${question.questionId}: repeats a phrase of the manual ("${shared}")`);
  }
  const rows = bundle.tables.Reference.filter((item) => item.entity === "EvalQuestion");
  if (rows.length !== file.questions.length) errors.push(`EVAL#QUESTIONS has ${rows.length} rows, eval/questions.json ${file.questions.length}`);
  return errors;
}

/** Every text the forbidden-terms and brand checks read: data files, photo texts and voice texts. */
function textSources(bundle: SeedBundle): Array<{ readonly source: string; readonly text: string }> {
  return [
    ...[...bundle.files].map(([path, text]) => ({ source: `scripts/seed/data/${path}`, text })),
    { source: "scripts/seed/photos/texts.ts (drawn texts)", text: allPhotoTexts().join("\n") },
    { source: "scripts/seed/audio/texts.ts (spoken texts)", text: allVoiceTexts().join("\n") },
  ];
}

function namesAndTerms(bundle: SeedBundle, env: CheckEnv): Finding {
  const errors: string[] = [];
  const warnings: string[] = [];
  const terms = parseTerms(env.forbiddenTerms ?? "");
  if (terms.length === 0) {
    (env.ci ? errors : warnings).push(env.ci ? "FORBIDDEN_TERMS is absent or empty: the check fails closed in CI" : "FORBIDDEN_TERMS is not set: forbidden terms not checked (local run)");
  } else {
    for (const { source, text } of textSources(bundle)) for (const hit of findTerms(source, text, terms)) errors.push(`${hit.source}:${hit.line} matches term #${hit.term} of the external list`);
  }
  const checked = new Set(bundle.tables.Reference.filter((item) => item.entity === "NameCheck").map((item) => String(item.term)));
  for (const check of NAME_CHECKS) if (!checked.has(check.term)) errors.push(`NAMECHECK has no row for "${check.term}"`);
  for (const world of worldsOf(bundle)) {
    const names = [...entities(world, "Isps", "Isp").map((isp) => String(isp.cityName)), ...entities(world, "People", "Customer").map((customer) => String(customer.neighborhood)), ...entities(world, "WorkOrders", "WorkOrder").map((order) => String(order.plan))];
    for (const name of new Set(names)) if (!checked.has(name)) errors.push(`${world.name}: "${name}" has no NAMECHECK row`);
  }
  const pending = pendingWebSearches();
  if (pending.length > 0) warnings.push(`NAMECHECK: web search not yet recorded for ${pending.length} term(s): ${pending.join(", ")}`);
  return finding(errors, warnings);
}

function templates(bundle: SeedBundle): string[] {
  const errors: string[] = [];
  const rows = new Map(bundle.tables.Reference.filter((item) => item.entity === "Template").map((item) => [String(item.name), item]));
  const referred = new Set<string>();
  for (const world of worldsOf(bundle)) {
    for (const message of entities(world, "Conversations", "Message")) if (typeof message.templateName === "string") referred.add(message.templateName);
    for (const settings of entities(world, "Isps", "IspSettings")) for (const name of Object.keys((settings.templateStatus as object | undefined) ?? {})) referred.add(name);
  }
  for (const name of referred) if (!rows.has(name)) errors.push(`template ${name} is referred to but not in TEMPLATE#WHATSAPP`);
  for (const [name, row] of rows) {
    const body = String(row.body).trim();
    if (body.startsWith("{{") || body.endsWith("}}")) errors.push(`template ${name} starts or ends with a parameter`);
    for (const button of (row.buttons as string[] | undefined) ?? []) if ([...button].length > 25) errors.push(`template ${name}: button "${button}" over 25 characters`);
    if (containsPhrase(body, DEFAULT_OPERATOR_NAME)) errors.push(`template ${name} names the default operator`);
  }
  return errors;
}

function rateCard(bundle: SeedBundle): string[] {
  return bundle.tables.Reference.filter((item) => item.entity === "RateCard" && item.provisional === false)
    .filter((item) => typeof item.price !== "number" || typeof item.source !== "string" || typeof item.asOf !== "string")
    .map((item) => `RATECARD ${String(item.key)}: a verified rate needs price, source and asOf`);
}

function operatorNotNamed(bundle: SeedBundle): string[] {
  const errors: string[] = [];
  for (const table of SEED_TABLES) {
    for (const item of bundle.tables[table]) {
      if (item.entity === "Isp" && "displayName" in item) errors.push(`${table}: Isp ${String(item.ispId)} carries displayName`);
      if (item.entity === "NameCheck" && item.kind === "OPERATOR_NAME") continue;
      for (const { path, text } of stringsOf(item)) if (containsPhrase(text, DEFAULT_OPERATOR_NAME)) errors.push(`${table} ${String(item.PK)} ${path}: names the default operator`);
    }
  }
  for (const [path, text] of bundle.files) {
    if (path.endsWith(".json") && (path.startsWith("worlds/") || path.startsWith("eval/")) && containsPhrase(text, DEFAULT_OPERATOR_NAME)) errors.push(`${path}: names the default operator`);
  }
  for (const text of [...allPhotoTexts(), ...allVoiceTexts()]) if (containsPhrase(text, DEFAULT_OPERATOR_NAME)) errors.push("a photo or voice text names the default operator");
  return errors;
}

export const CONTENT_INVARIANTS: readonly Invariant[] = [
  { id: 6, title: "Manual: 32 sections with sidecars, unique ids, within budget, §SEG-01 = safetyInstruction", check: (bundle) => finding(manual(bundle)) },
  { id: 7, title: "Evaluation set: 40 A and 10 R, cited sections exist, no phrase of the manual over 8 words", check: (bundle) => finding(questions(bundle)) },
  { id: 11, title: "No forbidden term; every name of the seed has its NAMECHECK row", check: (bundle, env) => namesAndTerms(bundle, env) },
  { id: 12, title: "Templates referred to exist, start and end with fixed text, buttons within 25 characters", check: (bundle) => finding(templates(bundle)) },
  { id: 13, title: "Every verified rate has price, source and date", check: (bundle) => finding(rateCard(bundle)) },
  { id: 24, title: "Nothing of the seed names the operator", check: (bundle) => finding(operatorNotNamed(bundle)) },
];
