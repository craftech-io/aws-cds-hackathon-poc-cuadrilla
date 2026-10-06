import { beforeEach, describe, expect, it } from "vitest";
import { CLOCK } from "../connector/testing";
import { esMX } from "../copy/es-MX";
import type { Case } from "../domain/cases";
import { advanceLadder } from "./ladder";
import { openCase } from "./open";
import { closeCase } from "./bridge";
import { declineCase, takeCase } from "./take";
import { type CaseKit, ORDER, caseKit, inbound, mx } from "./testing";

let kit: CaseKit;
let opened: Case;

const viaWhatsApp = (supervisorId: string) => ({ via: "WHATSAPP" as const, supervisorId });

async function seedEvidence(count: number): Promise<void> {
  const items = ["POWER_READING_PHOTO", "ONU_LABEL_PHOTO", "ROSETTE_PHOTO", "ONU_LABEL_PHOTO"] as const;
  for (let index = 0; index < count; index += 1) {
    await kit.world.connector.workOrders.createEvidence({
      evidenceId: `ev-01J9ZQX00000000000000000${String(index).padStart(2, "0")}`,
      workOrderId: ORDER,
      clockId: CLOCK,
      worldEpoch: 1,
      item: items[index] ?? "ROSETTE_PHOTO",
      sha256: String(index).repeat(64),
      s3Key: `photos/${ORDER}/${items[index] ?? "ROSETTE_PHOTO"}/ev-${index}.jpg`,
      mime: "image/jpeg",
      bytes: 1000 + index,
      receivedAtSim: mx(`2026-10-13 11:3${index}`),
    });
  }
}

async function tap(supervisorId: string, at: string) {
  await inbound(kit.world, supervisorId, at, { content: "BUTTON", buttonAction: "TAKE_CASE" });
}

beforeEach(async () => {
  kit = await caseKit();
  await inbound(kit.world, "inst-rogelio", mx("2026-10-13 11:45"));
  await seedEvidence(4);
  opened = (await openCase(kit.deps, { workOrderId: ORDER, reason: "DIAGNOSIS_ATTEMPTS", summary: "Potencia en −29,8 dBm después de tres pasos.", atSim: mx("2026-10-13 11:50"), actor: "SYSTEM" })).caseItem;
});

describe("[FL-055] taking a case: brief, photos and the bridge", () => {
  it("takes the case, cancels the wait, sends the brief with Cerrar caso and three photos, and tells the installer", async () => {
    await tap("sup-adriana", mx("2026-10-13 11:55"));
    const result = await takeCase(kit.deps, { caseId: opened.caseId, actor: viaWhatsApp("sup-adriana"), atSim: mx("2026-10-13 11:55") });
    expect(result.outcome).toBe("TAKEN");
    expect(result.caseItem).toMatchObject({ status: "TAKEN", takenBy: "sup-adriana", bridge: { open: true } });
    expect((await kit.world.connector.cases.listTakenBy("sup-adriana")).map((item) => item.caseId)).toEqual([opened.caseId]);
    const timers = await kit.world.connector.timers.listTimers({ kind: "CASE", id: opened.caseId });
    expect(timers.map((timer) => timer.status)).toEqual(["CANCELLED"]);
    const toAdriana = kit.outbound.sent.filter((record) => record.request.personId === "sup-adriana" && record.request.kind === "CASE_BRIEF");
    expect(toAdriana.map((record) => `${record.request.form}:${record.outcome.status}`)).toEqual(["INTERACTIVE:SENT", "IMAGE:SENT", "IMAGE:SENT", "IMAGE:SENT"]);
    const brief = toAdriana[0]?.request;
    expect(brief?.form === "INTERACTIVE" && brief.buttons.map((button) => button.action)).toEqual(["CLOSE_CASE"]);
    expect(brief?.form === "INTERACTIVE" && brief.text).toContain("Resumen: Potencia en −29,8 dBm después de tres pasos.");
    expect(toAdriana.slice(1).map((record) => (record.request.form === "IMAGE" ? record.request.media.bucket : ""))).toEqual(["EVIDENCE", "EVIDENCE", "EVIDENCE"]);
    const notice = kit.outbound.sent.at(-1)?.request;
    expect(notice?.kind).toBe("CASE_NOTICE");
    expect(notice?.form === "TEXT" && notice.text).toBe(esMX.caseTaken("Adriana"));
    const actions = (await kit.world.connector.audit.listByWorkOrder(ORDER)).map((row) => row.action);
    expect(actions).toContain("CASE_TAKEN");
  });

  it("takes from the console without a brief when the supervisor's window is closed", async () => {
    const result = await takeCase(kit.deps, { caseId: opened.caseId, actor: { via: "CONSOLE", userId: "usr-adriana", supervisorId: "sup-adriana" }, atSim: mx("2026-10-13 11:55") });
    expect(result.outcome).toBe("TAKEN");
    const brief = kit.outbound.sent.filter((record) => record.request.kind === "CASE_BRIEF");
    expect(brief.map((record) => record.outcome.status)).toEqual(["DENIED"]);
    expect(kit.outbound.delivered()).toContain("CASE_NOTICE:TEXT:inst-rogelio");
  });
});

