// Area G (and FL-006, FL-023, FL-024, FL-074, FL-075) · Escalation and supervisors (docs/flows-catalog.md),
// in process: cases opened by the agent's tools, by the code or by the world factory's `case` preset, the
// ladder through the pipeline and its policy (templates, interactives, the zone chief's email), the
// supervisors' buttons and texts through `InboundWhatsApp` and the installer queue, the timeouts the clock
// fires and the bridge between the supervisor and the installer.
import { describe, expect, it } from "vitest";
import { READ_ONU, escalate, reply, search, troubleshooting } from "./support/agent";
import { CASE_CLOSED_RESUME } from "./support/story";
import { createFlowWorld, type FlowWorld } from "./support/world";

const SUMMARY = "El instalador pide hablar con su supervisora sobre la orden.";

async function onOrder(world: FlowWorld, installerId: string, workOrderId: string, time: string): Promise<void> {
  await world.at(time);
  await world.data.worlds.setActiveWorkOrder(installerId, world.clockId, workOrderId, await world.simNow());
}

/** Rogelio asks for his supervisor at `time` on 24818: the agent escalates (FL-024). */
async function escalated(time = "11:50", workOrderId = "wo-24818", world?: FlowWorld): Promise<FlowWorld> {
  const target = world ?? (await createFlowWorld());
  await onOrder(target, "inst-rogelio", workOrderId, time);
  target.plan({ steps: [escalate("INSTALLER_ASKED", SUMMARY), reply("Listo, le avisé a tu supervisora de turno.")] });
  await target.voice("inst-rogelio", "vn-08");
  return target;
}

const caseOf = async (world: FlowWorld, workOrderId = "wo-24818") => {
  const [caseItem, ...others] = await world.data.cases.listCasesOfWorkOrder(workOrderId);
  expect(others).toEqual([]);
  if (caseItem === undefined) throw new Error(`no case on ${workOrderId}`);
  return caseItem;
};
const timeouts = async (world: FlowWorld, caseId: string) => (await world.data.timers.listTimers({ kind: "CASE", id: caseId })).filter((timer) => timer.kind === "CASE_TIMEOUT");

