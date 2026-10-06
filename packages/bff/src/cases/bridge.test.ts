import { beforeEach, describe, expect, it } from "vitest";
import { CLOCK, installer, workOrder } from "../connector/testing";
import type { Case } from "../domain/cases";
import { closeCase, relayFromInstaller, relayFromSupervisor } from "./bridge";
import { runSupervisorAction } from "./events";
import { openCase } from "./open";
import { takeCase } from "./take";
import { type CaseKit, ORDER, caseKit, inbound, mx } from "./testing";

let kit: CaseKit;
let taken: Case;

const adriana = { via: "WHATSAPP" as const, supervisorId: "sup-adriana" };

async function takenCase(workOrderId: string, installerId: string): Promise<Case> {
  const opened = await openCase(kit.deps, { workOrderId, reason: "DIAGNOSIS_ATTEMPTS", summary: "Potencia fuera de rango.", atSim: mx("2026-10-13 11:50"), actor: "SYSTEM" });
  await inbound(kit.world, "sup-adriana", mx("2026-10-13 11:55"), { content: "BUTTON", buttonAction: "TAKE_CASE", messageId: `wamid.SIM.take.${installerId}` });
  return (await takeCase(kit.deps, { caseId: opened.caseItem.caseId, actor: adriana, atSim: mx("2026-10-13 11:55") })).caseItem;
}

function relays(personId: string) {
  return kit.outbound.sent.filter((record) => record.request.kind === "RELAY" && record.request.personId === personId);
}

beforeEach(async () => {
  kit = await caseKit();
  await inbound(kit.world, "inst-rogelio", mx("2026-10-13 11:45"));
  taken = await takenCase(ORDER, "inst-rogelio");
});

describe("[FL-056] the supervisor answers while the installer's window is open", () => {
  it("relays the masked text with the supervisor's name, as the supervisor, and reports the fix to the network", async () => {
    const message = await inbound(kit.world, "sup-adriana", mx("2026-10-13 12:05"), { text: "Cambia el conector de la roseta; si no, márcame al 5512345678" });
    expect(await relayFromSupervisor(kit.deps, taken.caseId, message)).toBe("RELAYED");
    const [relay] = relays("inst-rogelio");
    expect(relay?.outcome.status).toBe("SENT");
    expect(relay?.request.author).toBe("PERSON:sup-adriana");
    expect(relay?.request.form === "TEXT" && relay.request.text).toBe("Adriana (supervisor): Cambia el conector de la roseta; si no, márcame al [TELEFONO]");
    expect(kit.network.actions).toEqual([{ serial: "DEMO3F2C19A0", kind: "SUPERVISOR_FIX" }]);
    expect(kit.turns.queued).toEqual([]);
  });

  it("refuses a relay from a supervisor who does not hold the case", async () => {
    const message = await inbound(kit.world, "sup-hector", mx("2026-10-13 12:05"), { text: "Yo lo veo" });
    expect(await relayFromSupervisor(kit.deps, taken.caseId, message)).toBe("NOT_HOLDER");
    expect(relays("inst-rogelio")).toEqual([]);
  });
});

