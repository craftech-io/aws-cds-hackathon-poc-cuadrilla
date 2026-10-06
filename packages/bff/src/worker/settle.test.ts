import { beforeEach, describe, expect, it } from "vitest";
import { createEventSink } from "./sink";
import { worldQuiescence } from "./settle";
import { CLOCK, ISP, ROGELIO, TURN_AT_SIM, WO, type WorkerKit, inboundEvent, inboundMessage, seedWorld, workerKit } from "./testing";

let kit: WorkerKit;

beforeEach(async () => {
  kit = workerKit();
  await seedWorld(kit);
});

const EVENT_ID = "wa-in-0000000000000000000000000000000000000001";
const inFlight = async () => ({ installer: (await kit.connector.worlds.getInstallerState(ROGELIO))?.inFlight, world: (await kit.connector.worlds.getWorldState(CLOCK))?.inFlight });

describe("worker/settle: quiescence [FL-085] [FL-099]", () => {
  it("[FL-085] an event enqueued by the sink keeps the installer and the world busy until the worker is done with it", async () => {
    const message = await inboundMessage(kit);
    await kit.deps.sink.enqueue(inboundEvent(message));
    expect(await inFlight()).toEqual({ installer: [EVENT_ID], world: [EVENT_ID] });
    expect((await worldQuiescence(kit.connector, CLOCK, TURN_AT_SIM)).pending).toEqual([{ kind: "EVENT", detail: EVENT_ID }]);
    await kit.run(kit.rec.queued[0]);
    expect(await inFlight()).toEqual({ installer: [], world: [] });
    expect(await worldQuiescence(kit.connector, CLOCK, TURN_AT_SIM)).toEqual({ quiet: true, pending: [] });
  });

  it("[FL-085] a timer that fell due and an email waiting for its first SES event keep the world busy", async () => {
    await kit.connector.timers.createTimer({ timerId: "ds-1", kind: "DAY_START", home: { kind: "WORK_ORDER", id: WO }, clockId: CLOCK, dueAtSim: "2026-10-13T07:30:00-06:00", status: "SCHEDULED" });
    await kit.connector.worlds.addPendingMail(CLOCK, "mail-1");
    const state = await worldQuiescence(kit.connector, CLOCK, TURN_AT_SIM);
    expect(state.quiet).toBe(false);
    expect(state.pending).toEqual([{ kind: "EVENT", detail: "timer:DAY_START" }, { kind: "MAIL", detail: "mail-1", sinceReal: expect.any(String) }]);
  });

  it("[FL-099] a failed attempt that will be retried keeps the event in flight; its last attempt takes it out with processError", async () => {
    kit.deps.turn.prefilter.check = async () => Promise.reject(new Error("guardrail down"));
    const message = await inboundMessage(kit);
    await kit.deps.sink.enqueue(inboundEvent(message));
    await expect(kit.run(kit.rec.queued[0], 4)).rejects.toThrow("guardrail down");
    expect(await inFlight()).toEqual({ installer: [EVENT_ID], world: [EVENT_ID] });
    await expect(kit.run(kit.rec.queued[0], 5)).rejects.toThrow("guardrail down");
    expect(await inFlight()).toEqual({ installer: [], world: [] });
    expect((await kit.connector.worlds.getInstallerState(ROGELIO))?.processError).toMatchObject({ eventId: EVENT_ID, message: "Error" });
    expect((await kit.connector.audit.listByMonth(ISP, "2026-10")).map((decision) => decision.action)).toContain("EVENT_DEAD_LETTERED");
    expect(kit.tools.logs.some((line) => line.metric === "EventDeadLettered")).toBe(true);
  });

  it("[FL-099] a body that does not parse is acknowledged and leaves inFlight by what it says about itself", async () => {
    await kit.connector.worlds.markInFlight(ROGELIO, CLOCK, "evt-bad");
    await kit.run({ type: "AGENT_TURN", eventId: "evt-bad", clockId: CLOCK, ispId: ISP, installerId: ROGELIO, trigger: "NOT_A_TRIGGER" });
    expect(await inFlight()).toEqual({ installer: [], world: [] });
    expect(kit.rec.harness).toEqual([]);
  });

  it("[FL-085] a redelivery of a finished event settles it again without running it", async () => {
    const message = await inboundMessage(kit);
    await kit.run(inboundEvent(message));
    await kit.connector.worlds.markInFlight(ROGELIO, CLOCK, EVENT_ID);
    await kit.run(inboundEvent(message), 2);
    expect(await inFlight()).toEqual({ installer: [], world: [] });
    expect(kit.rec.harness).toHaveLength(1);
  });

  it("the sink validates the event, groups it by installer, deduplicates it by id and takes the mark back when the send fails", async () => {
    const sent: Array<{ groupId: string; deduplicationId: string }> = [];
    const sink = createEventSink({ data: kit.connector, send: async (message) => void sent.push({ groupId: message.groupId, deduplicationId: message.deduplicationId }) });
    await sink.enqueue({ type: "HEALTH_PROBE", eventId: `qa-${"d".repeat(40)}`, probeId: "p-1" });
    await sink.enqueue({ type: "AGENT_TURN", trigger: "ORDERS_REQUESTED", eventId: "evt-o-1", clockId: CLOCK, ispId: ISP, installerId: ROGELIO });
    expect(sent).toEqual([
      { groupId: "health-probe", deduplicationId: `qa-${"d".repeat(40)}` },
      { groupId: ROGELIO, deduplicationId: "evt-o-1" },
    ]);
    await expect(sink.enqueue({ type: "AGENT_TURN", trigger: "ORDERS_REQUESTED", eventId: "evt-o-2", clockId: CLOCK, ispId: "isp-other", installerId: ROGELIO })).rejects.toThrow();
    const failing = createEventSink({ data: kit.connector, send: async () => Promise.reject(new Error("sqs down")) });
    await expect(failing.enqueue({ type: "AGENT_TURN", trigger: "ORDERS_REQUESTED", eventId: "evt-o-3", clockId: CLOCK, ispId: ISP, installerId: ROGELIO })).rejects.toThrow("sqs down");
    expect((await inFlight()).installer).toEqual(["evt-o-1"]);
  });
});
