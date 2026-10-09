// `tour` router of the console (docs/tool-catalog.md; docs/design-brief.md §15): the guided tours of the
// principal's world, express (~5 min) and full (~15 min).
//
//   steps   the steps of a track with the scene each one can jump to ("Saltar a escena", the scene of
//           the `guest` template whose `steps` name it), the parts of its button, the wait each one
//           expects and the tour's estimate; "Qué mirar" comes with the world's pending timers (the
//           same ones `clock.get` reads), so a time shown is a time that will fire
//   run     the button of a step (or one part of it) through the same procedures the simulator and the
//           clock use: a quick message of the main story, a tap, a voice note, a clock move. It never
//           jumps: the scene is `clock.jumpToScene`, a separate button with its own limit
//
// The steps are data: their texts live in the web (`views/tour/steps.ts`, the one source of what the
// panel and the README say), which names these ids; scripts/tour/check.ts compares both.
import { z } from "zod";
import { ToolError, type WaButtonAction } from "@cuadrilla/shared";
import { buttonText } from "../story/render";
import { zonedInstant } from "../services/business-hours/zoned-time";
import { clockView, moveClock } from "./clock";
import { worldToday } from "./console-ports";
import { peopleOfWorld, sendQuick, sendVoice, tapByTitle } from "./simulator";
import { personOfParty } from "./simulator-views";
import { type IspContext, ispProcedure, router } from "./trpc";

export const TourTrack = z.enum(["EXPRESS", "FULL"]);
export type TourTrack = z.infer<typeof TourTrack>;

export type TourPart =
  | { readonly kind: "CLOCK"; readonly move: "START_DAY" | "NEXT" }
  | { readonly kind: "CLOCK_TO"; readonly time: string }
  | { readonly kind: "QUICK"; readonly quickId: string }
  | { readonly kind: "VOICE"; readonly party: string; readonly voiceId: string }
  | { readonly kind: "TAP"; readonly party: string; readonly action: WaButtonAction }
  | { readonly kind: "VIEW"; readonly view: "metrics" | "manual" | "outbox" | "cases" | "orders" | "home" };

export interface TourStep {
  readonly stepId: string;
  /** The scene of "Saltar a escena" that prepares the step; `null` when the step needs none. */
  readonly sceneId: string | null;
  /** What the step expects to wait (docs/design-brief.md §15). */
  readonly waitSec: number;
  readonly parts: readonly TourPart[];
}

const quick = (quickId: string): TourPart => ({ kind: "QUICK", quickId });
const ROGELIO = "inst-rogelio";

export const TOURS: Readonly<Record<TourTrack, readonly TourStep[]>> = {
  EXPRESS: [
    { stepId: "X1", sceneId: "en-sitio-0920", waitSec: 45, parts: [quick("s1-voice-note")] },
    { stepId: "X2", sceneId: "evidencia", waitSec: 40, parts: [quick("s3-label-glare-photo"), quick("s3-label-photo")] },
    { stepId: "X3", sceneId: "checklist-completo", waitSec: 60, parts: [quick("s4-close-tap")] },
    { stepId: "X4", sceneId: "tercera-visita-1510", waitSec: 20, parts: [quick("s6-hazard")] },
  ],
  FULL: [
    { stepId: "1", sceneId: null, waitSec: 10, parts: [{ kind: "VIEW", view: "home" }] },
    { stepId: "2", sceneId: "inicio-del-dia", waitSec: 5, parts: [{ kind: "CLOCK", move: "START_DAY" }] },
    { stepId: "3", sceneId: "ordenes-del-dia", waitSec: 30, parts: [{ kind: "TAP", party: ROGELIO, action: "VIEW_ORDERS" }] },
    { stepId: "4", sceneId: "en-sitio-0920", waitSec: 45, parts: [{ kind: "CLOCK_TO", time: "09:20" }, quick("s1-voice-note")] },
    { stepId: "5", sceneId: "paso-de-diagnostico", waitSec: 30, parts: [quick("s1-connector-cleaned")] },
    { stepId: "6", sceneId: "onu-en-linea", waitSec: 30, parts: [quick("s2-policy-question"), { kind: "VIEW", view: "manual" }] },
    { stepId: "7", sceneId: "evidencia", waitSec: 100, parts: [quick("s3-meter-photo"), quick("s3-label-glare-photo"), quick("s3-label-photo"), quick("s3-rosette-photo"), quick("s3-sign-off")] },
    { stepId: "8", sceneId: "checklist-completo", waitSec: 60, parts: [quick("s4-close-tap"), { kind: "VIEW", view: "outbox" }] },
    {
      stepId: "9",
      sceneId: "segunda-visita-1150",
      waitSec: 90,
      parts: [{ kind: "CLOCK_TO", time: "11:50" }, { kind: "VOICE", party: ROGELIO, voiceId: "vn-04" }, { kind: "VOICE", party: ROGELIO, voiceId: "vn-04" }, { kind: "VOICE", party: ROGELIO, voiceId: "vn-04" }],
    },
    { stepId: "10", sceneId: "caso-con-supervisora", waitSec: 5, parts: [{ kind: "CLOCK", move: "NEXT" }, { kind: "VIEW", view: "cases" }] },
    { stepId: "11", sceneId: "caso-con-respaldo", waitSec: 30, parts: [quick("s5-take-case"), quick("s5-hector-instruction"), quick("s5-close-case")] },
    { stepId: "12", sceneId: "tercera-visita-1510", waitSec: 20, parts: [{ kind: "CLOCK_TO", time: "15:10" }, quick("s6-hazard")] },
    { stepId: "13", sceneId: null, waitSec: 0, parts: [{ kind: "VIEW", view: "metrics" }] },
  ],
};

