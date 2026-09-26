import { describe, expect, it } from "vitest";
import { esMX } from "../../copy/es-MX";
import { type ButtonActionEvent, runButtonAction } from "./button-actions";
import { processInboundEvent } from "./inbound";
import type { InstallerNotice, WorkOrderActions } from "./ports";
import { DEMO, PEOPLE, inboundHarness, liveEvent, nonceFor, recordingWorkOrderActions, waReply, waText } from "./testing";

const ROGELIO = PEOPLE.rogelio;

/** A tap through InboundWhatsApp, then the queued BUTTON_ACTION through the worker's handler. */
async function tapThenRun(action: "CONSULT_SUPERVISOR" | "CLOSE_INSTALLATION" | "CUSTOMER_OK", overrides: Partial<WorkOrderActions> = {}, offer?: string) {
  const h = await inboundHarness();
  const nonce = await nonceFor(h, "rogelio", action, { kind: "WORK_ORDER", id: "wo-24817" }, offer);
  await processInboundEvent(liveEvent({ messages: [waReply(ROGELIO.phone, `wamid.${action}`, nonce, "Botón")] }), h.deps);
  const [event] = h.rec.queued;
  if (event?.type !== "BUTTON_ACTION") throw new Error("expected a BUTTON_ACTION on the installer's queue");
  const notices: InstallerNotice[] = [];
  const run = (queued: ButtonActionEvent = event) =>
    runButtonAction(queued, { connector: h.world.connector, actions: recordingWorkOrderActions(h.rec, overrides), notices: { send: async (notice) => void notices.push(notice) } });
  return { h, event, notices, run };
}

describe("buttons on a work order, run by the InstallerWorker", () => {
  it("[FL-031] 'Consultar a mi supervisor' opens the OUT_OF_MANUAL case with the last question (masked) and the offer's sections, no turn", async () => {
    const h = await inboundHarness();
    const conversations = h.world.connector.conversations;
    await processInboundEvent(liveEvent({ messages: [waText(ROGELIO.phone, "wamid.Q1", "¿Se cobra la roseta en otro cuarto? mi tel 5512345678")] }), h.deps);
    await conversations.appendMessage({
      messageId: "msg-offer-0001",
      personId: ROGELIO.personId,
      ispId: "isp-demo",
      clockId: DEMO,
      direction: "OUT",
      channel: "WHATSAPP",
      content: "INTERACTIVE",
      kind: "REPLY",
      status: "SENT",
      author: "AGENT",
      simulated: false,
      sentAtSim: "2026-10-13T07:05:00-06:00",
      refs: { citations: ["COM-04"] },
    });
    const nonce = await nonceFor(h, "rogelio", "CONSULT_SUPERVISOR", { kind: "WORK_ORDER", id: "wo-24817" }, "msg-offer-0001");
    h.rec.queued.length = 0;
    await processInboundEvent(liveEvent({ messages: [waReply(ROGELIO.phone, "wamid.Q2", nonce, "Consultar supervisor")] }), h.deps);
    const [event] = h.rec.queued;
    if (event?.type !== "BUTTON_ACTION") throw new Error("expected a BUTTON_ACTION");
    const outcome = await runButtonAction(event, { connector: h.world.connector, actions: recordingWorkOrderActions(h.rec), notices: { send: async () => undefined } });
    expect(outcome).toBe("CASE_OPENED");
    expect(h.rec.actions).toMatchObject([
      {
        name: "openConsultCase",
        input: { workOrderId: "wo-24817", personId: ROGELIO.personId, clockId: DEMO, sourceMessageId: "wamid.Q2", eventId: event.eventId, citations: ["COM-04"], question: "¿Se cobra la roseta en otro cuarto? mi tel [TELEFONO]" },
      },
    ]);
  });

  it("[FL-047] 'Cerrar instalación' calls close_installation with the tap's instant and event id; closed, no notice", async () => {
    const { h, event, notices, run } = await tapThenRun("CLOSE_INSTALLATION");
    expect(await run()).toBe("INSTALLATION_CLOSED");
    expect(h.rec.actions).toMatchObject([{ name: "closeInstallation", input: { workOrderId: "wo-24817", personId: ROGELIO.personId, atSim: event.message.sentAtSim, sourceMessageId: "wamid.CLOSE_INSTALLATION", eventId: event.eventId } }]);
    expect(notices).toEqual([]);
  });

  it("[FL-050] NOT_COMPLETE: the worker answers the fixed closeNotComplete with the missing items, replying to the tap", async () => {
    const { event, notices, run } = await tapThenRun("CLOSE_INSTALLATION", { closeInstallation: async () => ({ ok: false, code: "NOT_COMPLETE", missing: ["ROSETTE_PHOTO", "CUSTOMER_OK"] }) });
    expect(await run()).toBe("CLOSE_NOT_COMPLETE");
    expect(notices).toEqual([
      {
        clockId: DEMO,
        ispId: "isp-demo",
        personId: ROGELIO.personId,
        notice: "closeNotComplete",
        text: esMX.closeNotComplete(["ROSETTE_PHOTO", "CUSTOMER_OK"]),
        replyToWamid: event.message.messageId,
        refs: { items: ["ROSETTE_PHOTO", "CUSTOMER_OK"], workOrderId: "wo-24817" },
      },
    ]);
    expect(JSON.stringify(event)).not.toContain(ROGELIO.phone.slice(1));
  });

  it("[FL-047] a close that fails for another reason sends nothing; 'Cliente conforme' records the customer's OK", async () => {
    const failed = await tapThenRun("CLOSE_INSTALLATION", { closeInstallation: async () => ({ ok: false, code: "FAILED" }) });
    expect(await failed.run()).toBe("CLOSE_FAILED");
    expect(failed.notices).toEqual([]);
    const ok = await tapThenRun("CUSTOMER_OK");
    expect(await ok.run()).toBe("CUSTOMER_OK");
    expect(ok.h.rec.actions).toMatchObject([{ name: "recordCustomerOk", input: { workOrderId: "wo-24817", personId: ROGELIO.personId } }]);
  });
});
