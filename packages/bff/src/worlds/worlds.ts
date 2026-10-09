// The world factory's entry points (docs/tool-catalog.md `create_world`, `reset_demo_world`,
// `destroy_world`, `jump_to_scene`; docs/seed-spec.md §13):
//
//   createWorld    QA and evaluation worlds from the models (worlds/qa-world.ts; one that fails half way is
//                  destroyed, never left half built); the rehearsal world of
//                  the `QaDriver`'s `GUEST` principal with `{template: guest}` (built, or reset when it
//                  exists); the operator's demo world (worlds/demo.ts). Guest worlds of accounts are built
//                  by `GuestWorlds` with the same factory.
//   destroyWorld   a QA, evaluation or guest world: tombstone of its epoch, its schedules, every item of
//                  the world (worlds keep the real-time counters of a guest world: `RATE#…#REAL#…`,
//                  `SIMCAP#`, `TURNCAP#`, `JUMP#`), its phone leases, its operator's rows (a console user
//                  bound to a Cognito account stays), its clock (never its epoch counter), the number and
//                  phone leases of a QA world, and its Memory in passes. The demo world is never destroyed.
//   reset / jump   worlds/rebuild.ts over clock/reset.ts.
import { z } from "zod";
import { ClockId, DEMO_CLOCK_ID, GUEST_TEST_CLOCK_ID, GUEST_TEST_ISP_ID, ToolError, ispIdOfClock, parseClockId } from "@cuadrilla/shared";
import { scheduledTimers } from "../clock/state";
import { purgeWorldItems } from "../clock/world-items";
import { clockKey, ispPartition } from "../connector/keys";
import type { Actor } from "../domain/common";
import { localDateOf } from "../services/business-hours/zoned-time";
import { type WorldsDeps, factoryDepsOf } from "./deps";
import { createDemoWorld } from "./demo";
import { buildWorld } from "./factory";
import { purgeFirstPass } from "./memory-purge";
import { purgeTargetOf, scopeOfWorld } from "./memory-targets";
import { type QaWorld, createQaWorld, leasesOf } from "./qa-world";
import { resetWorld } from "./rebuild";
import { GUEST_WORLD_START_SIM } from "./template";

const TIME_ZONE = "America/Mexico_City";

export const GuestTestWorldRequest = z.object({ clockId: z.literal(GUEST_TEST_CLOCK_ID), template: z.literal("guest") }).strict();

export type CreatedWorld = { readonly kind: "QA" | "EVAL"; readonly world: QaWorld } | { readonly kind: "GUEST" | "DEMO"; readonly clockId: string; readonly worldEpoch: number; readonly action: "CREATED" | "RESET" };

/** `world.create`: a QA or evaluation world, the rehearsal world (`{template: guest}`), or the demo world. */
export async function createWorld(deps: WorldsDeps, request: unknown, actor: Actor = "QA"): Promise<CreatedWorld> {
  const guest = GuestTestWorldRequest.safeParse(request);
  if (guest.success) return createGuestTestWorld(deps, actor);
  const clockId = z.object({ clockId: ClockId }).loose().parse(request).clockId;
  if (clockId === DEMO_CLOCK_ID) {
    const created = await createDemoWorld(deps);
    return { kind: "DEMO", clockId, worldEpoch: created.worldEpoch, action: "CREATED" };
  }
  const existed = (await deps.connector.runtime.getClock(clockId)) !== undefined;
  try {
    const world = await createQaWorld(deps, request);
    return { kind: parseClockId(world.clockId)?.kind === "EVAL" ? "EVAL" : "QA", world };
  } catch (error) {
    // A world this call started and could not finish (a preset that failed) is taken down whole, so a
    // retry builds it again instead of finding half of it.
    if (!existed && (await deps.connector.runtime.getClock(clockId)) !== undefined) await destroyWorld(deps, { clockId, actor });
    throw error;
  }
}

/** The rehearsal world: built with the `TEST` caps when it does not exist, reset when it does. */
async function createGuestTestWorld(deps: WorldsDeps, actor: Actor): Promise<CreatedWorld> {
  const clock = await deps.connector.runtime.getClock(GUEST_TEST_CLOCK_ID);
  if (clock === undefined) {
    const built = await buildWorld({ ...factoryDepsOf(deps), ...(deps.certificates === undefined ? {} : { certificates: deps.certificates }) }, { ispId: GUEST_TEST_ISP_ID, origin: "TEST" });
    return { kind: "GUEST", clockId: GUEST_TEST_CLOCK_ID, worldEpoch: built.worldEpoch, action: "CREATED" };
  }
  const reset = await resetWorld(deps, { clockId: GUEST_TEST_CLOCK_ID, caller: "QA", actor });
  return { kind: "GUEST", clockId: GUEST_TEST_CLOCK_ID, worldEpoch: reset.worldEpoch, action: "RESET" };
}

