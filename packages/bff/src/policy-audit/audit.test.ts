import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CLOCK, ISP, workOrder } from "../connector/testing";
import type { NewEntity } from "../domain/common";
import type { Message } from "../domain/conversations";
import { mx, policyWorld } from "../policy/testing";
import { createPolicyAuditHandler, worldsOf } from "../handlers/policy-audit";
import { auditWorld } from "./audit";

function dayStart(messageId: string, local: string): NewEntity<typeof Message> {
  return {
    messageId,
    personId: "inst-rogelio",
    ispId: ISP,
    clockId: CLOCK,
    direction: "OUT",
    channel: "WHATSAPP",
    content: "TEMPLATE",
    kind: "DAY_START",
    templateName: "ordenes_del_dia",
    status: "SENT",
    author: "SYSTEM",
    simulated: true,
    transport: "simulated",
    sentAtSim: mx(local),
  };
}

type World = Awaited<ReturnType<typeof policyWorld>>;

async function allow(world: World, messageId: string, local: string): Promise<void> {
  await world.connector.audit.append({ ispId: ISP, clockId: CLOCK, atSim: mx(local), decision: "ALLOW", action: "SEND_WHATSAPP", ruleIds: ["CP-OPTIN"], actor: "SYSTEM", messageId });
}

const PDF = new TextEncoder().encode("%PDF-1.4 acta sintética");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function deps(world: World, pdf: Uint8Array | undefined = PDF) {
  return { connector: world.connector, readCertificate: async () => pdf };
}

