// The worlds of a scenario (docs/test-plan.md §4.2 and §4.4): `world.create` of `qa-<runId>-<slug>[-<suffix>]`
// with its own operator, the people and orders it cloned, the presets it applied; every world created is
// registered so the runner audits it (`policyAudit.run`, 0 violations), reads its usage (`metrics.get`) and
// destroys it in `finally`, whatever happened.
import type { AppliedPreset } from "../../../packages/bff/src/worlds/presets";
import type { CreateQaWorldRequest } from "../../../packages/bff/src/worlds/qa-world";
import type { ScenarioContext } from "./context";

export interface WorldOperation {
  readonly key: string;
  readonly workOrderId: string;
  readonly installerId: string;
}

export interface WorldPerson {
  readonly personId: string;
  readonly role: "INSTALLER" | "SUPERVISOR" | "ZONE_CHIEF";
  readonly phone?: string;
}

export interface World {
  readonly clockId: string;
  readonly ispId: string;
  readonly worldEpoch: number;
  readonly startAtSim: string;
  readonly operations: readonly WorldOperation[];
  readonly people: readonly WorldPerson[];
  readonly presets: readonly AppliedPreset[];
}

const WORLDS_KEY = "__worlds";

/** Every world the scenario created (or asked for), for the runner's cleanup. */
export function worldsOf(state: Record<string, unknown>): string[] {
  return (state[WORLDS_KEY] as string[] | undefined) ?? [];
}

export function registerWorld(state: Record<string, unknown>, clockId: string): void {
  const worlds = worldsOf(state);
  if (!worlds.includes(clockId)) state[WORLDS_KEY] = [...worlds, clockId];
}

/** `qa-<runId>-<slug>` or `qa-<runId>-<slug>-<suffix>` (`sc04-dup` → `qa-…-sc-04-dup`). */
export function clockOf(ctx: Pick<ScenarioContext, "runId" | "scenario">, suffix?: string): string {
  return `qa-${ctx.runId}-${ctx.scenario.slug}${suffix === undefined ? "" : `-${suffix}`}`;
}

export type WorldRequest = Omit<CreateQaWorldRequest, "clockId">;

/** `world.create` of a world of this scenario; registered before the call, so even a half-built one is destroyed. */
export async function createWorld(ctx: ScenarioContext, request: WorldRequest, suffix?: string): Promise<World> {
  const clockId = clockOf(ctx, suffix);
  registerWorld(ctx.state, clockId);
  const created = (await ctx.qa("world.create", { ...request, clockId })) as { kind: string; world: World };
  return created.world;
}

export function op(world: World, key: string): WorldOperation {
  const found = world.operations.find((operation) => operation.key === key);
  if (found === undefined) throw new RangeError(`${world.clockId} has no operation ${key}`);
  return found;
}

/** The world's clone of a person of the models (`sup-adriana` → `sup-adriana-<clockId>`). */
export function staff(world: World, modelPersonId: string): string {
  return `${modelPersonId}-${world.clockId}`;
}

/** Presets applied to an order (offers with their message ids, candidate message ids, a seeded case). */
export function presetOf(world: World, workOrderId: string): AppliedPreset | undefined {
  return world.presets.find((preset) => preset.workOrderId === workOrderId);
}

/** The world a step stored in the state under `name`. */
export function stored<T>(ctx: Pick<ScenarioContext, "state">, name: string): T {
  const value = ctx.state[name];
  if (value === undefined) throw new RangeError(`the state has no ${name}: an earlier step did not run`);
  return value as T;
}