describe("[FL-057] the supervisor answers with the installer's window closed", () => {
  it("keeps the replies, sends respuesta_supervisor once and delivers them in order on Ver respuesta", async () => {
    const first = await inbound(kit.world, "sup-adriana", mx("2026-10-14 12:46"), { text: "Revisa el empalme de la caja" });
    const second = await inbound(kit.world, "sup-adriana", mx("2026-10-14 12:47"), { text: "Y luego mide otra vez" });
    expect(await relayFromSupervisor(kit.deps, taken.caseId, first)).toBe("PENDING");
    expect(await relayFromSupervisor(kit.deps, taken.caseId, second)).toBe("PENDING");
    const waiting = await kit.world.connector.cases.requireCase(taken.caseId);
    expect(waiting.bridge.pendingRelays.map((item) => item.messageId)).toEqual([first.messageId, second.messageId]);
    const templates = kit.outbound.sent.filter((record) => record.request.kind === "SUPERVISOR_REPLY_TEMPLATE");
    expect(templates.map((record) => [record.outcome.status, record.request.form === "TEMPLATE" ? record.request.params : []])).toEqual([["SENT", ["Adriana", "24818"]]]);
    expect(kit.network.actions).toEqual([]);

    const tap = await inbound(kit.world, "inst-rogelio", mx("2026-10-14 13:00"), { content: "BUTTON", buttonAction: "VIEW_REPLY" });
    expect(await relayFromInstaller(kit.deps, waiting, tap)).toBe("RELAYED");
    const delivered = relays("inst-rogelio").filter((record) => record.outcome.status === "SENT");
    expect(delivered.map((record) => (record.request.form === "TEXT" ? record.request.text : ""))).toEqual(["Adriana (supervisor): Revisa el empalme de la caja", "Adriana (supervisor): Y luego mide otra vez"]);
    expect((await kit.world.connector.cases.requireCase(taken.caseId)).bridge.pendingRelays).toEqual([]);
    expect(kit.network.actions.map((action) => action.kind)).toEqual(["SUPERVISOR_FIX"]);
  });
});

describe("[FL-058] the installer writes with the case taken", () => {
  it("relays text and photos to the supervisor and never to the agent; a photo is not validated", async () => {
    const text = await inbound(kit.world, "inst-rogelio", mx("2026-10-13 12:06"), { text: "Ya lo cambié, ¿le mido?" });
    expect(await relayFromInstaller(kit.deps, taken, text)).toBe("RELAYED");
    const photo = await inbound(kit.world, "inst-rogelio", mx("2026-10-13 12:07"), { content: "IMAGE", media: { kind: "IMAGE", s3Key: "sim/abc/upload-1", mime: "image/jpeg" } });
    expect(await relayFromInstaller(kit.deps, taken, photo)).toBe("RELAYED");
    const sent = relays("sup-adriana");
    expect(sent.map((record) => [record.request.form, record.outcome.status])).toEqual([
      ["TEXT", "SENT"],
      ["IMAGE", "SENT"],
    ]);
    expect(sent[0]?.request.form === "TEXT" && sent[0].request.text).toBe("Rogelio (instalador): Ya lo cambié, ¿le mido?");
    expect(sent[1]?.request.form === "IMAGE" && sent[1].request.media).toEqual({ bucket: "MEDIA", s3Key: "sim/abc/upload-1", mime: "image/jpeg" });
    expect(await kit.world.connector.workOrders.listValidations(ORDER)).toEqual([]);
  });
});

describe("[FL-063] closing the case returns the order to the agent", () => {
  it("closes the bridge, queues AGENT_TURN(CASE_CLOSED) with what was said and confirms to the supervisor", async () => {
    await relayFromSupervisor(kit.deps, taken.caseId, await inbound(kit.world, "sup-adriana", mx("2026-10-13 12:05"), { text: "Cambia el conector" }));
    await relayFromInstaller(kit.deps, taken, await inbound(kit.world, "inst-rogelio", mx("2026-10-13 12:08"), { text: "Listo, quedó en menos 22.1" }));
    const result = await closeCase(kit.deps, { caseId: taken.caseId, actor: adriana, atSim: mx("2026-10-13 12:10") });
    expect(result.outcome).toBe("CLOSED");
    expect(result.caseItem).toMatchObject({ status: "CLOSED", closedBy: "PERSON:sup-adriana", bridge: { open: false } });
    expect(kit.turns.queued).toEqual([
      expect.objectContaining({ caseId: taken.caseId, installerId: "inst-rogelio", workOrderId: ORDER, summary: "Adriana (supervisor): Cambia el conector / Rogelio (instalador): Listo, quedó en menos 22.1" }),
    ]);
    const confirmation = kit.outbound.sent.at(-1)?.request;
    expect(confirmation?.personId === "sup-adriana" && confirmation.kind).toBe("SYSTEM_NOTICE");
    expect(await kit.world.connector.cases.listTakenBy("sup-adriana")).toEqual([]);
  });

  it("refuses a close from a supervisor who does not hold it, and lifts the safety hold when a safety case closes", async () => {
    expect((await closeCase(kit.deps, { caseId: taken.caseId, actor: { via: "WHATSAPP", supervisorId: "sup-hector" }, atSim: mx("2026-10-13 12:10") })).outcome).toBe("NOT_HOLDER");
    await kit.world.connector.workOrders.setOnHoldSafety("wo-24817", true, { actor: "SYSTEM", atSim: mx("2026-10-13 09:30") });
    const safety = await openCase(kit.deps, { workOrderId: "wo-24817", reason: "SAFETY", hazardCategory: "ELECTRICAL", summary: "Cable pelado.", atSim: mx("2026-10-13 09:30"), actor: "SYSTEM" });
    await closeCase(kit.deps, { caseId: safety.caseItem.caseId, actor: { via: "CONSOLE", userId: "usr-adriana" }, atSim: mx("2026-10-13 10:00") });
    expect((await kit.world.connector.workOrders.requireWorkOrder("wo-24817")).onHoldSafety).toBe(false);
  });
});

