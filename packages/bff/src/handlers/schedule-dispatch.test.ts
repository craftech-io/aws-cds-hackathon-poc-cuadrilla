import { describe, expect, it } from "vitest";
import { timerRefKey } from "../connector/keys";
import { CASE_1, openCase } from "../connector/testing";
import type { TimerHome } from "../domain/timers";
import { feedWorld, queuedBodies } from "../feeds/testing";
import { timerEventId } from "../timers/dispatch";
import { TimerEvent } from "../worker/events";
import { createScheduleDispatchHandler } from "./schedule-dispatch";

const DEMO = "GLOBAL#isp-demo";
const DUE = "2026-10-13T12:01:00-06:00";

async function entry() {
  const world = await feedWorld();
  await world.connector.cases.createCase(openCase());
  await world.connector.runtime.createClock({ clockId: DEMO, ispId: "isp-demo", kind: "DEMO", mode: "PAUSED", offsetMs: 0, pausedSimNow: "2026-10-13T07:00:00-06:00", worldEpoch: 3 });
  const handler = createScheduleDispatchHandler(() => ({ connector: world.connector, queue: world.queue, logger: world.logger }), () => world.logger);
  const arm = async (home: TimerHome, kind: "CASE_TIMEOUT" | "DAY_START" | "CERT_RETRY", timerId: string, clockId = DEMO) => {
    const timer = await world.connector.timers.createTimer({ timerId, kind, home, clockId, dueAtSim: DUE, status: "SCHEDULED", payload: {} });
    return { timer, timerKey: timerRefKey(timer) };
  };
  return { world, handler, arm };
}

