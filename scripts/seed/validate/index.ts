// The invariants of docs/seed-spec.md §14 in order. `seed:validate` runs them on the committed files,
// the generator on the files it is about to write. Invariant 10 (no seeded message breaks the policy)
// runs the real policy in `scripts/seed/__tests__/invariants.test.ts`, and invariant 16's reload
// assertions live in the loader's `load.test.ts` (WP-39); here 16 checks that no item carries an epoch.
import type { SeedBundle } from "./bundle";
import { CONTENT_INVARIANTS } from "./content";
import { FILE_INVARIANTS } from "./files";
import { IDENTITY_INVARIANTS } from "./identity";
import { MEDIA_INVARIANTS } from "./media";
import type { CheckEnv, Invariant } from "./types";
import { WORLD_INVARIANTS } from "./worlds";

export const INVARIANTS: readonly Invariant[] = [...WORLD_INVARIANTS, ...IDENTITY_INVARIANTS, ...MEDIA_INVARIANTS, ...CONTENT_INVARIANTS, ...FILE_INVARIANTS].sort((a, b) => a.id - b.id);

/** Invariants the manifest cannot vouch for when the generator writes it: its own checksums. */
export const MANIFEST_INVARIANT = 15;

export interface InvariantResult {
  readonly id: number;
  readonly title: string;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

export function envFromProcess(env: NodeJS.ProcessEnv = process.env): CheckEnv {
  return { ci: env.CI === "true", ...(env.FORBIDDEN_TERMS === undefined ? {} : { forbiddenTerms: env.FORBIDDEN_TERMS }) };
}

export async function runInvariants(bundle: SeedBundle, env: CheckEnv, options: { readonly skip?: readonly number[] } = {}): Promise<InvariantResult[]> {
  const results: InvariantResult[] = [];
  if (bundle.problems.length > 0) results.push({ id: 0, title: "Every file present and valid by its schema", errors: [...bundle.problems], warnings: [] });
  for (const invariant of INVARIANTS) {
    if (options.skip?.includes(invariant.id)) continue;
    try {
      const { errors, warnings } = await invariant.check(bundle, env);
      results.push({ id: invariant.id, title: invariant.title, errors, warnings });
    } catch (error) {
      results.push({ id: invariant.id, title: invariant.title, errors: [`the check could not run: ${(error as Error).message}`], warnings: [] });
    }
  }
  return results;
}

export function failed(results: readonly InvariantResult[]): InvariantResult[] {
  return results.filter((result) => result.errors.length > 0);
}

/** A human report: one line per invariant, then its errors and warnings. */
export function report(results: readonly InvariantResult[]): string {
  const lines: string[] = [];
  for (const result of results) {
    lines.push(`${result.errors.length === 0 ? "ok  " : "FAIL"} ${String(result.id).padStart(2, " ")} ${result.title}`);
    for (const error of result.errors.slice(0, 20)) lines.push(`       ${error}`);
    if (result.errors.length > 20) lines.push(`       … and ${result.errors.length - 20} more`);
    for (const warning of result.warnings) lines.push(`       warning: ${warning}`);
  }
  return lines.join("\n");
}
