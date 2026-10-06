import { describe, expect, it } from "vitest";
import { CLOCK, ISP } from "../connector/testing";
import { esMX } from "../copy/es-MX";
import { pipelineDayStartSender, pipelineEvidenceOutbound, pipelineOrderChoice, pipelineWorkerNotices } from "./adapters";
import { TURN, mx, pipelineKit, rogelioWrote } from "./testing";

const PHOTO_WAMID = "wamid.SIM.01JB8Z9Q2W3E4R5T6Y7V8XPHOTO";

async function outOf(kit: Awaited<ReturnType<typeof pipelineKit>>) {
  return (await kit.world.connector.conversations.listMessages("inst-rogelio")).filter((message) => message.direction === "OUT");
}

describe("the pipeline as the ports of dayplan/, evidence/ and the worker", () => {
  it("[FL-010] DAY_START: the ordenes_del_dia template with the orders it counted, once per installer and day", async () => {
    const kit = await pipelineKit();
    const sender = pipelineDayStartSender(kit.deps, kit.call.log);
    const request = {
      ispId: ISP,
      clockId: CLOCK,
      installerId: "inst-rogelio",
      date: "2026-10-13",
      eventAtSim: mx("2026-10-13 07:30"),
      correlationId: "tm-day-start",
      kind: "DAY_START",
      templateName: "ordenes_del_dia",
      params: ["Rogelio", "2", "9:00 a 11:00"],
      buttons: [{ action: "VIEW_ORDERS", object: { kind: "DAY", id: "2026-10-13" } }],
      workOrderIds: ["wo-24817", "wo-24818"],
    } as const;
    const first = await sender.sendDayStart(request);
    expect(first).toMatchObject({ status: "SENT" });
    expect(kit.sends[0]?.payload).toMatchObject({ type: "template", template: { name: "ordenes_del_dia" } });
    const [message] = await outOf(kit);
    expect(message).toMatchObject({ kind: "DAY_START", author: "SYSTEM", refs: { workOrderIds: ["wo-24817", "wo-24818"] } });
    expect(await sender.sendDayStart(request)).toMatchObject({ status: "SENT", messageId: first.status === "SENT" ? first.messageId : "" });
    expect(kit.sends).toHaveLength(1);
  });

  it("[FL-103] VERDICT_REACTION on the photo's wamid, inside the turn; a photo that cannot be kept gets its fixed notice", async () => {
    const kit = await pipelineKit();
    await rogelioWrote(kit);
    const evidence = pipelineEvidenceOutbound(kit.deps, kit.call.log);
    const ref = { ispId: ISP, clockId: CLOCK, installerId: "inst-rogelio", workOrderId: "wo-24817", messageId: PHOTO_WAMID, turnId: TURN, atSim: mx("2026-10-13 09:21"), correlationId: "corr-photo" };
    await evidence.reactToPhoto({ ...ref, emoji: "✅", verdict: "PASS", validationId: "val-0001" });
    await evidence.photoNotice({ ...ref, notice: "imageUnreadable" });
    expect(kit.sends[0]?.payload).toMatchObject({ type: "reaction", reaction: { message_id: PHOTO_WAMID } });
    const out = await outOf(kit);
    expect(out.find((message) => message.kind === "VERDICT_REACTION")).toMatchObject({ turnId: TURN, author: "SYSTEM" });
    expect(out.find((message) => message.kind === "SYSTEM_NOTICE")).toMatchObject({ turnId: TURN, text: esMX.imageUnreadable });
  });

  it("the worker's notice goes once per event and key, at the world's now", async () => {
    const kit = await pipelineKit();
    await rogelioWrote(kit);
    await kit.world.connector.runtime.createClock({ clockId: CLOCK, ispId: ISP, kind: "DEMO", mode: "PAUSED", offsetMs: 0, pausedSimNow: mx("2026-10-13 09:22"), worldEpoch: 1 });
    const notices = pipelineWorkerNotices(kit.deps, kit.call.log);
    const notice = { clockId: CLOCK, ispId: ISP, personId: "inst-rogelio", notice: "turnCap", text: esMX.turnCap, eventId: "wa-in-0001#retry", replyToMessageId: "wamid.SIM.02" } as const;
    await notices.send(notice);
    await notices.send(notice);
    expect(kit.sends).toHaveLength(1);
    expect((await outOf(kit))[0]).toMatchObject({ kind: "SYSTEM_NOTICE", text: esMX.turnCap, refs: { notice: "turnCap", replyTo: "wamid.SIM.02" } });
  });

  it("[FL-013] ORDER_CHOICE: a list with one row per pending order that remembers the message it asks about", async () => {
    const kit = await pipelineKit();
    await rogelioWrote(kit);
    const rows = ["24817", "24818"].map((number) => ({ title: `OT ${number}`, description: "9:00 a 11:00 · Las Lomitas", workOrderId: `wo-${number}`, action: "CHOOSE_ORDER" as const, object: { kind: "WORK_ORDER" as const, id: `wo-${number}` } }));
    const sent = await pipelineOrderChoice(kit.deps, kit.call.log).send({ clockId: CLOCK, installerId: "inst-rogelio", choice: { kind: "ORDER_CHOICE", body: esMX.orderChoicePrompt, rows, workOrderIds: ["wo-24817", "wo-24818"] }, sourceMessageId: "wamid.SIM.03", atSim: mx("2026-10-13 09:21"), eventId: "wa-in-0003" });
    expect(sent).toBe("SENT");
    expect(kit.sends[0]?.payload).toMatchObject({ type: "interactive", interactive: { type: "list" } });
    expect((await outOf(kit))[0]).toMatchObject({ kind: "ORDER_CHOICE", refs: { sourceMessageId: "wamid.SIM.03" } });
  });
});