describe("[FL-064] a supervisor with two cases taken", () => {
  it("relays to the installer of the case the supervisor chose, and to nobody else", async () => {
    await kit.world.connector.people.createPerson(installer({ personId: "inst-karina", firstName: "Karina", phone: "+525501010002", phoneHash: "d".repeat(64) }));
    await kit.world.connector.people.grantConsent({ personId: "inst-karina", clockId: CLOCK, medium: "SEED", textVersion: "v001" }, { actor: "SEED" });
    await kit.world.connector.workOrders.createWorkOrder(workOrder({ workOrderId: "wo-24819", workOrderNumber: "24819", customerId: "cust-10423", installerId: "inst-karina", status: "IN_PROGRESS" }));
    await inbound(kit.world, "inst-karina", mx("2026-10-13 11:46"));
    const other = await takenCase("wo-24819", "inst-karina");
    expect((await kit.world.connector.cases.listTakenBy("sup-adriana")).map((item) => item.caseId).sort()).toEqual([taken.caseId, other.caseId].sort());
    const reply = await inbound(kit.world, "sup-adriana", mx("2026-10-13 12:05"), { text: "Karina, revisa la roseta" });
    expect(await relayFromSupervisor(kit.deps, other.caseId, reply)).toBe("RELAYED");
    expect(relays("inst-karina")).toHaveLength(1);
    expect(relays("inst-rogelio")).toEqual([]);
  });
});

describe("[FL-056] [FL-063] supervisor actions from the installer's queue", () => {
  it("relays a supervisor's message and closes the case through the queued events", async () => {
    const message = await inbound(kit.world, "sup-adriana", mx("2026-10-13 12:05"), { text: "Cambia el conector" });
    const base = { eventId: "evt-sup-01", clockId: CLOCK, ispId: "isp-demo", installerId: "inst-rogelio", supervisorId: "sup-adriana", caseId: taken.caseId } as const;
    const ref = { personId: message.personId, sentAtSim: message.sentAtSim, messageId: message.messageId };
    expect(await runSupervisorAction(kit.deps, { ...base, type: "SUPERVISOR_ACTION", action: "RELAY", message: ref })).toBe("RELAYED");
    const tap = await inbound(kit.world, "sup-adriana", mx("2026-10-13 12:10"), { content: "BUTTON", buttonAction: "CLOSE_CASE" });
    expect(await runSupervisorAction(kit.deps, { ...base, type: "SUPERVISOR_ACTION", action: "CLOSE_CASE", message: { personId: tap.personId, sentAtSim: tap.sentAtSim, messageId: tap.messageId } })).toBe("CLOSED");
    const late = await inbound(kit.world, "sup-adriana", mx("2026-10-13 12:12"), { text: "¿Quedó?" });
    expect(await runSupervisorAction(kit.deps, { ...base, type: "SUPERVISOR_ACTION", action: "RELAY", message: { personId: late.personId, sentAtSim: late.sentAtSim, messageId: late.messageId } })).toBe("NO_CASE");
    expect(kit.outbound.sent.at(-1)?.request).toMatchObject({ personId: "sup-adriana", kind: "SYSTEM_NOTICE", notice: "supervisorNoCase" });
  });
});
