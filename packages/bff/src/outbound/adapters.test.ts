import { describe, expect, it } from "vitest";
import { CASE_1, CLOCK, ISP, installer, openCase } from "../connector/testing";
import { createCaseOutbound, createSummaryCheck } from "./cases";
import { createWindowFallback } from "./fallback";
import { createInstallerNoticeSender, createNoticeSender } from "./notices";
import { sendOutbound } from "./pipeline";
import { mx, pipelineKit, rogelioWrote } from "./testing";

const ZONE_CHIEF_EMAIL = "success+zc-marisol@simulator.amazonses.com";

async function withZoneChief(kit: Awaited<ReturnType<typeof pipelineKit>>, email = ZONE_CHIEF_EMAIL) {
  const { connector } = kit.world;
  await connector.people.createPerson(installer({ personId: "zc-marisol", role: "ZONE_CHIEF", firstName: "Marisol", lastName: "Cárdenas", phone: "+525501030001", phoneHash: "9".repeat(64), email }));
  await connector.isps.putZone({ ispId: ISP, clockId: CLOCK, zoneId: "zone-norte", name: "Norte", opticalClass: "B+", acceptanceRange: { minDbm: -25, maxDbm: -8 }, zoneChiefId: "zc-marisol" });
  await connector.cases.createCase(openCase({ workOrderId: "wo-24818" }));
}

function worldTime(simNow: string) {
  return async () => ({ simNow: new Date(simNow), worldEpoch: 1, timeZone: "America/Mexico_City" });
}

describe("case outbound (cases/ports.ts) through the pipeline", () => {
  it("renders the zone chief's email with the console link as its only URL and sends it to the fenced address", async () => {
    const kit = await pipelineKit();
    await withZoneChief(kit);
    const outcome = await createCaseOutbound(kit.deps, kit.call.log).sendZoneChiefAlert({
      clockId: CLOCK,
      ispId: ISP,
      zoneChiefId: "zc-marisol",
      caseId: CASE_1,
      workOrderId: "wo-24818",
      variant: "UNATTENDED",
      reasonText: "potencia fuera de rango después de 3 pasos",
      summary: "Potencia fuera de rango después de 3 pasos.",
      installerFirstName: "Rogelio",
      atSim: mx("2026-10-13 12:10"),
      messageId: `${CASE_1}-zc`,
    });
    expect(outcome).toEqual({ status: "SENT", messageId: `${CASE_1}-zc` });
    expect(kit.emails[0]).toMatchObject({ kind: "ZONE_CHIEF_ALERT", toRole: "ZONE_CHIEF", to: ZONE_CHIEF_EMAIL, caseId: CASE_1, mailId: `${CASE_1}-zc` });
    expect(kit.emails[0]?.bodyText).toContain(`https://cuadrilla.demo.craftech.io/app/cases/${CASE_1}`);
    const allow = (await kit.world.connector.audit.listByDecision(ISP, "ALLOW")).find((row) => row.action === "SEND_EMAIL");
    expect(allow).toMatchObject({ messageId: `${CASE_1}-zc`, refs: { mailId: `${CASE_1}-zc` } });
  });

  it("[FL-076] an address outside the world's fence is denied by CP-RECIPIENT-FENCE before SES", async () => {
    const kit = await pipelineKit();
    await withZoneChief(kit, "marisol@cuadrilla.demo.craftech.io");
    const outcome = await createCaseOutbound(kit.deps, kit.call.log).sendZoneChiefAlert({ clockId: CLOCK, ispId: ISP, zoneChiefId: "zc-marisol", caseId: CASE_1, workOrderId: "wo-24818", variant: "SAFETY", reasonText: "cable de energía dañado", summary: "Riesgo eléctrico.", installerFirstName: "Rogelio", atSim: mx("2026-10-13 15:10"), messageId: `${CASE_1}-zc` });
    expect(outcome).toMatchObject({ status: "DENIED", deniedBy: "CP-RECIPIENT-FENCE", reason: "RECIPIENT_NOT_ALLOWED" });
    expect(kit.emails).toHaveLength(0);
  });

  it("plan B: a template the world holds back is DENIED with its rule, so the ladder tries the interactive", async () => {
    const kit = await pipelineKit();
    await kit.world.connector.isps.setTemplateStatus(ISP, "caso_escalado", "REJECTED", { actor: "SEED" });
    await kit.world.connector.cases.createCase(openCase({ workOrderId: "wo-24818" }));
    await kit.world.connector.people.grantConsent({ personId: "sup-adriana", clockId: CLOCK, medium: "SEED", textVersion: "v001" }, { actor: "SEED", atSim: mx("2026-10-01 08:00") });
    const outbound = createCaseOutbound(kit.deps, kit.call.log);
    const outcome = await outbound.sendWhatsApp({ clockId: CLOCK, ispId: ISP, personId: "sup-adriana", kind: "CASE_REQUEST", author: "SYSTEM", caseId: CASE_1, workOrderId: "wo-24818", atSim: mx("2026-10-13 11:50"), messageId: `${CASE_1}-1-t`, form: "TEMPLATE", templateName: "caso_escalado", params: ["C-0000", "Rogelio", "24818", "potencia fuera de rango"], buttons: [{ action: "TAKE_CASE", object: { kind: "CASE", id: CASE_1 } }, { action: "DECLINE_CASE", object: { kind: "CASE", id: CASE_1 } }] });
    expect(outcome).toMatchObject({ status: "DENIED", deniedBy: "CP-TEMPLATE-APPROVED" });
  });

  it("a summary the agent wrote passes G2 and the fact check against its turn", async () => {
    const kit = await pipelineKit({ g2: [{}, { action: "BLOCKED", failure: "GROUNDING", groundingScore: 0.1 }] });
    await kit.result("get_onu_status", { rxPowerDbm: -29.8 });
    const check = createSummaryCheck(kit.deps, kit.call.log);
    expect(await check.verify({ ispId: ISP, clockId: CLOCK, turnId: "01JB8Z9Q2W3E4R5T6Y7V8X9TRN", workOrderId: "wo-24818", text: "La ONU marca −29,8 dBm después de tres pasos." })).toEqual({ ok: true });
    expect(await check.verify({ ispId: ISP, clockId: CLOCK, turnId: "01JB8Z9Q2W3E4R5T6Y7V8X9TRN", workOrderId: "wo-24818", text: "La ONU marca −31,2 dBm." })).toEqual({ ok: false, reason: "GROUNDING" });
  });
});