describe("ScheduleDispatch entry", () => {
  it("[FL-060] puts a case timeout on the queue of the case's installer, with the world busy first", async () => {
    const { world, handler, arm } = await entry();
    const { timerKey, timer } = await arm({ kind: "CASE", id: CASE_1 }, "CASE_TIMEOUT", "ct-primary-0");
    expect(await handler({ clockId: DEMO, timerKey, dueAtSim: DUE, version: timer.version })).toEqual({ status: "QUEUED" });
    const eventId = timerEventId(timer, 3);
    expect(world.sender.messages).toEqual([{ body: expect.any(String), groupId: "inst-rogelio", deduplicationId: eventId }]);
    expect(TimerEvent.parse(queuedBodies(world.sender)[0])).toEqual({
      type: "TIMER",
      eventId,
      clockId: DEMO,
      ispId: "isp-demo",
      installerId: "inst-rogelio",
      timerKey,
      version: timer.version,
      dueAtSim: timer.dueAtSim,
      firedBy: "SCHEDULER",
    });
    expect((await world.connector.worlds.getWorldState(DEMO))?.inFlight).toEqual([eventId]);
  });

  it("[FL-009] finds the installer of an order's timer and of a DAY_START that lives on the person", async () => {
    const { world, handler, arm } = await entry();
    const onOrder = await arm({ kind: "WORK_ORDER", id: "wo-24820" }, "DAY_START", "ds-inst-karina-2026-10-13");
    const onPerson = await arm({ kind: "PERSON", id: "inst-julian" }, "DAY_START", "ds-inst-julian-2026-10-13");
    await handler({ clockId: DEMO, timerKey: onOrder.timerKey, dueAtSim: DUE, version: onOrder.timer.version });
    await handler({ clockId: DEMO, timerKey: onPerson.timerKey, dueAtSim: DUE, version: onPerson.timer.version });
    expect(world.sender.messages.map((message) => message.groupId)).toEqual(["inst-karina", "inst-julian"]);
  });

  it("the event id is the one the clock gives the same timer, version and epoch; another epoch is another event", async () => {
    const { world, handler, arm } = await entry();
    const { timerKey, timer } = await arm({ kind: "CASE", id: CASE_1 }, "CASE_TIMEOUT", "ct-primary-0");
    await handler({ clockId: DEMO, timerKey, dueAtSim: DUE, version: timer.version });
    const clock = await world.connector.runtime.getClock(DEMO);
    if (clock === undefined) throw new Error("no clock");
    await world.connector.runtime.updateClock(DEMO, { worldEpoch: 4 }, clock.version);
    await handler({ clockId: DEMO, timerKey, dueAtSim: DUE, version: timer.version });
    expect(world.sender.messages.map((message) => message.deduplicationId)).toEqual([timerEventId(timer, 3), timerEventId(timer, 4)]);
  });

  it("the same schedule delivered twice is the same event (SQS deduplicates it)", async () => {
    const { world, handler, arm } = await entry();
    const { timerKey, timer } = await arm({ kind: "WORK_ORDER", id: "wo-24817" }, "CERT_RETRY", "cr-wo-24817");
    const input = { clockId: DEMO, timerKey, dueAtSim: DUE, version: timer.version };
    await handler(input);
    await handler(input);
    expect(new Set(world.sender.messages.map((message) => message.deduplicationId)).size).toBe(1);
  });

  it("ignores a stale version, a timer no longer SCHEDULED, one of another world and one that is gone", async () => {
    const { world, handler, arm } = await entry();
    const { timerKey, timer } = await arm({ kind: "CASE", id: CASE_1 }, "CASE_TIMEOUT", "ct-primary-0");
    expect(await handler({ clockId: DEMO, timerKey, dueAtSim: DUE, version: timer.version + 1 })).toEqual({ status: "STALE_VERSION" });
    expect(await handler({ clockId: "GUEST#isp-guest-07", timerKey, dueAtSim: DUE, version: timer.version })).toEqual({ status: "OTHER_WORLD" });
    expect(await handler({ clockId: DEMO, timerKey: "CASE|case-01J9ZQX0000000000000000009|CASE_TIMEOUT|ct-x", dueAtSim: DUE, version: 1 })).toEqual({ status: "MISSING" });
    const orphan = await arm({ kind: "WORK_ORDER", id: "wo-24888" }, "CERT_RETRY", "cr-wo-24888");
    expect(await handler({ clockId: DEMO, timerKey: orphan.timerKey, dueAtSim: DUE, version: orphan.timer.version })).toEqual({ status: "MISSING" });
    const fired = await world.connector.timers.setTimerStatus(timer, { status: "FIRED", firedBy: "CLOCK", firedAtSim: DUE }, timer.version);
    expect(await handler({ clockId: DEMO, timerKey, dueAtSim: DUE, version: fired.version })).toEqual({ status: "NOT_SCHEDULED" });
    expect(world.sender.messages).toEqual([]);
  });

  it("drops a malformed input without its content", async () => {
    const { world, handler } = await entry();
    expect(await handler({ clockId: DEMO, timerKey: "x", dueAtSim: DUE, version: 0 })).toEqual({ status: "INVALID" });
    expect(await handler({ clockId: "not-a-clock", timerKey: "x", dueAtSim: DUE, version: 1 })).toEqual({ status: "INVALID" });
    expect(await handler({ clockId: DEMO, timerKey: "x", dueAtSim: DUE, version: 1, extra: true })).toEqual({ status: "INVALID" });
    expect(world.lines.join("\n")).not.toContain("not-a-clock");
  });

  it("throws when the queue fails (the Scheduler retries) and leaves the world quiet", async () => {
    const { world, handler, arm } = await entry();
    const { timerKey, timer } = await arm({ kind: "CASE", id: CASE_1 }, "CASE_TIMEOUT", "ct-primary-0");
    world.sender.failNext();
    await expect(handler({ clockId: DEMO, timerKey, dueAtSim: DUE, version: timer.version })).rejects.toThrow("SendMessage failed");
    expect((await world.connector.worlds.getWorldState(DEMO))?.inFlight ?? []).toEqual([]);
    expect((await world.connector.worlds.getInstallerState("inst-rogelio"))?.inFlight ?? []).toEqual([]);
  });
});