describe("PolicyAudit [FL-077]", () => {
  it("[FL-077] a world whose every send has its ALLOW and is allowed again at its instant has 0 violations", async () => {
    const world = await policyWorld();
    await world.connector.conversations.appendMessage(dayStart("msg-ds-13", "2026-10-13 07:30"));
    await allow(world, "msg-ds-13", "2026-10-13 07:30");
    const report = await auditWorld(deps(world), { clockId: CLOCK });
    expect(report).toMatchObject({ messages: 1, violations: [], errors: 0 });
    expect(await world.connector.audit.listByDecision(ISP, "VIOLATION")).toEqual([]);
  });

  it("[FL-077] a send seeded without its ALLOW decision is a violation, written once however often the audit runs", async () => {
    const world = await policyWorld();
    await world.connector.conversations.appendMessage(dayStart("msg-ds-13", "2026-10-13 07:30"));
    const report = await auditWorld(deps(world), { clockId: CLOCK });
    expect(report.violations).toEqual([{ check: "ALLOW_DECISION", subject: "msg-ds-13", ruleIds: [] }]);
    await auditWorld(deps(world), { clockId: CLOCK });
    expect(await world.connector.audit.listByDecision(ISP, "VIOLATION")).toEqual([expect.objectContaining({ action: "POLICY_VIOLATION", reason: "ALLOW_DECISION", messageId: "msg-ds-13", detail: { check: "ALLOW_DECISION", subject: "msg-ds-13" } })]);
  });

  it("[FL-077] an opt-out after the send does not count; a send before the opt-in is a violation of CP-OPTIN", async () => {
    const world = await policyWorld();
    await world.connector.conversations.appendMessage(dayStart("msg-ds-13", "2026-10-13 07:30"));
    await allow(world, "msg-ds-13", "2026-10-13 07:30");
    await world.connector.people.revokeConsent("inst-rogelio", { actor: "PERSON:inst-rogelio", atSim: mx("2026-10-13 12:00") });
    expect((await auditWorld(deps(world), { clockId: CLOCK })).violations).toEqual([]);
    await world.connector.conversations.appendMessage(dayStart("msg-ds-09-30", "2026-09-30 07:30"));
    await allow(world, "msg-ds-09-30", "2026-09-30 07:30");
    expect((await auditWorld(deps(world), { clockId: CLOCK })).violations).toEqual([{ check: "REEVALUATION", subject: "msg-ds-09-30", ruleIds: ["CP-OPTIN"] }]);
  });

  it("[FL-077] a system notice is re-evaluated with the notice key the pipeline kept in its references", async () => {
    const world = await policyWorld();
    const notice = (messageId: string, refs: Record<string, string>): NewEntity<typeof Message> => ({ ...dayStart(messageId, "2026-10-13 10:00"), kind: "SYSTEM_NOTICE", content: "TEXT", templateName: undefined, text: "No pude procesar tu mensaje, intenta de nuevo en un momento.", refs });
    await world.connector.people.recordInbound("inst-rogelio", { atSim: mx("2026-10-13 09:59") });
    await world.connector.conversations.appendMessage(notice("ntc-1", { notice: "agentFallback", replyTo: "wamid.SIM.1" }));
    await allow(world, "ntc-1", "2026-10-13 10:00");
    expect((await auditWorld(deps(world), { clockId: CLOCK })).violations).toEqual([]);
    await world.connector.conversations.appendMessage(notice("ntc-2", { replyTo: "wamid.SIM.2" }));
    await allow(world, "ntc-2", "2026-10-13 10:00");
    expect((await auditWorld(deps(world), { clockId: CLOCK })).violations).toEqual([{ check: "REEVALUATION", subject: "ntc-2", ruleIds: ["CP-KIND-CHANNEL"] }]);
  });

  it("[FL-077] a certificate needs every item closed with its evidence and the PDF's stored sha256", async () => {
    const world = await policyWorld();
    const { connector } = world;
    await connector.workOrders.createWorkOrder(workOrder({ status: "CLOSED" }));
    for (const item of ["ONU_ONLINE", "POWER_READING_PHOTO", "ONU_LABEL_PHOTO", "ROSETTE_PHOTO", "CUSTOMER_OK"] as const) {
      await connector.workOrders.updateChecklistItem("wo-24817", item, { status: "PASSED" }, { actor: "AGENT", atSim: mx("2026-10-13 09:55") });
    }
    await connector.workOrders.putCertificate({ workOrderId: "wo-24817", clockId: CLOCK, certificateId: "cert-24817-1", n: 1, issuedAtSim: mx("2026-10-13 10:05"), sha256: sha(PDF), s3Key: "certificates/wo-24817/acta-1.pdf" });
    await connector.conversations.appendMessage({ ...dayStart("msg-cert-1", "2026-10-13 10:05"), kind: "CERTIFICATE", content: "DOCUMENT", templateName: undefined, workOrderId: "wo-24817" });
    await allow(world, "msg-cert-1", "2026-10-13 10:05");
    const certificateChecks = async (pdf?: Uint8Array) => (await auditWorld(deps(world, pdf), { clockId: CLOCK })).violations.filter((violation) => violation.check.startsWith("CERTIFICATE"));
    // Photo items without evidence: closed, but nothing proves them.
    expect((await certificateChecks()).map((violation) => violation.subject).sort()).toEqual(["cert-24817-1#ONU_LABEL_PHOTO", "cert-24817-1#POWER_READING_PHOTO", "cert-24817-1#ROSETTE_PHOTO"]);
    for (const [index, item] of (["POWER_READING_PHOTO", "ONU_LABEL_PHOTO", "ROSETTE_PHOTO"] as const).entries()) {
      const evidenceId = `ev-01J9ZQX000000000000000000${index}`;
      await connector.workOrders.createEvidence({ evidenceId, workOrderId: "wo-24817", clockId: CLOCK, worldEpoch: 1, item, sha256: String(index).repeat(64), s3Key: `photos/wo-24817/${item}/${evidenceId}.jpg`, mime: "image/jpeg", bytes: 100, receivedAtSim: mx("2026-10-13 09:50") });
      await connector.workOrders.updateChecklistItem("wo-24817", item, { evidenceId }, { actor: "AGENT", atSim: mx("2026-10-13 09:50") });
    }
    expect(await certificateChecks()).toEqual([]);
    expect(await certificateChecks(new TextEncoder().encode("otro pdf"))).toEqual([{ check: "CERTIFICATE_SHA256", subject: "cert-24817-1", ruleIds: [], workOrderId: "wo-24817" }]);
  });

  it("the entry audits the demo world on the daily rule and the worlds the QaDriver names; anything else is refused", async () => {
    expect(worldsOf({ source: "aws.events", "detail-type": "Scheduled Event" })).toEqual(["GLOBAL#isp-demo"]);
    expect(worldsOf({ clockIds: ["qa-812-1-sc-16"] })).toEqual(["qa-812-1-sc-16"]);
    expect(worldsOf({ clockId: "GLOBAL#isp-demo", extra: 1 })).toBeUndefined();
    const world = await policyWorld();
    await world.connector.conversations.appendMessage(dayStart("msg-ds-13", "2026-10-13 07:30"));
    const handler = createPolicyAuditHandler(() => deps(world));
    expect(await handler({ clockId: CLOCK })).toEqual({ worlds: [{ clockId: CLOCK, messages: 1, emails: 0, certificates: 0, errors: 0, violations: 1 }] });
    await expect(handler({ clockId: "not a world" })).rejects.toThrow();
  });
});
