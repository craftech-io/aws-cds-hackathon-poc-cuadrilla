// `Reference/NAMECHECK` (docs/seed-spec.md §1, §12): every name of an operator, equipment model, city,
// neighborhood and plan the seed uses, and every synthetic phone block, with the check that makes it
// safe and the web searches recorded for it (query, date, what was found; namecheck-searches.ts). A
// term without a recorded search says so (`webSearch: "PENDING"`) and `seed:validate` lists it:
// nothing here claims a search that was not made. The fictitious default operator is read from
// copy/brand.ts, its one source.
import { DEFAULT_OPERATOR_NAME } from "../../../packages/bff/src/copy/brand";
import { LABEL_TEXTS, METER_TEXTS } from "../photos/texts";
import { PHONE_BLOCKS } from "../lib/synthetic";
import type { SeedItem } from "../lib/tables";
import { CITY, NEIGHBORHOODS, PLANS } from "./names";
import { row } from "./context";
import { RECORDED_SEARCHES, type RecordedSearch } from "./namecheck-searches";

export type NameKind = "OPERATOR_NAME" | "SERIAL_PREFIX" | "EQUIPMENT_MODEL" | "CITY" | "NEIGHBORHOOD" | "PLAN" | "PHONE_BLOCK";

export interface NameCheckDef {
  readonly term: string;
  readonly kind: NameKind;
  /** Why the name is synthetic by construction, whatever the web says. */
  readonly basis: string;
  readonly searches: readonly RecordedSearch[];
}

/** Date the construction checks of this generator version were made. */
const CHECKED_ON = "2026-09-26";

const OPERATOR_SEARCHES = (term: string): RecordedSearch[] =>
  [term, `${term} fibra`, `${term} telecom`, `${term} México`].map((query) => ({
    query,
    date: "2026-09-25",
    finding: "No telecommunications company, brand or domain with that name",
    recordedIn: "docs/design-brief.md §9",
  }));

const operatorWord = DEFAULT_OPERATOR_NAME.split(" ")[0] ?? DEFAULT_OPERATOR_NAME;

function searchesOf(term: string): readonly RecordedSearch[] {
  return RECORDED_SEARCHES[term] ?? [];
}

export const NAME_CHECKS: readonly NameCheckDef[] = [
  { term: operatorWord, kind: "OPERATOR_NAME", basis: "Invented word; default of the neutral brand mode in copy/brand.ts, never a text of the seed", searches: OPERATOR_SEARCHES(operatorWord) },
  { term: DEFAULT_OPERATOR_NAME, kind: "OPERATOR_NAME", basis: "Invented operator of the neutral brand mode (copy/brand.ts), labelled fictitious", searches: OPERATOR_SEARCHES(operatorWord).slice(1, 2) },
  { term: "DEMO", kind: "SERIAL_PREFIX", basis: "Generic English word as the prefix of every synthetic ONU serial (DEMO + 8 hex digits), tied to no operator or manufacturer", searches: searchesOf("DEMO") },
  { term: LABEL_TEXTS.model, kind: "EQUIPMENT_MODEL", basis: "Generic model printed on the synthetic ONU labels; no manufacturer", searches: searchesOf(LABEL_TEXTS.model) },
  { term: METER_TEXTS.model, kind: "EQUIPMENT_MODEL", basis: "Generic abbreviation of optical power meter printed on the synthetic meter; no manufacturer", searches: searchesOf(METER_TEXTS.model) },
  { term: CITY, kind: "CITY", basis: "Generic invented city name, labelled fictitious in the console", searches: searchesOf(CITY) },
  ...Object.keys(NEIGHBORHOODS).map((name) => ({ term: name, kind: "NEIGHBORHOOD" as const, basis: "Generic invented neighborhood of the fictitious city, no postal code", searches: searchesOf(name) })),
  ...PLANS.map((plan) => ({ term: plan, kind: "PLAN" as const, basis: "Generic plan name of the fictitious operator; no price is ever attached", searches: searchesOf(plan) })),
  ...Object.values(PHONE_BLOCKS).map((block) => ({
    term: block.label,
    kind: "PHONE_BLOCK" as const,
    basis: "Mexico City number in 55 0000 0000-55 0999 9999, a range where the IFT's published numbering plan assigns no block to any provider; nothing is ever sent to it",
    searches: searchesOf(block.label),
  })),
];

export function nameCheckItems(): SeedItem[] {
  return NAME_CHECKS.map((check) => {
    const latest = check.searches.map((search) => search.date).sort().at(-1);
    return row("NameCheck", {
      term: check.term,
      kind: check.kind,
      checkedAt: latest ?? CHECKED_ON,
      result: "CLEAR",
      basis: check.basis,
      searches: check.searches.map((search) => ({ ...search })),
      webSearch: check.searches.length > 0 ? "RECORDED" : "PENDING",
    });
  });
}

/** Terms whose web search is still to be made and recorded here. */
export function pendingWebSearches(): string[] {
  return NAME_CHECKS.filter((check) => check.searches.length === 0).map((check) => check.term);
}

/** Recorded searches of a term the seed no longer uses (a name renamed without moving its record). */
export function orphanSearches(): string[] {
  const terms = new Set(NAME_CHECKS.map((check) => check.term));
  return Object.keys(RECORDED_SEARCHES).filter((term) => !terms.has(term));
}