describe("[FL-062] late take and the race between supervisors", () => {
  it("lets the supervisor on duty take a reassigned case while it is OPEN; the backup who taps later loses", async () => {
    await advanceLadder(kit.deps, opened.caseId, { kind: "TIMEOUT", rungVersion: 0 }, mx("2026-10-13 12:00"));
    await tap("sup-adriana", mx("2026-10-13 12:02"));
    await tap("sup-hector", mx("2026-10-13 12:03"));
    const late = await takeCase(kit.deps, { caseId: opened.caseId, actor: viaWhatsApp("sup-adriana"), atSim: mx("2026-10-13 12:02") });
    expect(late.outcome).toBe("TAKEN");
    const second = await takeCase(kit.deps, { caseId: opened.caseId, actor: viaWhatsApp("sup-hector"), atSim: mx("2026-10-13 12:03") });
    expect(second.outcome).toBe("TAKE_LOST");
    expect(second.caseItem.takenBy).toBe("sup-adriana");
    const toHector = kit.outbound.sent.filter((record) => record.request.personId === "sup-hector" && record.request.kind === "CASE_TAKEN_NOTICE");
    expect(toHector.map((record) => [record.outcome.status, record.request.form === "TEXT" ? record.request.text : ""])).toEqual([["SENT", esMX.caseTakenByOther("Adriana")]]);
    const lost = (await kit.world.connector.audit.listByWorkOrder(ORDER)).filter((row) => row.action === "CASE_TAKE_LOST");
    expect(lost.map((row) => row.actor)).toEqual(["PERSON:sup-hector"]);
  });

  it("lets exactly one of two simultaneous takes win", async () => {
    await tap("sup-adriana", mx("2026-10-13 11:55"));
    await tap("sup-hector", mx("2026-10-13 11:55"));
    const results = await Promise.all([
      takeCase(kit.deps, { caseId: opened.caseId, actor: viaWhatsApp("sup-adriana"), atSim: mx("2026-10-13 11:55") }),
      takeCase(kit.deps, { caseId: opened.caseId, actor: viaWhatsApp("sup-hector"), atSim: mx("2026-10-13 11:55") }),
    ]);
    expect(results.map((result) => result.outcome).sort()).toEqual(["TAKEN", "TAKE_LOST"]);
    const stored = await kit.world.connector.cases.requireCase(opened.caseId);
    expect(stored.ladder.filter((entry) => entry.outcome === "TAKEN")).toHaveLength(1);
  });

  it("answers a tap on a closed case with the fixed notice", async () => {
    await closeCase(kit.deps, { caseId: opened.caseId, actor: { via: "CONSOLE", userId: "usr-adriana" }, atSim: mx("2026-10-13 11:56") });
    await tap("sup-hector", mx("2026-10-13 11:57"));
    const result = await takeCase(kit.deps, { caseId: opened.caseId, actor: viaWhatsApp("sup-hector"), atSim: mx("2026-10-13 11:57") });
    expect(result.outcome).toBe("ALREADY_CLOSED");
    const notice = kit.outbound.sent.at(-1)?.request;
    expect(notice?.kind === "SYSTEM_NOTICE" && notice.form === "TEXT" && notice.text).toBe(esMX.caseAlreadyClosed);
  });

  it("ignores a No puedo once the case was taken", async () => {
    await tap("sup-adriana", mx("2026-10-13 11:55"));
    await takeCase(kit.deps, { caseId: opened.caseId, actor: viaWhatsApp("sup-adriana"), atSim: mx("2026-10-13 11:55") });
    const declined = await declineCase(kit.deps, { caseId: opened.caseId, actor: viaWhatsApp("sup-adriana"), atSim: mx("2026-10-13 11:56") });
    expect(declined.status).toBe("STALE");
    expect(declined.caseItem.status).toBe("TAKEN");
  });
});
