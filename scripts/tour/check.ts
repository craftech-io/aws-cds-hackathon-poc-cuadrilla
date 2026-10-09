// Keeps the guided tour in one source (docs/design-brief.md §15, docs/architecture.md §18):
// packages/web/src/views/tour/steps.ts says what each step is; this check makes every other reader
// follow it.
//
//   1. The steps are consistent: unique ids, every "Qué mirar" placeholder declared (and every declared
//      time used) in both languages, every hour inside the tour window, every scene a scene of the tour.
//   2. The buttons of the BFF (`TOURS` of packages/bff/src/routers/tour.ts, what `tour.run` executes)
//      have the same steps, in the same order, with the same scene and wait; a step that moves the clock
//      to an hour names it in both languages and declares where it lands, and "Iniciar el día" and
//      "Avanzar al próximo evento" declare the timer they land on.
//   3. The scenes are the ones of the `guest` template (scripts/seed/data/worlds/guest.json): same ids,
//      titles and instants, each one preparing exactly the steps that name it.
//   4. The README's "Guided tour" between <!-- TOUR:START --> and <!-- TOUR:END --> is exactly the one
//      rendered here, in English (`--write` rewrites the block; the markers are the README author's).
//   5. SC-18 (scripts/scenarios/sc-18-*.ts) imports the steps module and walks `TOUR_STEPS` (or names
//      every step id), so it cannot follow another list.
//
// A README without the markers or an SC-18 not written yet is reported as pending (they arrive in later
// work packages); `--strict` fails on it.
//
//   npm run tour:check [-- --write] [-- --strict]
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TOURS, type TourPart, type TourStep as BffStep } from "../../packages/bff/src/routers/tour";
import {
  TOUR_SCENES,
  TOUR_STEPS,
  TOUR_TRACKS,
  TOUR_TRACK_IDS,
  TOUR_WINDOW,
  type TourScene,
  type TourStep,
  type TourTrackId,
  allSteps,
  lookText,
  placeholdersOf,
  wallTime,
} from "../../packages/web/src/views/tour/steps";

export const README_FILE = "README.md";
export const TOUR_START = "<!-- TOUR:START -->";
export const TOUR_END = "<!-- TOUR:END -->";
export const SCENARIOS_DIR = "scripts/scenarios";
export const SC18_PREFIX = "sc-18-";
export const GUEST_TEMPLATE = "scripts/seed/data/worlds/guest.json";

type Steps = Readonly<Record<TourTrackId, readonly TourStep[]>>;
type BffTours = Readonly<Record<TourTrackId, readonly BffStep[]>>;

function inWindow(instant: string): boolean {
  const at = Date.parse(instant);
  return at >= Date.parse(TOUR_WINDOW.startSim) && at <= Date.parse(TOUR_WINDOW.endSim);
}

/** Problems of the steps themselves; empty when they are consistent. */
export function validateSteps(steps: Steps = TOUR_STEPS, scenes: readonly TourScene[] = TOUR_SCENES): string[] {
  const errors: string[] = [];
  const sceneIds = new Set(scenes.map((scene) => scene.sceneId));
  for (const track of TOUR_TRACK_IDS) {
    const ids = steps[track].map((step) => step.stepId);
    if (new Set(ids).size !== ids.length) errors.push(`${track}: repeated step ids (${ids.join(", ")})`);
    for (const step of steps[track]) {
      const where = `${track} ${step.stepId}`;
      const declared = Object.keys(step.times).sort();
      for (const lang of ["es", "en"] as const) {
        const used = [...new Set(placeholdersOf(step.look[lang]))].sort();
        if (used.join(",") !== declared.join(",")) errors.push(`${where}: "${lang}" uses {${used.join(", ")}} but declares {${declared.join(", ")}}`);
        for (const field of [step.title, step.action, step.wait]) if (field[lang].trim() === "") errors.push(`${where}: an empty "${lang}" text`);
      }
      for (const [name, time] of Object.entries(step.times)) if (!inWindow(time.expectedSim)) errors.push(`${where}: {${name}} ${time.expectedSim} is outside the tour window`);
      if (step.lands !== undefined && !inWindow(step.lands.simNow)) errors.push(`${where}: lands at ${step.lands.simNow}, outside the tour window`);
      if (step.sceneId !== null && !sceneIds.has(step.sceneId)) errors.push(`${where}: unknown scene ${step.sceneId}`);
      if (step.waitSec < 0) errors.push(`${where}: negative wait`);
    }
  }
  return errors;
}

function clockPart(part: TourPart): { readonly to?: string; readonly move?: "START_DAY" | "NEXT" } | undefined {
  if (part.kind === "CLOCK_TO") return { to: part.time };
  if (part.kind === "CLOCK") return { move: part.move };
  return undefined;
}

