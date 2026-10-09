// Area D · The manual and its limits (docs/flows-catalog.md FL-028 to FL-034), in process: `search_procedures`
// over the Knowledge Base fake (the manual's sections by their words), the citation and fact checks of the
// outbound pipeline, G2 over the guardrail fake, the G1 pre-filter and the guardrail block of the worker,
// and the consult button through the installer queue.
import { describe, expect, it } from "vitest";
import { esMX } from "../../packages/bff/src/copy/es-MX";
import { READ_ORDER, citedReply, escalate, outputOf, reply, search, workOrderOf } from "./support/agent";
import { POLICY_ROSETTE } from "./support/story";
import { createFlowWorld, type FlowWorld } from "./support/world";

const OUT_OF_MANUAL_QUESTION = "¿Le dejo al cliente la contraseña de administrador de la ONU?";

async function onSite(): Promise<FlowWorld> {
  const world = await createFlowWorld();
  await world.at("09:40");
  await world.data.worlds.setActiveWorkOrder("inst-rogelio", world.clockId, "wo-24817", await world.simNow());
  return world;
}

/** FL-030: nothing above the threshold; the agent says so and offers to consult, citing nothing. */
const NOT_IN_MANUAL = {
  steps: [
    search(OUT_OF_MANUAL_QUESTION),
    reply("Eso no está en el manual. ¿Quieres que lo consulte con tu supervisor?", { buttons: [{ action: "CONSULT_SUPERVISOR" }, { action: "NO_THANKS" }] }),
  ],
};

