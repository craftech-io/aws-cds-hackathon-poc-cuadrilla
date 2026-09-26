import { describe, expect, it } from "vitest";
import { CLOCK, ISP, workOrder } from "../connector/testing";
import { evaluateMailAsOf } from "./as-of";
import { loadPolicyRecords } from "./records";
import { REAL_NOW, SHA_CERT, mx, policyWorld, summary } from "./testing";

const when = { sim: mx("2026-10-13 10:05"), real: REAL_NOW };

describe("loading the records the policy reads", () => {
  it("reads the sections search_procedures returned in the turn, without repeats", async () => {
    const world = await policyWorld();
    const { runtime } = world.connector;
    await runtime.putTurnResult("turn-1", "search_procedures", { coverage: "FOUND", passages: [{ sectionId: "COM-04", title: "Reubicación", score: 0.8 }, { sectionId: "COM-02" }] });
    await runtime.putTurnResult("turn-1", "search_procedures", { coverage: "FOUND", passages: [{ sectionId: "COM-04" }] });
    await runtime.putTurnResult("turn-1", "get_onu_status", { operState: "ONLINE" });
    const records = await loadPolicyRecords(world.connector, { ispId: ISP, turnId: "turn-1", at: when });
    expect(records.turnSections).toEqual(["COM-04", "COM-02"]);
    expect((await loadPolicyRecords(world.connector, { ispId: ISP, at: when })).turnSections).toBeUndefined();
    // A turn without search results (none made, or expired) leaves the sections unknown, not empty.
    expect((await loadPolicyRecords(world.connector, { ispId: ISP, turnId: "turn-2", at: when })).turnSections).toBeUndefined();
  });

  it("loads Meta's template states only for a live route, and the lease only for a leased phone", async () => {
    const world = await policyWorld();
    await world.connector.reference.put("Template", { name: "caso_escalado", language: "es_MX", category: "UTILITY", body: "Tienes un caso nuevo de tu equipo: {{1}}.", status: "APPROVED" });
    const simulated = await loadPolicyRecords(world.connector, { ispId: ISP, personId: "inst-rogelio", route: "SIMULATED", at: when });
    expect(simulated.metaTemplates).toBeUndefined();
    expect(simulated.lease).toBeUndefined();
    const live = await loadPolicyRecords(world.connector, { ispId: ISP, personId: "inst-rogelio", route: "LIVE_WORLD", at: when });
    expect(live.metaTemplates?.map((template) => [template.name, template.status])).toEqual([["caso_escalado", "APPROVED"]]);
  });

  it("reads the thread of the last 48 simulated hours up to the instant: inbound marks and day starts sent", async () => {
    const world = await policyWorld();
    const { conversations } = world.connector;
    const base = { personId: "inst-rogelio", ispId: ISP, clockId: CLOCK, channel: "WHATSAPP" as const, simulated: true };
    await conversations.appendMessage({ ...base, messageId: "wamid.SIM.old", direction: "IN", content: "TEXT", status: "RECEIVED", author: "PERSON:inst-rogelio", sentAtSim: mx("2026-10-10 09:00") });
    await conversations.appendMessage({ ...base, messageId: "wamid.SIM.1", direction: "IN", content: "BUTTON", status: "RECEIVED", author: "PERSON:inst-rogelio", sentAtSim: mx("2026-10-13 07:40") });
    await conversations.appendMessage({ ...base, messageId: "msg-ds", direction: "OUT", kind: "DAY_START", content: "TEMPLATE", templateName: "ordenes_del_dia", status: "DELIVERED", author: "SYSTEM", sentAtSim: mx("2026-10-13 07:30") });
    await conversations.appendMessage({ ...base, messageId: "msg-ds-denied", direction: "OUT", kind: "DAY_START", content: "TEMPLATE", templateName: "ordenes_del_dia", status: "DENIED", author: "SYSTEM", sentAtSim: mx("2026-10-13 07:31") });
    await conversations.appendMessage({ ...base, messageId: "wamid.SIM.later", direction: "IN", content: "TEXT", status: "RECEIVED", author: "PERSON:inst-rogelio", sentAtSim: mx("2026-10-13 11:00") });
    const records = await loadPolicyRecords(world.connector, { ispId: ISP, personId: "inst-rogelio", route: "SIMULATED", at: when });
    expect(records.inbound).toEqual([{ atSim: mx("2026-10-13 07:40"), live: false }]);
    expect(records.dayStarts).toEqual([{ messageId: "msg-ds", sentAtSim: mx("2026-10-13 07:30") }]);
    expect(records.shiftRoster).toMatchObject({ crewId: "crew-n3", date: "2026-10-13", primaryId: "sup-adriana" });
  });

  it("loads the order, its cases and certificate, and re-evaluates the certificate email byte for byte", async () => {
    const world = await policyWorld();
    const { workOrders } = world.connector;
    await workOrders.createWorkOrder(workOrder({ status: "CLOSED" }));
    await workOrders.putCertificate({ workOrderId: "wo-24817", clockId: CLOCK, certificateId: "cert-24817-1", n: 1, issuedAtSim: mx("2026-10-13 10:05"), sha256: SHA_CERT });
    const records = await loadPolicyRecords(world.connector, { ispId: ISP, workOrderId: "wo-24817", certificate: true, at: when });
    expect(records).toMatchObject({ workOrder: { workOrderId: "wo-24817" }, cases: [], certificate: { sha256: SHA_CERT } });
    const mail = {
      entity: "OutboundEmail" as const,
      mailId: "mail-1",
      ispId: ISP,
      clockId: CLOCK,
      kind: "CERTIFICATE_EMAIL" as const,
      toRole: "CUSTOMER" as const,
      to: "success+cust-10421@simulator.amazonses.com",
      from: '"Cuadrilla · Actas" <actas@cuadrilla.demo.craftech.io>',
      subject: "Acta de instalación · Orden 24817",
      bodyText: "Tu acta de instalación va adjunta.",
      workOrderId: "wo-24817",
      attachment: { s3Key: "certificates/wo-24817/acta-1.pdf", fileName: "acta-24817.pdf", contentType: "application/pdf" as const, sha256: SHA_CERT },
      status: "DELIVERED" as const,
      events: [],
      sentAtSim: mx("2026-10-13 10:05"),
      sentAtReal: REAL_NOW,
      createdAt: REAL_NOW,
      updatedAt: REAL_NOW,
      version: 1,
      synthetic: false,
    };
    expect(summary(evaluateMailAsOf(mail, { allowed: true, reason: "SES_SIMULATOR" }, records))).toBe("ALLOW");
    // A later re-render of the certificate (another brand) no longer matches what left.
    const rerendered = { ...records, certificate: { ...records.certificate!, sha256: "d".repeat(64) } };
    expect(summary(evaluateMailAsOf(mail, { allowed: true }, rerendered))).toBe("DENY CP-CERT-EVIDENCE CERT_HASH_MISMATCH");
    expect(summary(evaluateMailAsOf(mail, { allowed: false, reason: "RESERVED_DOMAIN" }, records))).toBe("DENY CP-RECIPIENT-FENCE RECIPIENT_NOT_ALLOWED");
  });

  it("refuses a world without settings", async () => {
    const world = await policyWorld();
    await expect(loadPolicyRecords(world.connector, { ispId: "isp-guest-07", at: when })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