/** The steps against the BFF's buttons: same ids, order, scenes and waits; clock moves declared. */
export function compareWithBff(steps: Steps = TOUR_STEPS, tours: BffTours = TOURS): string[] {
  const errors: string[] = [];
  for (const track of TOUR_TRACK_IDS) {
    const web = steps[track];
    const bff = tours[track];
    const webIds = web.map((step) => step.stepId).join(", ");
    const bffIds = bff.map((step) => step.stepId).join(", ");
    if (webIds !== bffIds) {
      errors.push(`${track}: steps.ts has ${webIds}; the BFF's TOURS has ${bffIds}`);
      continue;
    }
    web.forEach((step, index) => {
      const button = bff[index] as BffStep;
      const where = `${track} ${step.stepId}`;
      if (step.sceneId !== button.sceneId) errors.push(`${where}: scene ${step.sceneId ?? "none"} here, ${button.sceneId ?? "none"} in the BFF`);
      if (step.waitSec !== button.waitSec) errors.push(`${where}: waits ${step.waitSec} s here, ${button.waitSec} s in the BFF`);
      const moves = button.parts.map(clockPart).filter((move) => move !== undefined);
      if (moves.length === 0 && step.lands !== undefined) errors.push(`${where}: declares where the clock lands but its button does not move the clock`);
      for (const move of moves) {
        if (step.lands === undefined) {
          errors.push(`${where}: its button moves the clock but the step does not declare where it lands`);
          continue;
        }
        if (move.to !== undefined) {
          if (wallTime(step.lands.simNow) !== move.to) errors.push(`${where}: the button goes to ${move.to}, the step lands at ${wallTime(step.lands.simNow)}`);
          for (const lang of ["es", "en"] as const) if (!step.action[lang].includes(move.to)) errors.push(`${where}: the "${lang}" button text does not name ${move.to}`);
        } else if (step.lands.timer === undefined) {
          errors.push(`${where}: "${move.move}" lands on a timer the step does not name`);
        }
      }
    });
  }
  return errors;
}

const TemplateScene = (value: unknown): value is { sceneId: string; title: { es: string; en: string }; advanceToSim: string; steps: { express: string[]; full: string[] } } =>
  typeof value === "object" && value !== null && typeof (value as { sceneId?: unknown }).sceneId === "string";

/** The scenes against the `guest` template's: ids, titles, instants and the steps each one prepares. */
export function compareWithTemplate(template: unknown, steps: Steps = TOUR_STEPS, scenes: readonly TourScene[] = TOUR_SCENES): string[] {
  const list = typeof template === "object" && template !== null ? (template as { scenes?: unknown }).scenes : undefined;
  if (!Array.isArray(list)) return [`${GUEST_TEMPLATE}: no scenes`];
  const found = list.filter(TemplateScene);
  const errors: string[] = [];
  const ids = (rows: ReadonlyArray<{ sceneId: string }>) => rows.map((row) => row.sceneId).join(", ");
  if (ids(found) !== ids(scenes)) return [`scenes are ${ids(scenes)} here and ${ids(found)} in the guest template`];
  scenes.forEach((scene, index) => {
    const seeded = found[index];
    if (seeded === undefined) return;
    if (seeded.title.es !== scene.title.es || seeded.title.en !== scene.title.en) errors.push(`${scene.sceneId}: its title differs from the guest template`);
    if (Date.parse(seeded.advanceToSim) !== Date.parse(scene.atSim)) errors.push(`${scene.sceneId}: at ${scene.atSim} here, ${seeded.advanceToSim} in the guest template`);
    const prepares = (track: TourTrackId) =>
      steps[track]
        .filter((step) => step.sceneId === scene.sceneId)
        .map((step) => step.stepId)
        .join(",");
    if (prepares("EXPRESS") !== seeded.steps.express.join(",") || prepares("FULL") !== seeded.steps.full.join(",")) errors.push(`${scene.sceneId}: prepares other steps than in the guest template`);
  });
  return errors;
}

const HEADER = ["| # | Step | Button / action | What to look at | Expected wait |", "|---|---|---|---|---|"];

function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function actionText(step: TourStep): string {
  const scene = step.sceneId === null ? undefined : TOUR_SCENES.find((candidate) => candidate.sceneId === step.sceneId);
  return scene === undefined ? step.action.en : `${step.action.en} (or “Jump to scene”: ${scene.title.en})`;
}

/** The README section, in English, with the expected hours: one table per track. */
export function renderReadmeSection(steps: Steps = TOUR_STEPS): string {
  const blocks = TOUR_TRACK_IDS.map((track) => {
    const rows = steps[track].map((step) => `| ${step.stepId} | ${cell(step.title.en)} | ${cell(actionText(step))} | ${cell(lookText(step, "en"))} | ${cell(step.wait.en)} |`);
    return [`### ${TOUR_TRACKS[track].title.en} (~${TOUR_TRACKS[track].minutes} min)`, "", ...HEADER, ...rows].join("\n");
  });
  return blocks.join("\n\n");
}