describe("manual flows", () => {
  it("[FL-028] a policy question is answered with the rule of the passage and its citation, grounded by G2", async () => {
    const world = await onSite();
    world.plan(POLICY_ROSETTE);
    await world.text("inst-rogelio", "La señora quiere la roseta en el otro cuarto, ¿se le cobra?");
    const [search] = world.harness.turns[0]?.calls ?? [];
    expect((search?.output as unknown as { passages: Array<{ sectionId: string }> }).passages.map((passage) => passage.sectionId)).toContain("COM-04");
    const [answer] = await world.delivered("inst-rogelio", "REPLY");
    expect(answer?.refs?.citations).toEqual(["COM-04"]);
    expect(answer?.text).toContain("15 m");
    const sent = world.harness.turns[0]?.calls.at(-1)?.output as unknown as { guardrail: { groundingScore: number } };
    expect(sent.guardrail.groundingScore).toBeGreaterThanOrEqual(0.75);
    expect(world.guardrails.g2Inputs.at(-1)?.source).toContain("COM-04");
  });

  it("[FL-029] a procedure question is answered with the figure of the zone's class, which must be in the turn's results", async () => {
    const world = await onSite();
    const question = "¿Cuánto es lo mínimo de potencia para cerrar en esta zona?";
    world.plan(
      { steps: [READ_ORDER, search("potencia mínima para cerrar según la clase óptica", "MED"), citedReply((context) => `En ${String(workOrderOf(context).opticalClass)} lo mínimo es ${String((workOrderOf(context).acceptanceRange as { minDbm: number }).minDbm).replace("-", "−")} dBm`, "MED-01")] },
      { steps: [READ_ORDER, search("potencia mínima para cerrar según la clase óptica", "MED"), citedReply(() => "Lo mínimo es −27 dBm", "MED-01")] },
    );
    await world.text("inst-rogelio", question);
    const [answer] = await world.delivered("inst-rogelio", "REPLY");
    expect(answer?.refs?.citations).toEqual(["MED-01"]);
    expect(answer?.text).toContain("−25 dBm");
    await world.text("inst-rogelio", question);
    const refused = world.harness.turns[1]?.calls.at(-1)?.output;
    expect(refused).toMatchObject({ ok: false, error: { code: "GROUNDING_FAIL" } });
    expect(await world.delivered("inst-rogelio", "REPLY")).toHaveLength(1);
  });

  it("[FL-030] a question the manual does not cover gets 'not in the manual' with the consult buttons, no citation and no case", async () => {
    const world = await onSite();
    world.plan(NOT_IN_MANUAL);
    await world.text("inst-rogelio", OUT_OF_MANUAL_QUESTION);
    expect(world.harness.turns[0]?.calls[0]?.output).toMatchObject({ ok: true, coverage: "NONE", passages: [] });
    const [answer] = await world.delivered("inst-rogelio", "REPLY");
    expect(answer?.refs?.citations ?? []).toEqual([]);
    expect(((answer?.interactive?.buttons ?? []) as Array<{ action: string }>).map((button) => button.action)).toEqual(["CONSULT_SUPERVISOR", "NO_THANKS"]);
    expect(await world.data.cases.listCasesOfWorkOrder("wo-24817")).toEqual([]);
  });

  it("[FL-031] the consult button opens the OUT_OF_MANUAL case by code with the masked question, without an agent turn", async () => {
    const world = await onSite();
    world.plan(NOT_IN_MANUAL);
    await world.text("inst-rogelio", OUT_OF_MANUAL_QUESTION);
    await world.tap("inst-rogelio", "CONSULT_SUPERVISOR");
    expect(world.harness.turns).toHaveLength(1);
    const [caseItem] = await world.data.cases.listCasesOfWorkOrder("wo-24817");
    expect(caseItem?.reason).toBe("OUT_OF_MANUAL");
    expect(caseItem?.summary).toContain("contraseña de administrador");
    expect(await world.delivered("inst-rogelio", "CASE_NOTICE")).toHaveLength(1);
    expect(await world.delivered("sup-adriana", "CASE_REQUEST")).toHaveLength(1);
  });

  it("[FL-031] accepting in free text makes the agent escalate the case itself", async () => {
    const world = await onSite();
    world.plan(NOT_IN_MANUAL, { steps: [escalate("OUT_OF_MANUAL", "El instalador pregunta si deja la contraseña de administrador de la ONU al cliente; el manual no lo cubre."), reply("Listo, ya lo pasé a tu supervisora.")] });
    await world.text("inst-rogelio", OUT_OF_MANUAL_QUESTION);
    await world.text("inst-rogelio", "Sí, consúltalo por favor");
    const escalated = world.harness.turns[1]?.calls[0]?.output;
    expect(escalated).toMatchObject({ ok: true, existing: false, rung: "PRIMARY" });
    expect((await world.data.cases.listCasesOfWorkOrder("wo-24817")).map((caseItem) => caseItem.reason)).toEqual(["OUT_OF_MANUAL"]);
  });

  it.each([
    ["(a) pricing", "¿Le hago descuento si paga el año?", "PRICING"],
    ["(b) compensation", "Llegamos tarde, ¿le regalo un mes?", "CUSTOMER_COMPENSATION"],
    ["(c) electrical work", "¿Cómo conecto un contacto nuevo desde el tablero para la ONU?", "ELECTRICAL_WORK"],
  ])("[FL-032] %s is blocked by G1 before the agent: the fixed refusal, one DENIED_TOPIC case and nothing promised", async (_label, text, topic) => {
    const world = await onSite();
    await world.text("inst-rogelio", text);
    expect(world.harness.turns).toHaveLength(0);
    expect((await world.delivered("inst-rogelio", "SYSTEM_NOTICE")).map((message) => message.text)).toEqual([esMX.guardrailRefusal]);
    expect((await world.data.cases.listCasesOfWorkOrder("wo-24817")).map((caseItem) => caseItem.reason)).toEqual(["DENIED_TOPIC"]);
    const block = (await world.decisions()).find((decision) => decision.action === "GUARDRAIL_BLOCK");
    expect(JSON.stringify(block?.detail)).toContain(topic);
    const sent = (await world.delivered("inst-rogelio")).map((message) => message.text ?? "").join("\n");
    expect(sent).not.toMatch(/\$|%|\bgratis\b|descuento|tablero/);
  });

  it("[FL-033] an invented policy never leaves: the facts check refuses it (GROUNDING_FAIL) and the agent corrects with the passage", async () => {
    const world = await onSite();
    world.plan({
      steps: [
        search("reubicación de la roseta a otro cuarto, ¿se cobra?", "COM"),
        citedReply(() => "El cambio de roseta cuesta $150", "COM-04"),
        { ...citedReply(() => "Mover la roseta no tiene costo hasta 15 m de cable", "COM-04"), when: (context) => outputOf(context, "send_whatsapp").ok === false },
      ],
    });
    await world.text("inst-rogelio", "¿Cuánto cuesta cambiar la roseta?");
    const [, invented, corrected] = world.harness.turns[0]?.calls ?? [];
    expect(invented?.output).toMatchObject({ ok: false, error: { code: "GROUNDING_FAIL" } });
    expect(corrected?.output).toMatchObject({ ok: true });
    const sent = (await world.thread("inst-rogelio")).filter((message) => message.direction === "OUT" && message.status !== "DENIED");
    expect(sent.map((message) => message.text ?? "").join("\n")).not.toContain("150");
    expect((await world.decisions()).some((decision) => decision.decision === "DENY" && (decision.reason === "GROUNDING_FAIL" || decision.ruleIds.includes("GROUNDING_FAIL" as never)))).toBe(true);
  });

  it("[FL-033] a refusal of G2 is logged and audited with its scores and thresholds, never the text", async () => {
    const world = await onSite();
    world.guardrails.g2Next.push({ grounding: 0.31, relevance: 0.8 });
    world.plan({ steps: [search("reubicación de la roseta", "COM"), citedReply(() => "Mover la roseta no tiene costo hasta 15 m de cable", "COM-04")] });
    await world.text("inst-rogelio", "¿Se cobra mover la roseta?");
    expect(world.harness.turns[0]?.calls.at(-1)?.output).toMatchObject({ ok: false, error: { code: "GROUNDING_FAIL" } });
    const line = world.logs.find((entry) => entry.message === "outbound.g2_refused");
    expect(line).toMatchObject({ groundingScore: 0.31, groundingThreshold: 0.75, relevanceThreshold: 0.5 });
    expect(JSON.stringify(line)).not.toContain("roseta");
    const audited = (await world.decisions()).filter((decision) => decision.decision === "DENY" && JSON.stringify(decision).includes("0.31"));
    expect(audited).toHaveLength(1);
    expect(JSON.stringify(audited[0])).not.toContain("roseta no tiene costo");
  });

  it("[FL-034] with the Knowledge Base down the search answers UNAVAILABLE and the agent offers to escalate without stating a policy", async () => {
    const world = await onSite();
    world.knowledge.outage = true;
    world.plan({
      steps: [
        search("reubicación de la roseta", "COM"),
        reply((context) => (outputOf(context, "search_procedures").coverage === "UNAVAILABLE" ? "Ahorita no puedo consultar el manual. ¿Quieres que lo consulte con tu supervisor?" : "Ya lo vi."), { buttons: [{ action: "CONSULT_SUPERVISOR" }, { action: "NO_THANKS" }] }),
      ],
    });
    await world.text("inst-rogelio", "¿Se cobra mover la roseta?");
    expect(world.harness.turns[0]?.calls[0]?.output).toMatchObject({ ok: true, coverage: "UNAVAILABLE", passages: [] });
    expect(world.knowledge.queries).toHaveLength(3);
    const [answer] = await world.delivered("inst-rogelio", "REPLY");
    expect(answer?.text).toContain("no puedo consultar el manual");
    expect(answer?.refs?.citations ?? []).toEqual([]);
    expect(world.logs.filter((line) => line.message === "turn.harness_failed" || line.message === "tool.failed")).toEqual([]);
  });
});