const StepsInput = z.object({ track: TourTrack }).strict();
const RunInput = z.object({ track: TourTrack, stepId: z.string().min(1).max(8), part: z.number().int().min(0).max(9).optional() }).strict();

type Ctx = Pick<IspContext, "deps" | "world" | "principal" | "log">;

export function tourStep(track: TourTrack, stepId: string): TourStep {
  const step = TOURS[track].find((candidate) => candidate.stepId === stepId);
  if (step === undefined) throw new ToolError("NOT_FOUND", "no such step in this tour");
  return step;
}

async function runPart(ctx: Ctx, part: TourPart) {
  switch (part.kind) {
    case "CLOCK":
      return moveClock(ctx, part.move === "START_DAY" ? { startDay: true } : { next: true }, false);
    case "CLOCK_TO": {
      const today = await worldToday(ctx);
      return moveClock(ctx, { to: zonedInstant(today.day, part.time, today.timeZone).toISOString() }, false);
    }
    case "QUICK":
      return sendQuick(ctx, part.quickId);
    case "VOICE":
    case "TAP": {
      const person = personOfParty(await peopleOfWorld(ctx), part.party);
      if (person === undefined) throw new ToolError("NOT_FOUND", "this world has no such person");
      return part.kind === "VOICE" ? sendVoice(ctx, { identity: person.personId, voiceId: part.voiceId }) : tapByTitle(ctx, person.personId, buttonText(part.action, "es"));
    }
    case "VIEW":
      return { view: part.view };
  }
}

export const tourRouter = router({
  steps: ispProcedure.input(StepsInput).query(async ({ ctx, input }) => {
    const clock = await clockView(ctx);
    const steps = TOURS[input.track];
    return {
      track: input.track,
      simNow: clock.simNow,
      busy: clock.busy,
      upcoming: clock.next,
      estimatedSec: steps.reduce((total, step) => total + step.waitSec, 0),
      steps: steps.map((step) => ({ stepId: step.stepId, sceneId: step.sceneId, waitSec: step.waitSec, parts: step.parts.map((part, index) => ({ index, ...part })) })),
    };
  }),
  run: ispProcedure.input(RunInput).mutation(async ({ ctx, input }) => {
    const step = tourStep(input.track, input.stepId);
    const parts = input.part === undefined ? step.parts : [step.parts[input.part]];
    if (parts.some((part) => part === undefined)) throw new ToolError("NOT_FOUND", "no such part in this step");
    const results = [];
    for (const part of parts as TourPart[]) results.push({ kind: part.kind, result: await runPart(ctx, part) });
    ctx.log.info("tour.step.run", { track: input.track, stepId: input.stepId, parts: results.length });
    return { track: input.track, stepId: input.stepId, results };
  }),
});