/** The block between the README markers; undefined when the markers are not there. */
export function readmeBlock(readme: string): string | undefined {
  const start = readme.indexOf(TOUR_START);
  const end = readme.indexOf(TOUR_END);
  if (start === -1 || end === -1 || end < start) return undefined;
  return readme.slice(start + TOUR_START.length, end).trim();
}

export function withReadmeBlock(readme: string, section: string): string {
  const start = readme.indexOf(TOUR_START);
  const end = readme.indexOf(TOUR_END);
  if (start === -1 || end === -1 || end < start) return readme;
  return `${readme.slice(0, start + TOUR_START.length)}\n${section}\n${readme.slice(end)}`;
}

export type Verdict = { readonly status: "ok" } | { readonly status: "pending"; readonly why: string } | { readonly status: "error"; readonly errors: readonly string[] };

export function checkReadme(readme: string | undefined, section: string = renderReadmeSection()): Verdict {
  if (readme === undefined) return { status: "pending", why: `${README_FILE} does not exist` };
  const block = readmeBlock(readme);
  if (block === undefined) return { status: "pending", why: `${README_FILE} has no ${TOUR_START} … ${TOUR_END} block yet` };
  if (block === section) return { status: "ok" };
  const want = section.split("\n");
  const have = block.split("\n");
  const errors = [`${README_FILE}: the guided tour differs from views/tour/steps.ts (run \`npm run tour:check -- --write\`):`];
  for (let line = 0; line < Math.max(want.length, have.length); line += 1) {
    if (want[line] !== have[line]) errors.push(`  line ${line + 1}: expected ${want[line] ?? "(nothing)"} / found ${have[line] ?? "(nothing)"}`);
  }
  return { status: "error", errors: errors.slice(0, 12) };
}

const STEPS_IMPORT = /from\s+["'][^"']*packages\/web\/src\/views\/tour\/steps(?:\.ts)?["']/;

/** SC-18 takes its steps from steps.ts: it imports the module and walks `TOUR_STEPS` or names every step. */
export function checkScenario(fileName: string | undefined, source: string | undefined): Verdict {
  if (fileName === undefined || source === undefined) return { status: "pending", why: `${SCENARIOS_DIR}/${SC18_PREFIX}*.ts is not in the repository yet` };
  const errors: string[] = [];
  if (!STEPS_IMPORT.test(source)) errors.push(`${fileName}: does not import packages/web/src/views/tour/steps`);
  const walksAll = /\bTOUR_STEPS\b/.test(source);
  const missing = allSteps()
    .map(({ step }) => step.stepId)
    .filter((id) => !source.includes(`"${id}"`) && !source.includes(`'${id}'`));
  if (!walksAll && missing.length > 0) errors.push(`${fileName}: neither walks TOUR_STEPS nor names the steps ${missing.join(", ")}`);
  return errors.length === 0 ? { status: "ok" } : { status: "error", errors };
}

function scenarioFile(cwd: string): { name: string; source: string } | undefined {
  const dir = join(cwd, SCENARIOS_DIR);
  if (!existsSync(dir)) return undefined;
  const name = readdirSync(dir).find((entry) => entry.startsWith(SC18_PREFIX) && entry.endsWith(".ts") && !entry.endsWith(".test.ts"));
  return name === undefined ? undefined : { name: `${SCENARIOS_DIR}/${name}`, source: readFileSync(join(dir, name), "utf8") };
}

function main(): void {
  const cwd = process.cwd();
  const write = process.argv.includes("--write");
  const strict = process.argv.includes("--strict");
  const template = JSON.parse(readFileSync(join(cwd, GUEST_TEMPLATE), "utf8")) as unknown;
  const errors = [...validateSteps(), ...compareWithBff(), ...compareWithTemplate(template)].map((error) => `views/tour/steps.ts: ${error}`);
  const pending: string[] = [];
  const readmePath = join(cwd, README_FILE);
  const section = renderReadmeSection();
  let readme = existsSync(readmePath) ? readFileSync(readmePath, "utf8") : undefined;
  if (write && readme !== undefined && readmeBlock(readme) !== undefined && readmeBlock(readme) !== section) {
    readme = withReadmeBlock(readme, section);
    writeFileSync(readmePath, readme);
    console.log(`tour:check: rewrote the guided tour of ${README_FILE}.`);
  }
  const scenario = scenarioFile(cwd);
  for (const verdict of [checkReadme(readme, section), checkScenario(scenario?.name, scenario?.source)]) {
    if (verdict.status === "error") errors.push(...verdict.errors);
    if (verdict.status === "pending") pending.push(verdict.why);
  }
  if (strict) errors.push(...pending.map((why) => `pending: ${why}`));
  if (errors.length > 0) {
    console.error(`tour:check: ${errors.length} problem(s):`);
    for (const error of errors) console.error(`  ${error}`);
    process.exit(1);
  }
  const note = pending.length > 0 ? `; pending: ${pending.join("; ")}` : "";
  console.log(`tour:check: ${allSteps().length} step(s) consistent${note}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
