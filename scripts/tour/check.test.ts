import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TOURS } from "../../packages/bff/src/routers/tour";
import { TOUR_STEPS, type TourStep, type TourTrackId, lookText, timeOf } from "../../packages/web/src/views/tour/steps";
import { GUEST_TEMPLATE, TOUR_END, TOUR_START, checkReadme, checkScenario, compareWithBff, compareWithTemplate, readmeBlock, renderReadmeSection, validateSteps, withReadmeBlock } from "./check";

const template = JSON.parse(readFileSync(join(import.meta.dirname, "../..", GUEST_TEMPLATE), "utf8")) as { scenes: Array<Record<string, unknown>> };

function changed(track: TourTrackId, stepId: string, change: (step: TourStep) => TourStep) {
  return { ...TOUR_STEPS, [track]: TOUR_STEPS[track].map((step) => (step.stepId === stepId ? change(step) : step)) };
}

describe("tour:check — the steps of views/tour/steps.ts [FL-084]", () => {
  it("are consistent, match the BFF's buttons and the guest template's scenes", () => {
    expect(validateSteps()).toEqual([]);
    expect(compareWithBff()).toEqual([]);
    expect(compareWithTemplate(template)).toEqual([]);
  });

  it("fail when a placeholder of 'Qué mirar' is not declared in one language, or a time falls outside the window", () => {
    const undeclared = changed("FULL", "9", (step) => ({ ...step, look: { ...step.look, en: `${step.look.en} {other}` } }));
    expect(validateSteps(undeclared)).toContainEqual(expect.stringContaining('FULL 9: "en" uses {caseTimeout, other}'));
    const late = changed("FULL", "9", (step) => ({ ...step, times: { caseTimeout: { timer: "CASE_TIMEOUT", expectedSim: "2026-10-13T18:00:00-06:00" } } }));
    expect(validateSteps(late)).toContainEqual(expect.stringContaining("outside the tour window"));
    const unknownScene = changed("EXPRESS", "X1", (step) => ({ ...step, sceneId: "otra-escena" }));
    expect(validateSteps(unknownScene)).toContainEqual(expect.stringContaining("unknown scene otra-escena"));
  });

  it("fail when the steps, scenes or waits drift from the BFF, or a clock move is not declared", () => {
    const reordered = { ...TOUR_STEPS, EXPRESS: [...TOUR_STEPS.EXPRESS].reverse() };
    expect(compareWithBff(reordered)).toContainEqual(expect.stringContaining("EXPRESS: steps.ts has X4, X3, X2, X1"));
    const slower = changed("EXPRESS", "X3", (step) => ({ ...step, waitSec: 90 }));
    expect(compareWithBff(slower)).toContainEqual("EXPRESS X3: waits 90 s here, 60 s in the BFF");
    const unnamed = changed("FULL", "4", (step) => ({ ...step, action: { es: "Ir a la primera visita", en: "Go to the first visit" } }));
    expect(compareWithBff(unnamed)).toEqual([expect.stringContaining('"es" button text does not name 09:20'), expect.stringContaining('"en" button text does not name 09:20')]);
    const { lands: _lands, ...rest } = TOUR_STEPS.FULL.find((step) => step.stepId === "10") as TourStep;
    const silent = changed("FULL", "10", () => rest);
    expect(compareWithBff(silent)).toContainEqual(expect.stringContaining("FULL 10: its button moves the clock"));
    const otherScene = { ...TOURS, FULL: TOURS.FULL.map((step) => (step.stepId === "8" ? { ...step, sceneId: "evidencia" } : step)) };
    expect(compareWithBff(TOUR_STEPS, otherScene)).toContainEqual("FULL 8: scene checklist-completo here, evidencia in the BFF");
  });

  it("fail when a scene's title or the steps it prepares differ from the guest template", () => {
    const retitled = { scenes: template.scenes.map((scene) => (scene.sceneId === "evidencia" ? { ...scene, title: { es: "Fotos", en: "Photos" } } : scene)) };
    expect(compareWithTemplate(retitled)).toContainEqual("evidencia: its title differs from the guest template");
    const moved = changed("FULL", "7", (step) => ({ ...step, sceneId: "onu-en-linea" }));
    expect(compareWithTemplate(template, moved)).toEqual(expect.arrayContaining(["onu-en-linea: prepares other steps than in the guest template", "evidencia: prepares other steps than in the guest template"]));
    expect(compareWithTemplate({})).toEqual([`${GUEST_TEMPLATE}: no scenes`]);
  });
});

