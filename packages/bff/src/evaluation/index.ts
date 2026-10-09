// The evaluation's actions as the `QaDriver` imports them (docs/tool-catalog.md, WP-45): `eval.runQuestions`
// (`EV-01`) and `eval.runPhotos` (`EV-02`), plus the ONU setter of the photo runs over the world factory's
// own preset (the same `Network` write as `world.create` and the scenes), so the driver wires the ports
// it already has. The guard of the driver (Isp.kind, clock prefix) runs before; the inputs are parsed
// again here (ports.ts) and only accept an `eval-*` world.
import { RenderAllocator } from "../worlds/photo-catalog";
import { applyOrderPreset } from "../worlds/presets";
import { type WorldsDeps, presetDepsOf } from "../worlds/deps";
import type { EvalDeps, EvalTools } from "./ports";
import { runPhotos } from "./run-photos";
import { type RunOutput, runQuestions } from "./run-questions";

export { RunPhotosInput, RunQuestionsInput, MAX_PHOTOS_PER_CALL, MAX_QUESTIONS_PER_CALL } from "./ports";
export type { EvalChannel, EvalDeps, EvalTools, ValidatePhotoCall } from "./ports";
export type { ItemRun, RunOutput } from "./run-questions";
export { evalClockId, evalRunOf, evalWorldRequest, itemKey } from "./world-request";

export const EVAL_ACTIONS = {
  "eval.runQuestions": runQuestions,
  "eval.runPhotos": runPhotos,
} as const satisfies Record<string, (deps: EvalDeps, input: unknown) => Promise<RunOutput>>;
export type EvalActionName = keyof typeof EVAL_ACTIONS;

/** `EvalTools.setOnu` over the world factory: the `onu` preset of the order (behaviour and received power). */
export function presetOnuSetter(worlds: WorldsDeps): EvalTools["setOnu"] {
  return async ({ order, installer, atSim, behaviour, rxDbm }) => {
    const photos = await worlds.photos();
    await applyOrderPreset(presetDepsOf(worlds, photos), new RenderAllocator(photos), { order, installer, atSim }, { onu: { behaviour, rxDbm } });
  };
}
