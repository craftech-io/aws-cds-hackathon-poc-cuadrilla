// The agent steps of SC-02 (voice and diagnosis) on the local world, each on the order the local flows use
// for it (tests/flows/diagnosis.flow.test.ts and cases.flow.test.ts). Oracles of scripts/scenarios/sc-02:
// tools called, the cited section, steps, checklist and cases, and no figure the turn never read; every
// accepted alternative of §4.3 (a WORSE step, a case OTHER) passes too.
import { describe, expect, it } from "vitest";
import { callsOf, toolsOf, turnsSummary, useAgentWorld } from "../support/agent-world";
import { PHOTO_ITEMS, citesAny, cutTurns, dirtyOutbound, failedTurns, foreignOrderNumbers, itemStatus, onOrder, refList, repliesTo } from "../support/oracles";

const worlds = useAgentWorld();

describe("SC-02 · voice and diagnosis (agent)", () => {
  it("[SC-02/2-3] [FL-019] [FL-020] vn-01 → get_onu_status LOS and §DIAG-02 with the step PENDING; vn-02 → ONLINE, ONU_ONLINE PASSED and the three photos asked", async () => {
    const { flow, agent } = await worlds.open();
    await onOrder(flow, "inst-rogelio", "wo-24817", "09:20");

    await flow.voice("inst-rogelio", "vn-01");

    expect(toolsOf(agent.turns.at(-1)), turnsSummary(agent.turns)).toContain("get_onu_status");
    const first = (await repliesTo(flow, "inst-rogelio")).at(-1);
    expect(citesAny(first, ["DIAG-02"]), `${first?.text ?? "no reply"} · ${turnsSummary(agent.turns)}`).toBe(true);
    expect((await flow.data.workOrders.listSteps("wo-24817")).some((step) => step.stepRef.startsWith("DIAG-02") && step.outcome === "PENDING"), "a DIAG-02 step PENDING").toBe(true);

    await flow.voice("inst-rogelio", "vn-02");

    expect(await itemStatus(flow, "wo-24817", "ONU_ONLINE"), turnsSummary(agent.turns)).toBe("PASSED");
    expect((await flow.data.workOrders.requireWorkOrder("wo-24817")).lastOnuReading?.operState).toBe("ONLINE");
    const asked = (await repliesTo(flow, "inst-rogelio")).flatMap((reply) => refList(reply, "items"));
    expect(PHOTO_ITEMS.every((item) => asked.includes(item)), `items asked: ${asked.join(", ")}`).toBe(true);
    expect(await cutTurns(flow, "inst-rogelio")).toBe(0);
    expect(await dirtyOutbound(flow, "inst-rogelio")).toEqual([]);
  });

  it("[SC-02/7] [FL-023] LOW_POWER: three \"sigue igual\" (the last one vn-04) → exactly one DIAGNOSIS_ATTEMPTS case, or none when the agent recorded WORSE", async () => {
    const { flow, agent } = await worlds.open();
    await onOrder(flow, "inst-rogelio", "wo-24818", "11:50");

    for (const text of ["La ONU tiene potencia muy baja, ¿qué reviso?", "Ya limpié el conector y sigue igual", "Revisé la curvatura del cable y sigue igual"]) await flow.text("inst-rogelio", text);
    await flow.voice("inst-rogelio", "vn-04");

    const worse = (await flow.data.workOrders.listSteps("wo-24818")).some((step) => step.outcome === "WORSE");
    const cases = (await flow.data.cases.listCasesOfWorkOrder("wo-24818")).filter((entry) => entry.reason === "DIAGNOSIS_ATTEMPTS");
    expect(cases, turnsSummary(agent.turns)).toHaveLength(worse && cases.length === 0 ? 0 : 1);
    expect(await itemStatus(flow, "wo-24818", "ONU_ONLINE"), "ONU_ONLINE with the power out of range").not.toBe("PASSED");
    expect(await dirtyOutbound(flow, "inst-rogelio")).toEqual([]);
  });

  it("[SC-02/8] [FL-022] NOT_PROVISIONED: two readings in a row → one case (NOT_PROVISIONED by code, or OTHER by the agent)", async () => {
    const { flow, agent } = await worlds.open();
    await onOrder(flow, "inst-beatriz", "wo-24830", "10:10");

    await flow.text("inst-beatriz", "La ONU no levanta, ¿la puedes revisar?");
    await flow.text("inst-beatriz", "Revísala otra vez por favor, sigue sin levantar");

    const cases = await flow.data.cases.listCasesOfWorkOrder("wo-24830");
    const provisioned = cases.filter((entry) => entry.reason === "NOT_PROVISIONED");
    expect(provisioned.length > 0 ? provisioned : cases.filter((entry) => entry.reason === "OTHER"), turnsSummary(agent.turns)).toHaveLength(1);
    expect(await dirtyOutbound(flow, "inst-beatriz")).toEqual([]);
  });

  it("[SC-02/9] [FL-022] DYING_GASP → §DIAG-01; after the physical action, ONU_ONLINE PASSED", async () => {
    const { flow, agent } = await worlds.open();
    await onOrder(flow, "inst-tomas", "wo-24832", "10:10");

    await flow.text("inst-tomas", "La ONU no prende ninguna luz");
    const first = (await repliesTo(flow, "inst-tomas")).at(-1);
    expect(citesAny(first, ["DIAG-01"]), `${first?.text ?? "no reply"} · ${turnsSummary(agent.turns)}`).toBe(true);

    await flow.text("inst-tomas", "Ya conecté bien el eliminador al contacto y ya prendió");

    expect(await itemStatus(flow, "wo-24832", "ONU_ONLINE"), turnsSummary(agent.turns)).toBe("PASSED");
    expect(await dirtyOutbound(flow, "inst-tomas")).toEqual([]);
  });

  it("[SC-02/10] [FL-024] vn-08 → one case asked by the installer (INSTALLER_ASKED, or OTHER) and the CASE_NOTICE", async () => {
    const { flow, agent } = await worlds.open();
    await onOrder(flow, "inst-rogelio", "wo-24818", "11:50");

    await flow.voice("inst-rogelio", "vn-08");

    const cases = await flow.data.cases.listCasesOfWorkOrder("wo-24818");
    const asked = cases.filter((entry) => entry.reason === "INSTALLER_ASKED");
    expect(asked.length > 0 ? asked : cases.filter((entry) => entry.reason === "OTHER"), turnsSummary(agent.turns)).toHaveLength(1);
    expect(await flow.delivered("inst-rogelio", "CASE_NOTICE")).not.toHaveLength(0);
    expect(await flow.delivered("sup-adriana", "CASE_REQUEST")).not.toHaveLength(0);
    const said = (await repliesTo(flow, "inst-rogelio")).map((message) => message.text ?? "").join("\n");
    expect(said, "the agent never speaks for the supervisor").not.toMatch(/ya (te )?atendi|ya lo revis/i);
  });

  it("[SC-02/11] [FL-025] small talk, another installer's orders and two \"hola\" with the clock paused: each message answered, no case, nothing of anyone else", async () => {
    const { flow, agent } = await worlds.open();
    await onOrder(flow, "inst-rogelio", "wo-24817", "09:20");

    const said = ["¿Quién ganó el partido anoche?", "¿Qué órdenes tiene Karina hoy?", "Hola", "hola"];
    for (const text of said) await flow.text("inst-rogelio", text);

    const replies = await repliesTo(flow, "inst-rogelio");
    expect(replies.length, turnsSummary(agent.turns)).toBeGreaterThanOrEqual(said.length);
    expect(await flow.data.cases.listCasesOfWorkOrder("wo-24817")).toEqual([]);
    const foreign = await foreignOrderNumbers(flow, "inst-rogelio");
    const text = replies.map((reply) => reply.text ?? "").join("\n");
    expect(foreign.filter((number) => text.includes(number)), "another installer's order in a reply").toEqual([]);
    expect(callsOf(agent.turns, "get_work_order").filter((call) => foreign.includes(String(call.input.workOrderNumber ?? ""))).every((call) => JSON.stringify(call.output).includes("FORBIDDEN") || call.status === "error"), "a foreign order was read").toBe(true);
    expect(await dirtyOutbound(flow, "inst-rogelio")).toEqual([]);
  });

  it("[SC-02/12] [FL-026] the orchestrator down → available false, the turn ends and no reading is stated", async () => {
    const { flow, agent } = await worlds.open();
    await onOrder(flow, "inst-rogelio", "wo-24817", "09:20");
    flow.network.outage = true;

    await flow.text("inst-rogelio", "¿Cómo ves la ONU de esta orden? ¿Ya tiene señal?");

    const replies = await repliesTo(flow, "inst-rogelio");
    expect(replies, turnsSummary(agent.turns)).not.toHaveLength(0);
    expect(replies.map((reply) => reply.text ?? "").join("\n")).not.toMatch(/dbm|−?-?\d+[.,]\d+/i);
    for (const call of callsOf(agent.turns, "get_onu_status")) expect(call.output).toMatchObject({ ok: true, available: false });
    expect(failedTurns(flow)).toEqual([]);
    expect(await dirtyOutbound(flow, "inst-rogelio")).toEqual([]);
  });
});