describe("fixed notices and the window fallback", () => {
  it("a notice to a person of the list goes through the pipeline as a SYSTEM_NOTICE answering the inbound", async () => {
    const kit = await pipelineKit();
    await rogelioWrote(kit);
    const deps = { outbound: kit.deps, worldTime: worldTime(mx("2026-10-13 09:22")), logger: kit.call.log };
    await createNoticeSender(deps).send({ clockId: CLOCK, ispId: ISP, recipient: { personId: "inst-rogelio", phone: "+525501010001", phoneHash: "a".repeat(64), transport: "simulated" }, notice: "unsupportedMedia", text: "Por aquí solo puedo recibir texto, notas de voz y fotos.", replyToWamid: "wamid.SIM.02" });
    await createInstallerNoticeSender(deps).send({ clockId: CLOCK, ispId: ISP, personId: "inst-rogelio", notice: "closeNotComplete", text: "Para cerrar todavía falta la foto de la roseta.", replyToWamid: "wamid.SIM.03", refs: { items: ["ROSETTE_PHOTO"] } });
    expect(kit.sends).toHaveLength(2);
    const notices = (await kit.world.connector.conversations.listMessages("inst-rogelio")).filter((item) => item.direction === "OUT");
    expect(notices.map((item) => item.kind)).toEqual(["SYSTEM_NOTICE", "SYSTEM_NOTICE"]);
  });

  it("[FL-004] a number outside the list gets its one fixed reply, audited, without a thread", async () => {
    const kit = await pipelineKit();
    const replies: unknown[] = [];
    const unthreaded = () => ({ channel: "WHATSAPP" as const, transport: "simulated" as const, send: async (request: { payload: unknown }) => (replies.push(request.payload), { ok: true as const, providerMessageId: "wamid.SIM.x", payload: request.payload as never }) });
    await createNoticeSender({ outbound: kit.deps, worldTime: worldTime(mx("2026-10-13 09:22")), unthreaded, logger: kit.call.log }).send({ clockId: CLOCK, ispId: ISP, recipient: { phone: "+525501990001", phoneHash: "8".repeat(64), transport: "simulated" }, notice: "unknownNumber", text: "Este número es de uso interno de la operadora.", replyToWamid: "wamid.SIM.04" });
    expect(replies).toHaveLength(1);
    expect((await kit.world.connector.audit.listByDecision(ISP, "ALLOW")).some((row) => row.refs.notice === "unknownNumber")).toBe(true);
  });

  it("WINDOW_FALLBACK: a free text Meta refused falls back to its UTILITY template once", async () => {
    const kit = await pipelineKit();
    await rogelioWrote(kit);
    await kit.result("get_work_orders", { orders: [{ workOrderNumber: "24817" }] });
    const sent = await sendOutbound(kit.deps, { channel: "WHATSAPP", personId: "inst-rogelio", kind: "ORDERS_DETAIL", author: "AGENT", eventAtSim: mx("2026-10-13 09:21"), turnId: "01JB8Z9Q2W3E4R5T6Y7V8X9TRN", inResponseToInbound: true, text: "Hoy tienes la orden 24817." }, kit.call);
    const original = (await kit.world.connector.conversations.listMessages("inst-rogelio")).find((item) => item.messageId === (sent.status === "SENT" ? sent.messageId : ""));
    if (original === undefined) throw new Error("no original message");
    await createWindowFallback({ outbound: () => kit.deps, worldTime: worldTime(mx("2026-10-13 09:30")), logger: kit.call.log }).sendTemplate(original, "ordenes_del_dia");
    expect(kit.sends).toHaveLength(2);
    expect(kit.sends[1]?.payload).toMatchObject({ type: "template", template: { name: "ordenes_del_dia" } });
  });
});
