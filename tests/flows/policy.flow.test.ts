// Area I · Contact policy, window and quiet hours (docs/flows-catalog.md FL-072 and FL-073), in process:
// the outbound pipeline's policy measured with the world's clock (synthetic identities), what is denied
// stays on the order's timeline, and a proactive message in quiet hours is deferred to a `TIMER#` that the
// clock fires at 07:00. The live variant of FL-072 (c) waits for P-01 (docs/test-plan.md §2.1).
import { describe, expect, it } from "vitest";
import { STATUS_REPLY, reply } from "./support/agent";
import { createFlowWorld } from "./support/world";

const CHANGED = { steps: [reply("El despacho cambió una de tus órdenes; revisa tus órdenes del día.")] };

describe("policy flows", () => {
  it("[FL-072] (a) inside the installer's 24 h window the agent's free text goes out", async () => {
    const world = await createFlowWorld();
    await world.at("09:20");
    await world.data.worlds.setActiveWorkOrder("inst-rogelio", world.clockId, "wo-24817", await world.simNow());
    world.plan({ steps: [STATUS_REPLY] });
    await world.text("inst-rogelio", "Hola");
    const [answer] = await world.delivered("inst-rogelio", "REPLY");
    expect(answer?.policy?.ruleIds).toContain("CP-WA-24H");
    expect((await world.decisions()).find((decision) => decision.messageId === answer?.messageId)?.evaluated.find((rule) => rule.ruleId === "CP-WA-24H")?.result).toBe("PASS");
  });

  it("[FL-072] (b) 25 h after the installer's last message no free text reaches him: the notice is denied by CP-WA-24H and stays on the timeline", async () => {
    const world = await createFlowWorld();
    await world.at("17:40");
    expect((await world.data.people.getPerson("inst-rogelio"))?.lastInboundAtSim).toBe("2026-10-12T16:34:00-06:00");
    world.plan(CHANGED);
    await world.dispatch.run({ action: "cancel", workOrderNumber: "24819", request: { ispId: "isp-demo", reason: "CUSTOMER_REQUEST", occurredAtSim: "2026-10-13T17:40:00-06:00", idempotencyKey: "qa-fl072b" } });
    await world.settle();
    const send = world.harness.turns[0]?.calls[0]?.output;
    expect(send).toMatchObject({ ok: false, error: { code: "TEMPLATE_REQUIRED", reason: "CP-WA-24H" } });
    expect((await world.delivered("inst-rogelio")).filter((message) => message.sentAtSim >= "2026-10-13T23:00:00.000Z")).toEqual([]);
    const denied = (await world.outbound("inst-rogelio")).filter((message) => message.status === "DENIED" && message.sentAtSim >= "2026-10-13T23:00:00.000Z");
    expect(denied.map((message) => message.policy?.ruleIds)).toEqual([["CP-WA-24H"]]);
    expect((await world.data.conversations.listTimeline("wo-24819")).some((entry) => JSON.stringify(entry).includes(denied[0]?.messageId ?? "∅"))).toBe(true);
    expect((await world.decisions()).filter((decision) => decision.decision === "DENY" && decision.ruleIds.includes("CP-WA-24H")).length).toBeGreaterThanOrEqual(1);
  });

  async function deferredAt2200() {
    const world = await createFlowWorld();
    await world.at("21:50");
    await world.data.worlds.setActiveWorkOrder("inst-rogelio", world.clockId, "wo-24817", await world.simNow());
    world.plan({ steps: [reply("Buenas noches, ya registré tu mensaje.")] }, CHANGED);
    await world.text("inst-rogelio", "Ya terminé por hoy");
    expect((await world.delivered("inst-rogelio", "REPLY")).map((message) => message.sentAtSim)).toEqual(["2026-10-14T03:50:00.000Z"]);
    await world.advance({ to: "2026-10-14T04:00:00.000Z" });
    await world.dispatch.run({ action: "cancel", workOrderNumber: "24819", request: { ispId: "isp-demo", reason: "CUSTOMER_REQUEST", occurredAtSim: "2026-10-13T22:00:00-06:00", idempotencyKey: "qa-fl073" } });
    await world.settle();
    const [deferred] = (await world.outbound("inst-rogelio", "REPLY")).filter((message) => message.status === "DEFERRED");
    return { world, deferred };
  }

  it("[FL-073] a proactive message at 22:00 is deferred by quiet hours to a TIMER#DEFERRED_SEND at 07:00, which the next move of the clock fires", async () => {
    const { world, deferred } = await deferredAt2200();
    expect(deferred?.policy?.ruleIds).toEqual(["CP-QUIET-HOURS"]);
    const timers = (await world.data.timers.listTimers({ kind: "WORK_ORDER", id: "wo-24819" })).filter((timer) => timer.kind === "DEFERRED_SEND");
    expect(timers.map((timer) => [timer.status, timer.dueAtSim])).toEqual([["SCHEDULED", "2026-10-14T13:00:00.000Z"]]);
    const moved = await world.advance({ next: true });
    expect(moved.fired.map((fired) => fired.kind)).toEqual(["DEFERRED_SEND"]);
    expect(moved.simNow).toBe("2026-10-14T13:00:00.000Z");
  });

  it("[FL-073] at 07:00 the re-evaluated message goes out, with sentAtSim 07:00", async () => {
    const { world, deferred } = await deferredAt2200();
    await world.advance({ next: true });
    const sent = (await world.delivered("inst-rogelio", "REPLY")).filter((message) => message.sentAtSim === "2026-10-14T13:00:00.000Z");
    expect(sent.map((message) => message.text)).toEqual([deferred?.text]);
  });
});
