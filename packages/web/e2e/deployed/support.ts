// Shared helpers of the deployed verification (docs/test-plan.md §6.1): the project's language and
// viewport, the screenshots of the run (outside the repository), the neutral-words check over what a
// page shows, the QA addresses of the run and the operator's scripts the sign-up specs call.
import { type Page, type TestInfo, expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { findNeutralTerms } from "../../../../scripts/lint/neutral-terms";

export type Lang = "es" | "en";

export interface ProjectContext {
  readonly name: string;
  readonly lang: Lang;
  /** `?lang=` value the pages take. */
  readonly param: "es-MX" | "en";
  readonly reduced: boolean;
  readonly desktop: boolean;
}

export function projectContext(info: TestInfo = test.info()): ProjectContext {
  const use = info.project.use;
  const lang: Lang = use.locale?.startsWith("en") ? "en" : "es";
  return { name: info.project.name, lang, param: lang === "en" ? "en" : "es-MX", reduced: use.reducedMotion === "reduce", desktop: (use.viewport?.width ?? 0) >= 1024 };
}

/** Where the screenshots of this run go: QA_SHOTS_DIR, or a folder of the system's temp dir. Never the repo. */
export const SHOTS_DIR = resolve(process.env.QA_SHOTS_DIR ?? join(tmpdir(), "cuadrilla-qa-deployed", "shots"));

/** A screenshot named `<project>/<name>.png`; `element` narrows it to one block of the page. */
export async function shot(page: Page, name: string, options: { readonly fullPage?: boolean; readonly selector?: string } = {}): Promise<string> {
  const dir = join(SHOTS_DIR, projectContext().name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.png`);
  if (options.selector !== undefined) await page.locator(options.selector).first().screenshot({ path, animations: "disabled" });
  else await page.screenshot({ path, fullPage: options.fullPage ?? false, animations: "disabled" });
  return path;
}

export async function noHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "no horizontal scroll").toBeLessThanOrEqual(0);
}

/** No word of ADR-0023 in what the page shows nor in its markup. */
export async function expectNeutral(page: Page, label: string): Promise<void> {
  expect(findNeutralTerms(`${label} (visible text)`, await page.locator("body").innerText())).toEqual([]);
  expect(findNeutralTerms(`${label} (markup)`, await page.content())).toEqual([]);
}

/** The run's tag: QA_RUN (lower-case letters, digits and hyphens), shared by every address of the run. */
export function runTag(): string {
  const tag = (process.env.QA_RUN ?? "").toLowerCase();
  if (!/^[a-z0-9-]{1,40}$/.test(tag)) throw new Error("QA_RUN must be set (a-z, 0-9, -; at most 40) for the sign-up phases");
  return tag;
}

/** `success+qa-<run>-<n>@simulator.amazonses.com`: the only addresses the QA seam confirms. */
export function qaAddress(suffix: string): string {
  return `success+qa-${runTag()}-${suffix}@simulator.amazonses.com`;
}

/** A password of the pool's policy, new for each account; it lives only in the run's memory. */
export function newPassword(): string {
  const random = crypto.getRandomValues(new Uint8Array(12));
  return `Qa-${Buffer.from(random).toString("base64url")}!7x`;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** Runs an operator's npm script of the repository with the environment's AWS profile; returns stdout. */
export async function operatorScript(script: string, args: readonly string[], stdin?: string): Promise<string> {
  if (!process.env.AWS_PROFILE) throw new Error(`AWS_PROFILE must name the stage's account to run ${script}`);
  const child = promisify(execFile)("npm", ["run", "-s", script, "--", ...args], { cwd: REPO_ROOT, timeout: 5 * 60_000, maxBuffer: 16 * 1024 * 1024 });
  child.child.stdin?.end(stdin ?? "");
  const { stdout } = await child;
  return stdout;
}

/** The phases of §6.1, in their order; each runs with its tag and only in its projects. */
export const PHASES = {
  evidence: { tag: "@evidence", projects: ["desktop-1440-es"] },
  full: { tag: "@full", projects: ["mobile-390-es", "mobile-390-en-reduced-motion", "desktop-1440-en", "desktop-1440-es-reduced-motion"] },
  abuse: { tag: "@abuse", projects: ["desktop-1440-es"] },
} as const;

export function onlyIn(phase: keyof typeof PHASES): void {
  test.skip(!(PHASES[phase].projects as readonly string[]).includes(projectContext().name), `${phase} runs only in ${PHASES[phase].projects.join(", ")}`);
}