describe("case flows", () => {
  it("[FL-024] [FL-054] the installer asks for his supervisor: INSTALLER_ASKED case, caso_escalado to the supervisor on duty, its timeout armed and the notice", async () => {
    const world = await escalated();
    const caseItem = await caseOf(world);
    expect(caseItem).toMatchObject({ reason: "INSTALLER_ASKED", rung: "PRIMARY", status: "OPEN" });
    expect(caseItem.ladder.map((entry) => [entry.rung, entry.outcome, entry.personId])).toEqual([["PRIMARY", "NOTIFIED", "sup-adriana"]]);
    const [request] = await world.delivered("sup-adriana", "CASE_REQUEST");
    expect(request).toMatchObject({ templateName: "caso_escalado" });
    expect(await world.delivered("inst-rogelio", "CASE_NOTICE")).toHaveLength(1);
    expect((await timeouts(world, caseItem.caseId)).map((timer) => [timer.status, timer.dueAtSim])).toEqual([["SCHEDULED", "2026-10-13T18:00:00.000Z"]]);
    const said = (await world.delivered("inst-rogelio")).map((message) => message.text ?? "").join("\n");
    expect(said).not.toMatch(/ya (te )?atendi|ya lo revis/i);
  });

  it("[FL-023] the third failed attempt of the same symptom opens one DIAGNOSIS_ATTEMPTS case by code, and the agent learns it", async () => {
    const world = await createFlowWorld();
    await onOrder(world, "inst-rogelio", "wo-24818", "11:50");
    const attempt = { steps: [READ_ONU, search("potencia fuera de rango, conectores y empalmes", "DIAG"), troubleshooting("LOW_POWER", "DIAG-03", "NO_CHANGE"), reply("La potencia sigue baja, revisemos otra vez los conectores.")] };
    world.plan(attempt, attempt, attempt);
    for (let index = 0; index < 3; index += 1) await world.voice("inst-rogelio", "vn-04");
    const outputs = world.harness.turns.map((turn) => turn.calls[2]?.output as unknown as { failedAttempts: number; caseOpened?: { reason: string } });
    expect(outputs.map((output) => output.failedAttempts)).toEqual([1, 2, 3]);
    expect(outputs[2]?.caseOpened?.reason).toBe("DIAGNOSIS_ATTEMPTS");
    expect((await caseOf(world)).reason).toBe("DIAGNOSIS_ATTEMPTS");
    world.plan({ steps: [reply("Tu caso ya está con tu supervisora de turno.")] });
    await world.text("inst-rogelio", "¿Y ahora qué hago?");
    expect(JSON.stringify(world.harness.turns[3]?.envelope.preloaded.get_work_order)).toContain("DIAGNOSIS_ATTEMPTS");
  });

  it("[FL-006] a supervisor who opted out is skipped (OPTED_OUT) and the case goes to the backup without a message to her", async () => {
    const world = await createFlowWorld();
    await world.at("07:10");
    await world.text("sup-adriana", "BAJA");
    await escalated("11:50", "wo-24818", world);
    const caseItem = await caseOf(world);
    expect(caseItem.ladder.map((entry) => [entry.rung, entry.outcome, entry.reason ?? null])).toEqual([
      ["PRIMARY", "SKIPPED", "OPTED_OUT"],
      ["SECONDARY", "NOTIFIED", null],
    ]);
    expect(await world.delivered("sup-adriana", "CASE_REQUEST")).toEqual([]);
    expect((await world.delivered("sup-hector")).map((message) => message.kind)).toContain("CASE_REQUEST");
  });

  it("[FL-055] taking the case: TAKEN by the supervisor, the timeout cancelled, the brief to her and the notice to the installer", async () => {
    const world = await escalated();
    await world.tap("sup-adriana", "TAKE_CASE");
    const caseItem = await caseOf(world);
    expect(caseItem).toMatchObject({ status: "TAKEN", takenBy: "sup-adriana" });
    expect(caseItem.bridge.open).toBe(true);
    expect((await world.data.cases.listTakenBy("sup-adriana")).map((taken) => taken.caseId)).toEqual([caseItem.caseId]);
    expect((await timeouts(world, caseItem.caseId)).map((timer) => timer.status)).toEqual(["CANCELLED"]);
    const [brief] = await world.delivered("sup-adriana", "CASE_BRIEF");
    expect(brief?.text).toContain("24818");
    expect(await world.delivered("inst-rogelio", "CASE_NOTICE")).toHaveLength(2);
  });

  it("[FL-056] [FL-058] the bridge: the supervisor's text reaches the installer as a relay, and the installer's text and photo reach her, with no agent turn", async () => {
    const world = await escalated();
    await world.tap("sup-adriana", "TAKE_CASE");
    await world.text("sup-adriana", "Cambia el conector de la roseta y vuelve a medir.");
    const [relay] = await world.delivered("inst-rogelio", "RELAY");
    expect(relay).toMatchObject({ author: "PERSON:sup-adriana" });
    expect(relay?.text).toContain("Adriana");
    const turns = world.harness.turns.length;
    await world.text("inst-rogelio", "Ya lo cambié, ¿mido otra vez?");
    await world.photo("inst-rogelio", "ph-meter-03");
    expect(world.harness.turns).toHaveLength(turns);
    const toSupervisor = await world.delivered("sup-adriana", "RELAY");
    expect(toSupervisor.map((message) => message.content)).toEqual(["TEXT", "IMAGE"]);
    expect(await world.data.workOrders.listValidations("wo-24818")).toEqual([]);
  });

  it("[FL-057] with the installer's window closed the relay waits, respuesta_supervisor goes out and 'Ver respuesta' delivers what was pending", async () => {
    const world = await createFlowWorld();
    await onOrder(world, "inst-rogelio", "wo-24818", "18:00");
    await world.preset("wo-24818", { case: { reason: "INSTALLER_ASKED", rung: "PRIMARY", status: "TAKEN" } });
    await world.text("sup-adriana", "Mañana temprano revisa el conector de la roseta.");
    const caseItem = await caseOf(world);
    expect(caseItem.bridge.pendingRelays).toHaveLength(1);
    expect(await world.delivered("inst-rogelio", "RELAY")).toEqual([]);
    const [template] = (await world.delivered("inst-rogelio")).filter((message) => message.templateName === "respuesta_supervisor");
    expect(template).toBeDefined();
    await world.tap("inst-rogelio", "VIEW_REPLY");
    expect(await world.delivered("inst-rogelio", "RELAY")).toHaveLength(1);
    expect((await caseOf(world)).bridge.pendingRelays).toEqual([]);
  });

  it("[FL-059] 'No puedo' passes the case to the backup at once: caso_reasignado, the first timeout cancelled and the second armed", async () => {
    const world = await escalated();
    await world.tap("sup-adriana", "DECLINE_CASE");
    const caseItem = await caseOf(world);
    expect(caseItem.rung).toBe("SECONDARY");
    expect(caseItem.ladder.map((entry) => [entry.rung, entry.outcome])).toEqual([
      ["PRIMARY", "NOTIFIED"],
      ["PRIMARY", "DECLINED"],
      ["SECONDARY", "NOTIFIED"],
    ]);
    expect((await world.delivered("sup-hector", "CASE_REQUEST")).map((message) => message.templateName)).toEqual(["caso_reasignado"]);
    expect((await timeouts(world, caseItem.caseId)).map((timer) => timer.status).sort()).toEqual(["CANCELLED", "SCHEDULED"]);
  });

  it("[FL-060] [FL-061] the timeouts move the case to the backup and then alert the zone chief by email; no more timers", async () => {
    const world = await escalated();
    const moved = await world.advance({ next: true });
    expect(moved.fired.map((fired) => fired.kind)).toEqual(["CASE_TIMEOUT"]);
    let caseItem = await caseOf(world);
    expect(caseItem.rung).toBe("SECONDARY");
    expect(caseItem.ladder.map((entry) => [entry.rung, entry.outcome])).toEqual([
      ["PRIMARY", "NOTIFIED"],
      ["PRIMARY", "TIMED_OUT"],
      ["SECONDARY", "NOTIFIED"],
    ]);
    expect((await world.delivered("sup-hector", "CASE_REQUEST")).map((message) => message.templateName)).toEqual(["caso_reasignado"]);
    expect((await world.delivered("inst-rogelio", "CASE_NOTICE")).length).toBeGreaterThanOrEqual(2);
    await world.advance({ next: true });
    caseItem = await caseOf(world);
    expect(caseItem).toMatchObject({ rung: "ZONE_CHIEF", status: "OPEN" });
    const alert = world.ses.sent.filter((mail) => mail.tags.kind === "ZONE_CHIEF_ALERT");
    expect(alert.map((mail) => mail.to)).toEqual(["success+zc-marisol@simulator.amazonses.com"]);
    expect((await world.data.conversations.listOutbox("isp-demo")).filter((mail) => mail.kind === "ZONE_CHIEF_ALERT").map((mail) => mail.status)).toEqual(["DELIVERED"]);
    expect((await timeouts(world, caseItem.caseId)).filter((timer) => timer.status === "SCHEDULED")).toEqual([]);
  });

  it("[FL-062] a late take wins while the case is open; the other supervisor loses it (CASE_TAKE_LOST) and a closed case's button gets the fixed notice", async () => {
    const world = await escalated();
    await world.advance({ next: true });
    await world.tap("sup-adriana", "TAKE_CASE");
    await world.tap("sup-hector", "TAKE_CASE");
    const caseItem = await caseOf(world);
    expect(caseItem).toMatchObject({ status: "TAKEN", takenBy: "sup-adriana" });
    expect((await world.decisions()).filter((decision) => decision.action === "CASE_TAKE_LOST")).toHaveLength(1);
    expect((await world.delivered("sup-hector")).at(-1)?.text).toContain("Adriana");
    await world.tap("sup-adriana", "CLOSE_CASE");
    const notices = (await world.delivered("sup-hector", "SYSTEM_NOTICE")).length;
    await world.tap("sup-hector", "TAKE_CASE");
    expect((await world.delivered("sup-hector", "SYSTEM_NOTICE")).length).toBe(notices + 1);
  });

  it("[FL-063] closing the case closes the bridge and the agent resumes in a CASE_CLOSED turn", async () => {
    const world = await escalated();
    await world.tap("sup-adriana", "TAKE_CASE");
    await world.text("sup-adriana", "Ya corregí la potencia desde la central.");
    world.plan(CASE_CLOSED_RESUME);
    await world.tap("sup-adriana", "CLOSE_CASE");
    const caseItem = await caseOf(world);
    expect(caseItem).toMatchObject({ status: "CLOSED", closedBy: "PERSON:sup-adriana" });
    expect(caseItem.bridge.open).toBe(false);
    const turn = world.harness.turns.at(-1);
    expect(turn?.envelope.event.type).toBe("CASE_CLOSED");
    expect((await world.delivered("inst-rogelio", "REPLY")).at(-1)?.text).toMatch(/foto del medidor/);
  });

  it("[FL-064] a supervisor with two taken cases picks one in a list before her text is relayed", async () => {
    const world = await createFlowWorld();
    await world.at("11:50");
    await world.preset("wo-24818", { case: { reason: "INSTALLER_ASKED", rung: "PRIMARY", status: "TAKEN" } });
    await world.preset("wo-24820", { case: { reason: "INSTALLER_ASKED", rung: "PRIMARY", status: "TAKEN" } });
    await world.text("sup-adriana", "Revisa el conector y mándame foto.");
    expect(await world.delivered("inst-rogelio", "RELAY")).toEqual([]);
    expect(await world.delivered("inst-karina", "RELAY")).toEqual([]);
    await world.tap("sup-adriana", { title: "24820" });
    expect(await world.delivered("inst-karina", "RELAY")).toHaveLength(1);
    expect(await world.delivered("inst-rogelio", "RELAY")).toEqual([]);
  });

  it("[FL-066] with no reachable supervisor both rungs are skipped and the zone chief is alerted at once, with no timer", async () => {
    const world = await createFlowWorld();
    await world.at("07:10");
    await world.text("sup-adriana", "BAJA");
    await world.text("sup-hector", "BAJA");
    await escalated("11:50", "wo-24818", world);
    const caseItem = await caseOf(world);
    expect(caseItem.ladder.map((entry) => [entry.rung, entry.outcome])).toEqual([
      ["PRIMARY", "SKIPPED"],
      ["SECONDARY", "SKIPPED"],
      ["ZONE_CHIEF", "NOTIFIED"],
    ]);
    expect(world.ses.sent.filter((mail) => mail.tags.kind === "ZONE_CHIEF_ALERT")).toHaveLength(1);
    expect((await timeouts(world, caseItem.caseId)).filter((timer) => timer.status === "SCHEDULED")).toEqual([]);
  });

  it("[FL-074] [FL-075] with caso_escalado not approved: plan B by TURNO sends the interactive; the backup without TURNO is skipped NO_CHANNEL", async () => {
    const world = await createFlowWorld();
    await world.data.isps.setTemplateStatus("isp-demo", "caso_escalado", "REJECTED", { actor: "QA", atSim: await world.simNow() });
    await world.data.isps.setTemplateStatus("isp-demo", "caso_reasignado", "REJECTED", { actor: "QA", atSim: await world.simNow() });
    await world.at("07:05");
    await world.text("sup-adriana", "TURNO");
    expect(await world.data.people.getShiftWindow("sup-adriana")).toBeDefined();
    await escalated("11:50", "wo-24818", world);
    const [request] = await world.delivered("sup-adriana", "CASE_REQUEST");
    expect(request?.content).toBe("INTERACTIVE");
    const decisions = (await world.decisions()).filter((decision) => decision.refs.caseId !== undefined && decision.action === "SEND_WHATSAPP");
    expect(decisions.map((decision) => [decision.decision, decision.ruleIds[0] ?? null]).slice(0, 2)).toEqual([
      ["DENY", "CP-TEMPLATE-APPROVED"],
      ["ALLOW", decisions[1]?.ruleIds[0] ?? null],
    ]);
    await world.tap("sup-adriana", "DECLINE_CASE");
    const caseItem = await caseOf(world);
    expect(caseItem.ladder.find((entry) => entry.rung === "SECONDARY")).toMatchObject({ outcome: "SKIPPED", reason: "NO_CHANNEL" });
    expect(caseItem.rung).toBe("ZONE_CHIEF");
    expect(world.ses.sent.filter((mail) => mail.tags.kind === "ZONE_CHIEF_ALERT")).toHaveLength(1);
  });
});
