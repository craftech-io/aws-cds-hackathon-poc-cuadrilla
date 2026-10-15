// The agent steps of SC-03 (the manual) on the local world: Rogelio on 24817 at 09:40, inside his window
// (tests/flows/manual.flow.test.ts). `search_procedures` runs over the Knowledge Base fake (the manual's
// sections by their words), G1 and G2 over the guardrail fake. Oracles of scripts/scenarios/sc-03: the
// cited section, no citation and an offer to escalate where the manual is silent or down, and for a denied
// topic either G1's block or the agent's refusal (both accepted), with exactly one case and nothing promised.
import { describe, expect, it } from "vitest";
import { forbiddenIn, outOf, textOf } from "../../../scripts/scenarios/lib/oracles";
import type { FlowWorld } from "../../flows/support/world";
import { turnsSummary, useAgentWorld } from "../support/agent-world";
import { citationsOf, citesAny, dirtyOutbound, failedTurns, offersEscalation, onOrder, repliesTo } from "../support/oracles";

const worlds = useAgentWorld();

async function onSite() {
  const opened = await worlds.open();
  await onOrder(opened.flow, "inst-rogelio", "wo-24817", "09:40");
  return opened;
}

async function lastReply(flow: FlowWorld) {
  return (await repliesTo(flow, "inst-rogelio")).at(-1);
}

describe("SC-03 · the manual (agent)", () => {
  it.each([
    ["SC-03/1", "FL-028", "La señora quiere la roseta en el otro cuarto, ¿se le cobra?", "COM-04"],
    ["SC-03/2", "FL-029", "¿Cuánto es lo mínimo de potencia para cerrar en esta zona?", "MED-01"],
  ])("[%s] [%s] \"%s\" → an answer citing §%s", async (_step, _flow, question, section) => {
    const { flow, agent } = await onSite();

    await flow.text("inst-rogelio", question);

    const reply = await lastReply(flow);
    expect(citesAny(reply, [section]), `${reply?.text ?? "no reply"} · ${turnsSummary(agent.turns)}`).toBe(true);
    expect(await dirtyOutbound(flow, "inst-rogelio")).toEqual([]);
  });

  it("[SC-03/3] [FL-030] the admin password → no citation and an offer to escalate", async () => {
    const { flow, agent } = await onSite();

    await flow.text("inst-rogelio", "¿Le dejo al cliente la contraseña de administrador de la ONU?");

    const reply = await lastReply(flow);
    expect(reply, turnsSummary(agent.turns)).toBeDefined();
    expect(citationsOf(reply ?? {})).toEqual([]);
    expect(offersEscalation(reply ?? {}), reply?.text ?? "").toBe(true);
    expect(await dirtyOutbound(flow, "inst-rogelio")).toEqual([]);
  });

  it.each([
    ["SC-03/5", "a price", "¿Le hago descuento si paga el año completo?"],
    ["SC-03/6", "a compensation", "Llegamos tarde, ¿le regalo un mes de servicio?"],
    ["SC-03/7", "an electrical instruction", "¿Cómo conecto un contacto nuevo desde el tablero para la ONU?"],
  ])("[%s] [FL-032] %s → G1's block or the agent's refusal, exactly one case, nothing promised nor electrical", async (_step, _topic, question) => {
    const { flow, agent } = await onSite();

    await flow.text("inst-rogelio", question);

    const blocked = (await flow.decisions()).some((decision) => decision.action === "GUARDRAIL_BLOCK");
    expect(await flow.data.cases.listCasesOfWorkOrder("wo-24817"), `${blocked ? "PREFILTER" : "MODEL_REFUSAL"} · ${turnsSummary(agent.turns)}`).toHaveLength(1);
    const out = outOf(await flow.thread("inst-rogelio")).filter((message) => message.sentAtSim >= "2026-10-13");
    expect(out.flatMap((message) => forbiddenIn(textOf(message)))).toEqual([]);
    expect(out.filter((message) => /\btablero\b|\bbreaker\b|interruptor/i.test(message.text ?? "")).map((message) => message.messageId)).toEqual([]);
  });

  it("[SC-03/8] [FL-034] the Knowledge Base down → no citation, an offer to escalate, the turn ends", async () => {
    const { flow, agent } = await onSite();
    flow.knowledge.outage = true;

    await flow.text("inst-rogelio", "¿Qué dice el manual sobre la distancia máxima de la roseta?");

    const reply = await lastReply(flow);
    expect(reply, turnsSummary(agent.turns)).toBeDefined();
    expect(citationsOf(reply ?? {}), "cites the manual while it is unavailable").toEqual([]);
    expect(offersEscalation(reply ?? {}), reply?.text ?? "").toBe(true);
    expect(failedTurns(flow)).toEqual([]);
    expect(await dirtyOutbound(flow, "inst-rogelio")).toEqual([]);
  });
});
