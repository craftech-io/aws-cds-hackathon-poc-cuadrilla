// "Saltar a escena" (docs/architecture.md §8, docs/design-brief.md §15): after the reset of a guest
// world, the factory loads it in the seeded state of one scene of the tour, declared in the `guest`
// template (`scenes[]`): the presets of each order (worlds/presets.ts; a scene that ends on a button of
// the agent, such as "Cerrar instalación", seeds it with `offer`), the installer's active order and
// window, and then the clock moves to the scene's instant and every timer due by then is sent to its
// installer's queue at its own `dueAtSim`, as "Avanzar" does (the day start of 07:30 included). A step
// of the tour never depends on earlier turns of the model.
import { z } from "zod";
import { IsoInstant, ToolError } from "@cuadrilla/shared";
import { dispatchDue } from "../clock/state";
import { readWorldClock } from "../timers/timers";
import { type WorldsDeps, presetDepsOf } from "./deps";
import { RenderAllocator } from "./photo-catalog";
import { type AppliedPreset, applyOrderPreset } from "./presets";
import { GUEST_TEMPLATE, fillTemplate, markersFor, readTemplate } from "./template";
import { OrderPreset } from "./templates";

export const Scene = z.looseObject({
  sceneId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  advanceToSim: IsoInstant,
  installer: z.object({ personId: z.string().min(1), activeWorkOrderId: z.string().min(1).optional(), lastInboundAtSim: IsoInstant.optional() }).strict(),
  orders: z.record(z.string(), OrderPreset),
});
export type Scene = z.infer<typeof Scene>;

const Scenes = z.array(Scene);

/** The scenes of a guest world, with the world's markers filled. */
export async function scenesOf(deps: Pick<WorldsDeps, "templates">, ispId: string): Promise<Scene[]> {
  const template = fillTemplate(await readTemplate(deps.templates, GUEST_TEMPLATE), markersFor(ispId));
  const parsed = Scenes.safeParse(template.scenes ?? []);
  if (!parsed.success) throw new ToolError("INVALID", "the scenes of the guest template do not match their shape", "SCENES_INVALID");
  return parsed.data;
}

export interface SceneApplied {
  readonly sceneId: string;
  readonly sceneAtSim: string;
  readonly presets: readonly AppliedPreset[];
  readonly fired: number;
}

/** Seeds the scene in a freshly reloaded guest world and moves its clock to the scene's instant. */
export async function applyScene(deps: WorldsDeps, input: { readonly clockId: string; readonly ispId: string; readonly sceneId: string }): Promise<SceneApplied> {
  const scene = (await scenesOf(deps, input.ispId)).find((candidate) => candidate.sceneId === input.sceneId);
  if (scene === undefined) throw new ToolError("NOT_FOUND", `no scene ${input.sceneId} in this world`, "SCENE_NOT_FOUND");
  const { connector } = deps;
  const photos = await deps.photos();
  const allocator = new RenderAllocator(photos);
  const presetDeps = presetDepsOf(deps, photos);
  const presets: AppliedPreset[] = [];
  for (const [workOrderId, preset] of Object.entries(scene.orders)) {
    const order = await connector.workOrders.requireWorkOrder(workOrderId);
    if (order.clockId !== input.clockId) throw new ToolError("FORBIDDEN", "a scene names an order of another world", "SCENE_FOREIGN_ORDER");
    const installer = await connector.people.requirePerson(order.installerId);
    presets.push(await applyOrderPreset(presetDeps, allocator, { order, installer, atSim: scene.advanceToSim }, preset));
  }
  const { personId, activeWorkOrderId, lastInboundAtSim } = scene.installer;
  if (activeWorkOrderId !== undefined) await connector.worlds.setActiveWorkOrder(personId, input.clockId, activeWorkOrderId, scene.advanceToSim);
  if (lastInboundAtSim !== undefined) await connector.people.recordInbound(personId, { atSim: lastInboundAtSim });

  // The clock stands at the scene before its due timers go to the queue: a worker that claims one
  // finds the world past its `dueAtSim`, never a paused world that re-arms it.
  let clock = await readWorldClock(connector, input.clockId);
  if (Date.parse(scene.advanceToSim) > Date.parse(clock.pausedSimNow)) clock = await connector.runtime.updateClock(input.clockId, { pausedSimNow: scene.advanceToSim }, clock.version);
  const fired = await dispatchDue(clock, new Date(scene.advanceToSim), { data: connector, scheduler: deps.scheduler, dispatcher: deps.dispatcher, realClock: { now: async () => deps.now() }, log: deps.log });
  return { sceneId: scene.sceneId, sceneAtSim: scene.advanceToSim, presets, fired: fired.length };
}