describe("tour:check — 'Qué mirar' hours [FL-084]", () => {
  const step9 = TOUR_STEPS.FULL.find((step) => step.stepId === "9") as TourStep;

  it("show the expected hour while no timer of its kind is pending, and the earliest pending one otherwise", () => {
    expect(lookText(step9, "es")).toContain("vence a las 12:00");
    const pending = [
      { kind: "CASE_TIMEOUT", dueAtSim: "2026-10-13T12:20:00-06:00" },
      { kind: "DAY_START", dueAtSim: "2026-10-14T07:30:00-06:00" },
      { kind: "CASE_TIMEOUT", dueAtSim: "2026-10-13T12:05:00-06:00" },
    ];
    expect(lookText(step9, "en", pending)).toContain("times out at 12:05");
    expect(timeOf({ timer: "DAY_START", expectedSim: "2026-10-13T07:30:00-06:00" }, pending)).toBe("07:30");
  });
});

describe("tour:check — the README's guided tour", () => {
  const section = renderReadmeSection();

  it("renders both tracks in English, one row per step, with the expected hours and no placeholder left", () => {
    const rows = section.split("\n").filter((line) => /^\| (X?\d+) \|/.test(line));
    expect(rows).toHaveLength(TOUR_STEPS.EXPRESS.length + TOUR_STEPS.FULL.length);
    expect(section).toContain("### Express tour (~5 min)");
    expect(section).toContain("### Full tour (~15 min)");
    expect(section).toContain("| 9 | Escalation | Go to the second visit (11:50) and send three low-power voice notes (or “Jump to scene”: Second visit (11:50)) |");
    expect(section).toContain("that times out at 12:00");
    expect(section).not.toMatch(/\{[a-zA-Z]+\}/);
  });

  it("matches when the README carries the same block, says what differs otherwise, and --write fills the block", () => {
    const readme = `# Cuadrilla\n\n## Guided tour\n\n${TOUR_START}\n${section}\n${TOUR_END}\n`;
    expect(readmeBlock(readme)).toBe(section);
    expect(checkReadme(readme, section)).toEqual({ status: "ok" });
    const verdict = checkReadme(readme.replace("at 12:00", "at 12:30"), section);
    expect(verdict.status).toBe("error");
    expect(checkReadme("# Cuadrilla\n", section)).toMatchObject({ status: "pending" });
    expect(checkReadme(undefined, section)).toMatchObject({ status: "pending" });
    const written = withReadmeBlock(`intro\n${TOUR_START}\nold\n${TOUR_END}\noutro\n`, section);
    expect(readmeBlock(written)).toBe(section);
    expect(written.endsWith(`${TOUR_END}\noutro\n`)).toBe(true);
    expect(withReadmeBlock("no markers", section)).toBe("no markers");
  });
});

describe("tour:check — SC-18", () => {
  const importLine = 'import { TOUR_STEPS } from "../../packages/web/src/views/tour/steps";';

  it("passes when it imports the steps and walks TOUR_STEPS, or names every step", () => {
    expect(checkScenario("scripts/scenarios/sc-18-guest-tour.ts", `${importLine}\nfor (const step of TOUR_STEPS.FULL) run(step);`)).toEqual({ status: "ok" });
    const ids = [...TOUR_STEPS.EXPRESS, ...TOUR_STEPS.FULL].map((step) => `step("${step.stepId}");`).join("\n");
    expect(checkScenario("scripts/scenarios/sc-18-guest-tour.ts", `import { lookText } from "../../packages/web/src/views/tour/steps.ts";\n${ids}`)).toEqual({ status: "ok" });
  });

  it("fails when it keeps its own list, and is pending while it does not exist", () => {
    const verdict = checkScenario("scripts/scenarios/sc-18-guest-tour.ts", 'const steps = ["1", "2"];');
    expect(verdict.status).toBe("error");
    expect(verdict.status === "error" && verdict.errors.join("\n")).toMatch(/does not import[\s\S]*names the steps X1/);
    expect(checkScenario(undefined, undefined)).toMatchObject({ status: "pending" });
  });
});
