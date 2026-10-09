// The guided tour's timeline (docs/design-brief.md §15, docs/test-plan.md §3 "Línea de tiempo del
// recorrido"): the steps of both tracks of packages/web/src/views/tour/steps.ts walked over the `guest`
// template in the in-process world of the local flows (tests/flows/support/world.ts), the way a guest
// walks them in the console: "Saltar a escena" to the step's scene (`clock.jumpToScene`), each part of the
// step's button in turn (`tour.run` with `part`, the same procedures the simulator and the clock use) and the
// world settling after each one, as the panel waits for the world between parts (views/tour/use-tour-step.ts),
// with the scripted agent of the main story (tests/flows/support/story.ts) answering the turns.
//
// For each step it records what the panel would show before and after (`tour.steps`: the world's simulated
// now and its pending timers, the ones "Qué mirar" reads), the timers the step's clock moves fired and the
// messages the step left in the guest world, so timeline.test.ts can check that every clock move lands on
// the step's event and every hour of "Qué mirar" is the hour of a pending `TIMER#`.
import type { TimerKind } from "@cuadrilla/shared";
import { TOUR_STEPS, type PendingTimer, type TourStep, type TourTrackId } from "../../packages/web/src/views/tour/steps";
import { consoleOf } from "../../tests/flows/support/console";
import type { FlowWorld } from "../../tests/flows/support/world";

/** The rehearsal guest world (`GUEST#isp-guest-test`), the one the `QaDriver`'s `GUEST` principal may act on. */
export const TOUR_CLOCK = "GUEST#isp-guest-test";
/** Rogelio in that world: every step of the tour is an event of his day (invariant 19). */
export const TOUR_INSTALLER = "inst-rogelio-gtest";

export interface PanelView {
  /** The world's simulated now, with its offset (`2026-10-13T09:20:00-06:00`). */
  readonly simNow: string;
  readonly pending: readonly PendingTimer[];
}

export interface StepRun {
  readonly track: TourTrackId;
  readonly step: TourStep;
  readonly before: PanelView;
  readonly after: PanelView;
  /** Kinds of the timers the step's clock moves fired, in order. */
  readonly fired: readonly TimerKind[];
  /** Messages the step left in the guest world (every person's thread). */
  readonly messages: number;
  /** Of those, the ones in Rogelio's thread. */
  readonly installerMessages: number;
  /** Why the step's button failed, if it did. */
  readonly error?: string;
}

function messagesOf(world: FlowWorld, personId?: string): number {
  return world.memory.client.dump("Conversations").filter((row) => row.entity === "Message" && row.clockId === TOUR_CLOCK && (personId === undefined || row.personId === personId)).length;
}

function firedOf(results: ReadonlyArray<{ readonly kind: string; readonly result: unknown }>): TimerKind[] {
  return results.flatMap((part) => (part.kind === "CLOCK" || part.kind === "CLOCK_TO" ? ((part.result as { fired?: Array<{ kind: TimerKind }> }).fired ?? []).map((fired) => fired.kind) : []));
}

/** Walks one track, each step from its own scene (when it has one), and answers what each step did. */
export async function walkTrack(world: FlowWorld, track: TourTrackId): Promise<StepRun[]> {
  const guest = consoleOf(world, "GUEST", TOUR_CLOCK);
  const panel = async (): Promise<PanelView> => {
    const view = await guest.tour.steps({ track });
    return { simNow: view.simNow, pending: view.upcoming.map((timer) => ({ kind: timer.kind, dueAtSim: timer.dueAtSim })) };
  };
  const runs: StepRun[] = [];
  for (const step of TOUR_STEPS[track]) {
    if (step.sceneId !== null) {
      await guest.clock.jumpToScene({ sceneId: step.sceneId });
      await world.settle();
    }
    const before = await panel();
    const messages = messagesOf(world);
    const installerMessages = messagesOf(world, TOUR_INSTALLER);
    let fired: TimerKind[] = [];
    let error: string | undefined;
    const { parts } = (await guest.tour.steps({ track })).steps.find((candidate) => candidate.stepId === step.stepId) ?? { parts: [] };
    for (const part of parts) {
      try {
        const ran = await guest.tour.run({ track, stepId: step.stepId, part: part.index });
        fired = [...fired, ...firedOf(ran.results)];
      } catch (caught) {
        error = `part ${part.index} (${part.kind}): ${caught instanceof Error ? caught.message : String(caught)}`;
        break;
      } finally {
        await world.settle();
      }
    }
    runs.push({ track, step, before, after: await panel(), fired, messages: messagesOf(world) - messages, installerMessages: messagesOf(world, TOUR_INSTALLER) - installerMessages, ...(error === undefined ? {} : { error }) });
  }
  return runs;
}
