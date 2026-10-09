// Area H · Physical safety (docs/flows-catalog.md FL-067 to FL-071), in process: the lexicon classifier of
// the worker before G1 and the agent, the fixed §SEG-01 instruction through the pipeline, the order on hold,
// the `SAFETY` case with the alert to the supervisor on duty and the zone chief's email at once, the agent's
// `report_safety_hazard` for what the lexicon does not know, and quiet hours that never hold it back.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { esMX } from "../../packages/bff/src/copy/es-MX";
import { READ_ORDER, hazard, reply, troubleshooting, workOrderOf } from "./support/agent";
import { createFlowWorld, type FlowWorld } from "./support/world";

const SEG_01 = readFileSync(join(import.meta.dirname, "../../scripts/seed/data/manual/v001/SEG-01.md"), "utf8");

async function atThirdVisit(time = "15:10"): Promise<FlowWorld> {
  const world = await createFlowWorld();
  await world.at(time);
  await world.data.worlds.setActiveWorkOrder("inst-rogelio", world.clockId, "wo-24819", await world.simNow());
  return world;
}

async function expectSafetyHandled(world: FlowWorld, detectedBy: "LEXICON" | "AGENT"): Promise<void> {
  const [instruction, ...more] = await world.delivered("inst-rogelio", "SAFETY_INSTRUCTION");
  expect(more).toEqual([]);
  expect(instruction?.text).toBe(esMX.safetyInstruction);
  expect((await world.data.workOrders.getWorkOrder("wo-24819"))?.onHoldSafety).toBe(true);
  expect((await world.data.cases.listCasesOfWorkOrder("wo-24819")).map((caseItem) => caseItem.reason)).toEqual(["SAFETY"]);
  const detected = (await world.decisions()).filter((decision) => decision.action === "SAFETY_DETECTED");
  expect(detected.map((decision) => decision.detail?.detectedBy)).toEqual([detectedBy]);
}

describe("safety flows", () => {
  it("[FL-067] an electrical hazard gets the fixed §SEG-01 instruction at once, written by the code, and the order goes on hold", async () => {
    const world = await atThirdVisit();
    const sent = await world.text("inst-rogelio", "Hay un cable pelado en el poste, está chispeando");
    await expectSafetyHandled(world, "LEXICON");
    expect(SEG_01).toContain(esMX.safetyInstruction);
    const [inbound] = (await world.thread("inst-rogelio")).filter((message) => message.messageId === sent.wamid);
    const [instruction] = await world.delivered("inst-rogelio", "SAFETY_INSTRUCTION");
    expect(Date.parse(instruction?.sentAtReal ?? "") - Date.parse(inbound?.sentAtReal ?? "")).toBeLessThan(10_000);
    // The instruction is the code's (author SYSTEM, text of copy/), never something the agent wrote.
    expect(instruction?.author).not.toBe("AGENT");
    expect(world.harness.turns.flatMap((turn) => turn.calls).filter((call) => JSON.stringify(call.input).includes("Detén el trabajo"))).toEqual([]);
  });

  it("[FL-068] the SAFETY case alerts the supervisor on duty (alerta_seguridad) and the zone chief by email in parallel, measured from the inbound", async () => {
    const world = await atThirdVisit();
    await world.text("inst-rogelio", "Hay un cable pelado en el poste, está chispeando");
    const [alert] = (await world.delivered("sup-adriana")).filter((message) => message.templateName === "alerta_seguridad");
    expect(alert).toBeDefined();
    const mails = world.ses.sent.filter((mail) => mail.tags.kind === "ZONE_CHIEF_ALERT");
    expect(mails.map((mail) => mail.to)).toEqual(["success+zc-marisol@simulator.amazonses.com"]);
    const latency = world.logs.find((line) => line.metric === "SafetyAlertLatency");
    expect(typeof latency?.value).toBe("number");
    expect(Number(latency?.value)).toBeLessThan(60_000);
    const caseItem = (await world.data.cases.listCasesOfWorkOrder("wo-24819"))[0];
    expect((await world.data.timers.listTimers({ kind: "CASE", id: caseItem?.caseId ?? "" })).some((timer) => timer.kind === "CASE_TIMEOUT" && timer.status === "SCHEDULED")).toBe(true);
  });

  it("[FL-069] a hazard outside the lexicon is reported by the agent and handled the same way", async () => {
    const world = await atThirdVisit();
    world.plan({ steps: [hazard("ANIMAL", "Panal de avispas dentro de la caja terminal; el instalador fue picado.")] });
    await world.voice("inst-rogelio", "vn-12");
    expect(world.harness.turns[0]?.calls[0]?.output).toMatchObject({ ok: true, instructionSent: true });
    await expectSafetyHandled(world, "AGENT");
  });

  it("[FL-070] a hazard reported by voice note is classified on the transcript and handled like FL-067", async () => {
    const world = await atThirdVisit();
    await world.voice("inst-rogelio", "vn-05");
    expect(world.transcribe.started).toHaveLength(1);
    await expectSafetyHandled(world, "LEXICON");
  });

  it("[FL-071] (a) an ambiguous phrase is treated as a hazard and (b) at 21:30 it still goes out, quiet hours exempt", async () => {
    const world = await atThirdVisit("21:30");
    await world.text("inst-rogelio", "el cable está pelado");
    await expectSafetyHandled(world, "LEXICON");
    const [instruction] = await world.delivered("inst-rogelio", "SAFETY_INSTRUCTION");
    const decision = (await world.decisions()).find((entry) => entry.messageId === instruction?.messageId);
    expect(decision?.evaluated.find((rule) => rule.ruleId === "CP-QUIET-HOURS")?.result).not.toBe("FAIL");
    expect((await world.delivered("sup-adriana")).some((message) => message.templateName === "alerta_seguridad")).toBe(true);
  });

  it("[FL-071] (c) while the order is on hold the agent reads it and guides no work: no troubleshooting step is recorded", async () => {
    const world = await atThirdVisit();
    await world.text("inst-rogelio", "Hay un cable pelado en el poste, está chispeando");
    world.plan({
      steps: [
        READ_ORDER,
        { ...troubleshooting("NO_POWER", "DIAG-01", "PENDING"), when: (context) => workOrderOf(context).onHoldSafety !== true },
        reply("La orden está detenida por seguridad; espera a que tu supervisora cierre el caso."),
      ],
    });
    await world.text("inst-rogelio", "Ya se fueron los de la luz, ¿sigo con la instalación?");
    expect((world.harness.turns.at(-1)?.calls[0]?.output as unknown as { workOrder: { onHoldSafety: boolean } }).workOrder.onHoldSafety).toBe(true);
    expect(await world.data.workOrders.listSteps("wo-24819")).toEqual([]);
    expect(await world.delivered("inst-rogelio", "SAFETY_INSTRUCTION")).toHaveLength(1);
  });
});