export interface DestroyedWorld {
  readonly clockId: string;
  readonly epoch: number;
  readonly items: number;
  readonly leases: number;
}

/** Operator rows a destruction keeps: a console user bound to a Cognito account (its registry row). */
function keepsRow(row: Record<string, unknown>): boolean {
  return row.entity === "ConsoleUser" && typeof row.cognitoSub === "string" && row.cognitoSub !== "";
}

/** `world.destroy` of a QA, evaluation or guest world; idempotent (a world already gone is a no-op). */
export async function destroyWorld(deps: WorldsDeps, input: { readonly clockId: string; readonly actor: Actor }): Promise<DestroyedWorld> {
  const kind = parseClockId(input.clockId)?.kind;
  if (kind === undefined || kind === "DEMO") throw new ToolError("FORBIDDEN", "only QA, evaluation and guest worlds are destroyed", "DESTROY_NOT_ALLOWED");
  const ispId = ispIdOfClock(input.clockId);
  const clock = await deps.connector.runtime.getClock(input.clockId);
  if (clock === undefined) return { clockId: input.clockId, epoch: await deps.connector.runtime.currentEpoch(input.clockId), items: 0, leases: 0 };
  const now = deps.now();
  const installerIds = (await deps.connector.people.listPeople(ispId, "INSTALLER")).map((person) => person.personId);
  const startSim = typeof clock.settings?.startAtSim === "string" ? clock.settings.startAtSim : kind === "GUEST" ? GUEST_WORLD_START_SIM : clock.pausedSimNow;
  const memoryScope = await scopeOfWorld(deps.connector, { clockId: input.clockId, ispId, epoch: clock.worldEpoch, startDate: localDateOf(new Date(startSim), TIME_ZONE), installerIds });
  await deps.connector.worlds.putTombstone({ clockId: input.clockId, worldEpoch: clock.worldEpoch, reason: "DESTROY", atReal: now.toISOString() });
  for (const timer of await scheduledTimers(clock, { data: deps.connector })) if (timer.scheduleName !== undefined) await deps.scheduler.delete(timer.scheduleName);
  const toSim = Date.parse(clock.pausedSimNow) > Date.parse(startSim) ? clock.pausedSimNow : startSim;
  const deleted = await purgeWorldItems({ clockId: input.clockId, ispId, startSim, toSim }, { client: deps.client, data: deps.connector });
  const operatorRows = (await deps.client.query("Isps", { hashValue: ispPartition(ispId) })).filter((row) => !keepsRow(row));
  if (operatorRows.length > 0) await deps.client.batchDelete("Isps", operatorRows.map((row) => ({ PK: row.PK, SK: row.SK })));
  await deps.client.delete("Runtime", clockKey(input.clockId));
  const leases = leasesOf(clock.settings);
  const held = [...Object.values(leases?.PHONE ?? {}).map((n) => ["PHONE", n] as const), ...Object.values(leases?.WONUM ?? {}).map((n) => ["WONUM", n] as const)];
  for (const [leaseKind, n] of held) await deps.connector.worlds.releaseLease(leaseKind, n, input.clockId);
  const released = held.length;
  if (deps.memory !== undefined) {
    const { target } = await purgeFirstPass({ memory: deps.memory, now: deps.now }, purgeTargetOf(memoryScope, deps.runtimeSessionKey));
    await deps.continuePurge(target);
  }
  const items = Object.values(deleted).reduce((sum, count) => sum + (count ?? 0), 0) + operatorRows.length + 1;
  await deps.connector.audit.append({ ispId, clockId: input.clockId, decision: "ACTION", action: "WORLD_DESTROYED", actor: input.actor, detail: { epoch: clock.worldEpoch, items, leases: released } });
  deps.log.info("worlds.destroyed", { clockId: input.clockId, epoch: clock.worldEpoch, items, leases: released });
  return { clockId: input.clockId, epoch: clock.worldEpoch, items, leases: released };
}
