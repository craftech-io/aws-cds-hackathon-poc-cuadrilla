import { describe, expect, it } from "vitest";
import { sendOutbound } from "./pipeline";
import { contentKeyOf } from "./repeat";
import { TURN, agentReply, mx, pipelineKit, rogelioWrote } from "./testing";

const TEXT = "Va, ya quedó tu orden 24817 en curso.";
const ORDER = { workOrderNumber: "24817" };

describe("[FL-093] the same send asked twice in one turn goes out once", () => {
  it("[FL-093] same turn, channel and text: the second request returns the first message without calling the transport", async () => {
    const kit = await pipelineKit();
    await rogelioWrote(kit);
    await kit.result("get_work_order", ORDER);
    const first = await sendOutbound(kit.deps, agentReply(TEXT), kit.call);
    const second = await sendOutbound(kit.deps, agentReply(TEXT), kit.call);
    expect(first.status).toBe("SENT");
    expect(second).toMatchObject({ status: "SENT", messageId: first.status === "SENT" ? first.messageId : "", replayOf: first.status === "SENT" ? first.messageId : "" });
    expect(kit.sends).toHaveLength(1);
    const thread = await kit.world.connector.conversations.listMessages("inst-rogelio");
    expect(thread.filter((message) => message.direction === "OUT")).toHaveLength(1);
    expect(kit.logs.some((line) => line.message === "outbound.repeated_in_turn")).toBe(true);
  });

  it("[FL-093] same template with the same parameters in one turn: one send", async () => {
    const kit = await pipelineKit();
    const notice = (messageId?: string) => ({
      channel: "WHATSAPP" as const,
      personId: "inst-rogelio",
      kind: "SUPERVISOR_REPLY_TEMPLATE" as const,
      author: "SYSTEM",
      eventAtSim: mx("2026-10-13 12:10"),
      turnId: TURN,
      workOrderId: "wo-24818",
      caseId: "case-01J9ZQX0000000000000000000",
      template: { name: "respuesta_supervisor" as const, params: ["Héctor", "24818"] },
      ...(messageId === undefined ? {} : { messageId }),
    });
    const first = await sendOutbound(kit.deps, notice(), kit.call);
    const second = await sendOutbound(kit.deps, notice(), kit.call);
    expect(first.status).toBe("SENT");
    expect(second).toMatchObject({ status: "SENT", replayOf: first.status === "SENT" ? first.messageId : "" });
    expect(kit.sends).toHaveLength(1);
  });

  it("[FL-093] another text, another turn or another template goes out", async () => {
    const kit = await pipelineKit();
    await rogelioWrote(kit);
    await kit.result("get_work_order", ORDER);
    await sendOutbound(kit.deps, agentReply(TEXT), kit.call);
    await sendOutbound(kit.deps, agentReply("Mándame la foto de la etiqueta de la ONU."), kit.call);
    await kit.world.connector.runtime.putTurnResult("01JB8Z9Q2W3E4R5T6Y7V8XOTHR", "get_work_order", ORDER);
    await sendOutbound(kit.deps, agentReply(TEXT, { turnId: "01JB8Z9Q2W3E4R5T6Y7V8XOTHR" }), kit.call);
    expect(kit.sends).toHaveLength(3);
    expect(contentKeyOf({ kind: "REPLY", template: { name: "respuesta_supervisor", params: ["Héctor", "24818"] } })).not.toBe(contentKeyOf({ kind: "REPLY", template: { name: "respuesta_supervisor", params: ["Adriana", "24818"] } }));
  });

  it("[FL-093] a redelivered request with its derived id is answered from the stored message", async () => {
    const kit = await pipelineKit();
    await rogelioWrote(kit);
    await kit.result("get_work_order", ORDER);
    const first = await sendOutbound(kit.deps, agentReply(TEXT, { messageId: "msg-derived-0001" }), kit.call);
    const again = await sendOutbound(kit.deps, agentReply(TEXT, { messageId: "msg-derived-0001", turnId: "01JB8Z9Q2W3E4R5T6Y7V8XOTHR" }), kit.call);
    expect(first).toMatchObject({ status: "SENT", messageId: "msg-derived-0001" });
    expect(again).toMatchObject({ status: "SENT", messageId: "msg-derived-0001", replayOf: "msg-derived-0001" });
    expect(kit.sends).toHaveLength(1);
  });
});
