// One invariant of docs/seed-spec.md §14 as `seed:validate` runs it: an id, a title and a check over
// the bundle that returns errors (the seed is wrong) and warnings (something to know, not a failure).
import type { SeedBundle } from "./bundle";

export interface CheckEnv {
  /** The external list of forbidden terms (`FORBIDDEN_TERMS`), never printed. */
  readonly forbiddenTerms?: string;
  /** `CI=true`: an absent list fails the forbidden-terms invariant instead of skipping it. */
  readonly ci: boolean;
}

export interface Finding {
  readonly errors: string[];
  readonly warnings: string[];
}

export interface Invariant {
  readonly id: number;
  readonly title: string;
  /** Checks that need the committed media of WP-18 or the environment, not only the data files. */
  check(bundle: SeedBundle, env: CheckEnv): Finding | Promise<Finding>;
}

export function finding(errors: string[] = [], warnings: string[] = []): Finding {
  return { errors, warnings };
}

/** Values that appear more than once, each reported once. */
export function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated];
}

/** The id of a person or customer without the placeholder judge tag (`inst-rogelio-j00` → `inst-rogelio`). */
export function baseId(id: string): string {
  return id.replace(/-j00$/, "");
}
