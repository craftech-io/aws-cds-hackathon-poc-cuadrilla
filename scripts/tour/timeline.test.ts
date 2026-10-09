// The guided tour over the `guest` template (docs/test-plan.md §3 "Línea de tiempo del recorrido";
// docs/seed-spec.md §3, invariant 19): both tracks of views/tour/steps.ts walked in the in-process world with
// "Saltar a escena" and the scripted agent of the main story. Every clock move of a step lands where the step
// says, on the event it names; every hour of "Qué mirar" is the hour of a pending `TIMER#` of the world (the
// case of step 9 opens at 11:50 and times out at 12:00); and every step is an event of Rogelio's day.
import { beforeAll, describe, expect, it } from "vitest";
import { TOUR_STEPS, TOUR_TRACK_IDS, type TourTrackId, lookText, timeOf, wallTime } from "../../packages/web/src/views/tour/steps";
import { defaultAgent } from "../../tests/flows/support/agent";
import { storyAgent } from "../../tests/flows/support/story";
import { createFlowWorld } from "../../tests/flows/support/world";
import { type StepRun, walkTrack } from "./timeline";

const runs = new Map<TourTrackId, StepRun[]>();

beforeAll(async () => {
  for (const track of TOUR_TRACK_IDS) runs.set(track, await walkTrack(await createFlowWorld({ agent: storyAgent(defaultAgent) }), track));
}, 120_000);

const runsOf = (track: TourTrackId): StepRun[] => runs.get(track) ?? [];
const viewsOnly = (run: StepRun) => run.step.stepId === "1" || run.step.stepId === "13";

describe("tour timeline over the guest template", () => {
  it.each(TOUR_TRACK_IDS)("%s: walks every step of the track, each from its scene", (track) => {
    expect(runsOf(track).map((run) => run.step.stepId)).toEqual(TOUR_STEPS[track].map((step) => step.stepId));
    const failed = runsOf(track).filter((run) => run.error !== undefined);
    expect(failed.map((run) => `${run.step.stepId}: ${run.error}`)).toEqual([]);
  });

  it.each(TOUR_TRACK_IDS)("%s: every clock move lands where the step says, on the timer it names", (track) => {
    for (const run of runsOf(track).filter((candidate) => candidate.step.lands !== undefined)) {
      const lands = run.step.lands;
      expect(Date.parse(run.after.simNow), `${track} ${run.step.stepId}`).toBe(Date.parse(lands?.simNow ?? ""));
      if (lands?.timer !== undefined) expect(run.fired, `${track} ${run.step.stepId}`).toContain(lands.timer);
    }
  });

  it.each(TOUR_TRACK_IDS)("%s: every hour of 'Qué mirar' is the hour of a pending TIMER# of the world", (track) => {
    for (const run of runsOf(track)) {
      for (const [name, time] of Object.entries(run.step.times)) {
        const where = `${track} ${run.step.stepId} {${name}}`;
        const pending = [...run.before.pending, ...run.after.pending].filter((timer) => timer.kind === time.timer);
        expect(pending.map((timer) => wallTime(timer.dueAtSim)), where).toContain(wallTime(time.expectedSim));
        // Before the step the panel shows the step's own hour; at any moment, the hour it shows is a pending timer's.
        if (run.before.pending.some((timer) => timer.kind === time.timer)) expect(timeOf(time, run.before.pending), where).toBe(wallTime(time.expectedSim));
        for (const view of [run.before, run.after]) {
          const shown = timeOf(time, view.pending);
          if (view.pending.some((timer) => timer.kind === time.timer)) expect(view.pending.map((timer) => wallTime(timer.dueAtSim)), where).toContain(shown);
        }
        expect(lookText(run.step, "es", run.after.pending)).not.toContain(`{${name}}`);
      }
    }
  });

  it("FULL: the case of step 9 opens at 11:50 and its timeout is pending at 12:00; step 10 fires it at 12:00", () => {
    const [nine, ten] = ["9", "10"].map((stepId) => runsOf("FULL").find((run) => run.step.stepId === stepId));
    expect(nine?.after.simNow).toBe("2026-10-13T11:50:00-06:00");
    expect(nine?.after.pending.find((timer) => timer.kind === "CASE_TIMEOUT")?.dueAtSim).toBe("2026-10-13T12:00:00-06:00");
    expect(ten?.fired).toEqual(["CASE_TIMEOUT"]);
    expect(ten?.after.simNow).toBe("2026-10-13T12:00:00-06:00");
  });

  it.each(TOUR_TRACK_IDS)("%s: every step but the views is an event of Rogelio's day (invariant 19)", (track) => {
    for (const run of runsOf(track).filter((candidate) => !viewsOnly(candidate))) {
      expect(run.installerMessages, `${track} ${run.step.stepId}`).toBeGreaterThan(0);
      expect(Date.parse(run.after.simNow)).toBeGreaterThanOrEqual(Date.parse("2026-10-13T07:00:00-06:00"));
      expect(Date.parse(run.after.simNow)).toBeLessThanOrEqual(Date.parse("2026-10-13T15:30:00-06:00"));
    }
  });
});
