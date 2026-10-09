// The QaDriver's actions over the memory world factory (docs/tool-catalog.md "Acciones del QaDriver"):
// a QA world built by `world.create`, its snapshot, the real `open_case` handed to the installer's queue,
// the clock without the console's gate, the quiescence held for 10 s, the simulated channel's envelope
// and the destruction; plus the procedure paths of the console.
import { describe, expect, it } from "vitest";
import { verifySimulatedEnvelope } from "../channels/whatsapp/sim-envelope";
import type { SnsNotification } from "../channels/whatsapp/payloads";
import type { QaResponse } from "./contract";
import { procedureAt } from "./console";
import { settle } from "./settle";
import type { QaSnapshot } from "./snapshot";
import { SIM_ENVELOPE_KEY, memoryDriver, memoryQaPorts } from "./testing";

const CLOCK = "qa-812-1-sc-01";

function result<T>(response: QaResponse): T {
  if (!response.ok) throw new Error(`${response.error.code} ${response.error.reason ?? ""} ${response.error.message}`);
  return response.result as T;
}

async function world() {
  const memory = memoryQaPorts({ start: "2026-10-13T13:00:00.000Z" });
  const driver = memoryDriver(memory);
  let n = 0;
  const call = async (action: Parameters<typeof driver>[0] extends never ? never : string, input: unknown) => driver({ action, idempotencyKey: `812-1/sc-01/${(n += 1)}`, input });
  const created = result<{ kind: string; world: { operations: Array<{ key: string; workOrderId: string; installerId: string }> } }>(
    await call("world.create", { clockId: CLOCK, startAtSim: "2026-10-13T07:25:00-06:00", operations: [{ key: "a1", model: "wo-24817", installer: "own" }, { key: "a2", model: "wo-24818", installer: "a1" }] }),
  );
  return { memory, call, created };
}

describe("QaDriver actions over a QA world [FL-084]", () => {
  it("[FL-084] builds the world, snapshots its orders and pending DAY_START, and destroys it", async () => {
    const { call, created } = await world();
    expect(created.kind).toBe("QA");
    const [a1] = created.world.operations;
    const snapshot = result<QaSnapshot>(await call("snapshot", { clockId: CLOCK, workOrderIds: [a1?.workOrderId], personIds: [a1?.installerId] }));
    expect(snapshot).toMatchObject({ clockId: CLOCK, mode: "PAUSED" });
    expect(snapshot.timers.map((timer) => timer.kind)).toEqual(["DAY_START"]);
    expect(snapshot.orders[0]?.checklist.map((item) => item.status)).toEqual(["PENDING", "PENDING", "PENDING", "PENDING", "PENDING"]);
    expect(snapshot.people[0]).toMatchObject({ role: "INSTALLER", active: true, inFlight: [] });
    expect(result<{ items: number }>(await call("world.destroy", { clockId: CLOCK })).items).toBeGreaterThan(0);
    expect(result<QaSnapshot>(await call("snapshot", { clockId: CLOCK })).mode).toBe("ABSENT");
  });

  it("[FL-054] hands case.open to the installer's queue as CASE_PRESET (the real open_case runs in the worker)", async () => {
    const { call, created, memory } = await world();
    const [a1] = created.world.operations;
    result(await call("case.open", { workOrderId: a1?.workOrderId, reason: "DIAGNOSIS_ATTEMPTS" }));
    expect(memory.queued).toEqual([expect.objectContaining({ type: "CASE_PRESET", workOrderId: a1?.workOrderId, installerId: a1?.installerId, reason: "DIAGNOSIS_ATTEMPTS", rung: "PRIMARY", status: "OPEN", eventId: expect.stringMatching(/^qa-[0-9a-f]{40}$/) })]);
  });

  it("[FL-009] moves the clock without the console's gate and dispatches what fell due", async () => {
    const { call, memory } = await world();
    const moved = result<{ simNow: string; fired: Array<{ kind: string }> }>(await call("clock.advanceToNext", { clockId: CLOCK }));
    expect(new Date(moved.simNow).toISOString()).toBe("2026-10-13T13:30:00.000Z");
    expect(moved.fired.map((timer) => timer.kind)).toEqual(["DAY_START"]);
    expect(memory.harness.dispatcher.sent).toHaveLength(1);
  });

  it("[FL-093] sends a person's message as the simulator's signed envelope of the world, with a wamid derived from the step's key", async () => {
    const { call, created, memory } = await world();
    const [a1] = created.world.operations;
    const sent = result<{ wamid: string }>(await call("wa.inbound", { clockId: CLOCK, identity: a1?.installerId, content: { type: "text", text: "Ya llegué al domicilio" } }));
    expect(sent.wamid).toMatch(/^wamid\.SIM\.[0-9a-f]{64}$/);
    const event = memory.inbound[0] as { Records: Array<{ Sns: SnsNotification }> };
    const record = event.Records[0];
    expect(record === undefined ? undefined : verifySimulatedEnvelope(record.Sns, SIM_ENVELOPE_KEY)).toBe(CLOCK);
    expect(record?.Sns.Message).toContain(sent.wamid);
  });

  it("[FL-085] settles only after the installer and the world stayed quiet for the hold, and fails with what is pending", async () => {
    const { created, memory } = await world();
    const [a1] = created.world.operations;
    const deps = { data: memory.ports.data, now: () => memory.harness.now(), sleep: async (ms: number) => memory.harness.advance(ms) };
    const quiet = await settle(deps, { clockId: CLOCK, installerId: a1?.installerId ?? "", timeoutSec: 60, holdSec: 10 });
    expect(quiet.waitedMs).toBeGreaterThanOrEqual(10_000);
    await memory.ports.data.worlds.markInFlight(a1?.installerId ?? "", CLOCK, "qa-stuck-event");
    await expect(settle(deps, { clockId: CLOCK, installerId: a1?.installerId ?? "", timeoutSec: 30, holdSec: 10 })).rejects.toMatchObject({ code: "UNAVAILABLE", reason: "NOT_SETTLED" });
  });

  it("finds a console procedure by its path and refuses a path that is not one", () => {
    const calls: string[] = [];
    const caller = { clock: { dispatch: { reschedule: async () => void calls.push("reschedule") } } } as unknown as Parameters<typeof procedureAt>[0];
    expect(typeof procedureAt(caller, "clock.dispatch.reschedule")).toBe("function");
    expect(() => procedureAt(caller, "clock.nothing")).toThrow(/not a procedure/);
  });
});
