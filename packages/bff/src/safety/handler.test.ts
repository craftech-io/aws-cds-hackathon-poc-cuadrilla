import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { CLOCK, ISP } from "../connector/testing";
import { esMX } from "../copy/es-MX";
import { type CaseKit, caseKit, inbound, mx } from "../cases/testing";
import { classifySafety } from "./classifier";
import { handleSafety } from "./handler";

const SEG_01 = new URL("../../../../scripts/seed/data/manual/v001/SEG-01.md", import.meta.url);
const ORDER = "wo-24817";
let kit: CaseKit;

async function report(fields: Partial<Parameters<typeof handleSafety>[1]> = {}) {
  const text = "Hay un cable pelado en el poste, está chispeando";
  const match = classifySafety(text);
  if (!match.hazard) throw new Error("the lexicon should match");
  return handleSafety(kit.deps, {
    ispId: ISP,
    clockId: CLOCK,
    installerId: "inst-rogelio",
    workOrderId: ORDER,
    category: match.category,
    detectedBy: "LEXICON",
    entryId: match.entryId,
    lexiconVersion: match.lexiconVersion,
    sourceMessageId: "wamid.SIM.safety.01",
    report: text,
    atSim: mx("2026-10-13 15:10"),
    actor: "WORKER",
    ...fields,
  });
}

function sentKinds(personId: string) {
  return kit.outbound.sent.filter((record) => record.request.personId === personId).map((record) => `${record.request.kind}:${record.outcome.status}`);
}

beforeEach(async () => {
  kit = await caseKit();
  await inbound(kit.world, "inst-rogelio", mx("2026-10-13 15:10"), { messageId: "wamid.SIM.safety.01", text: "Hay un cable pelado en el poste, está chispeando" });
});

describe("[FL-067] the fixed instruction of the manual, at once", () => {
  it("sends §SEG-01 word for word, puts the order on hold and audits the lexicon entry", async () => {
    const outcome = await report();
    expect(outcome.instructionSent).toBe(true);
    const instruction = kit.outbound.sent.find((record) => record.request.kind === "SAFETY_INSTRUCTION");
    expect(instruction?.request.form === "TEXT" && instruction.request.text).toBe(esMX.safetyInstruction);
    expect(instruction?.request.author).toBe("SYSTEM");
    expect(readFileSync(SEG_01, "utf8")).toContain(esMX.safetyInstruction);
    expect((await kit.world.connector.workOrders.requireWorkOrder(ORDER)).onHoldSafety).toBe(true);
    const audit = (await kit.world.connector.audit.listByWorkOrder(ORDER)).find((row) => row.action === "SAFETY_DETECTED");
    expect(audit?.ruleIds).toEqual(["SAFE-LEXICON", "SAFE-FIXED-TEXT"]);
    expect(audit?.detail).toMatchObject({ detectedBy: "LEXICON", category: "ELECTRICAL", entryId: "elec-cable-damaged" });
    expect(JSON.stringify(audit)).not.toContain("chispeando");
  });

  it("goes out during quiet hours too", async () => {
    await inbound(kit.world, "inst-rogelio", mx("2026-10-13 21:30"), { messageId: "wamid.SIM.safety.02" });
    await report({ atSim: mx("2026-10-13 21:30"), sourceMessageId: "wamid.SIM.safety.02" });
    expect(sentKinds("inst-rogelio")).toContain("SAFETY_INSTRUCTION:SENT");
    expect(sentKinds("sup-adriana")).toContain("SAFETY_ALERT:SENT");
  });

  it("sends the instruction once per message, even when the agent reports the same message again", async () => {
    const first = await report();
    const again = await report({ detectedBy: "AGENT", category: "ELECTRICAL", entryId: undefined, actor: "AGENT" });
    expect(again).toMatchObject({ instructionSent: true, existingCase: true, caseId: first.caseId });
    expect(sentKinds("inst-rogelio").filter((line) => line.startsWith("SAFETY_INSTRUCTION"))).toHaveLength(1);
    expect(sentKinds("sup-adriana").filter((line) => line.startsWith("SAFETY_ALERT"))).toHaveLength(1);
    expect(kit.outbound.emails).toHaveLength(1);
  });

  it("still instructs an installer with no order in progress, without a case", async () => {
    await kit.world.connector.workOrders.setStatus(ORDER, "CLOSED", { actor: "SYSTEM" });
    await kit.world.connector.workOrders.setStatus("wo-24818", "CLOSED", { actor: "SYSTEM" });
    const outcome = await report({ workOrderId: undefined });
    expect(outcome).toEqual({ instructionSent: true, existingCase: false });
    expect(await kit.world.connector.cases.listCasesOfWorkOrder(ORDER)).toEqual([]);
  });
});

describe("[FL-068] supervisor and zone chief alerted in parallel", () => {
  it("sends alerta_seguridad to the supervisor on duty and the zone chief's email at once, with the case in the ladder", async () => {
    const outcome = await report();
    const alert = kit.outbound.sent.find((record) => record.request.kind === "SAFETY_ALERT");
    expect(alert?.request.personId).toBe("sup-adriana");
    expect(alert?.request.form === "TEMPLATE" && [alert.request.templateName, alert.request.params]).toEqual(["alerta_seguridad", ["24817", "Rogelio", esMX.hazard.ELECTRICAL]]);
    expect(kit.outbound.emails.map((email) => [email.request.variant, email.request.atSim, email.outcome.status])).toEqual([["SAFETY", mx("2026-10-13 15:10"), "SENT"]]);
    expect(alert?.request.atSim).toBe(mx("2026-10-13 15:10"));
    const caseItem = await kit.world.connector.cases.requireCase(outcome.caseId ?? "");
    expect(caseItem).toMatchObject({ kind: "SAFETY", reason: "SAFETY", hazardCategory: "ELECTRICAL", rung: "PRIMARY", status: "OPEN" });
    expect(caseItem.ladder.map((entry) => `${entry.rung} ${entry.outcome}`)).toEqual(["PRIMARY NOTIFIED"]);
    expect(caseItem.summary).toContain("Reporte: Hay un cable pelado");
    const notice = kit.outbound.sent.find((record) => record.request.kind === "CASE_NOTICE")?.request;
    expect(notice?.form === "TEXT" && notice.text).toBe(esMX.safetyCaseOpened);
    expect((await kit.world.connector.audit.listByWorkOrder(ORDER)).map((row) => row.action)).toContain("SAFETY_ZONE_CHIEF_ALERT");
  });
});
