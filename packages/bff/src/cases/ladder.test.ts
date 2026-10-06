import { beforeEach, describe, expect, it } from "vitest";
import { CLOCK, ISP } from "../connector/testing";
import { esMX } from "../copy/es-MX";
import { onCaseTimeout } from "./events";
import { advanceLadder } from "./ladder";
import { openCase } from "./open";
import { type CaseKit, ORDER, caseKit, inbound, mx } from "./testing";

const OPENED_AT = mx("2026-10-13 11:50");
let kit: CaseKit;

async function open(reason: "DIAGNOSIS_ATTEMPTS" | "NOT_PROVISIONED" | "INSTALLER_ASKED" | "CERTIFICATE_UNDELIVERED" = "DIAGNOSIS_ATTEMPTS") {
  return openCase(kit.deps, { workOrderId: ORDER, reason, summary: "Potencia fuera de rango después de 3 pasos.", atSim: OPENED_AT, actor: "SYSTEM" });
}

async function timersOf(caseId: string) {
  return (await kit.world.connector.timers.listTimers({ kind: "CASE", id: caseId })).map((timer) => ({ id: timer.timerId.split("-").pop(), status: timer.status, dueAtSim: timer.dueAtSim, rungVersion: timer.payload.rungVersion }));
}

function ladderOf(caseItem: { ladder: ReadonlyArray<{ rung: string; outcome: string; reason?: string; channel?: string }> }) {
  return caseItem.ladder.map((entry) => [entry.rung, entry.outcome, entry.reason ?? entry.channel]);
}

async function auditActions() {
  return (await kit.world.connector.audit.listByWorkOrder(ORDER)).map((row) => `${row.decision} ${row.action} ${row.ruleIds.join(",")}`);
}

async function optOut(personId: string) {
  await kit.world.connector.people.revokeConsent(personId, { actor: `PERSON:${personId}`, atSim: mx("2026-10-13 07:10") });
}

beforeEach(async () => {
  kit = await caseKit();
  await inbound(kit.world, "inst-rogelio", mx("2026-10-13 11:45"), { text: "Sigue en menos veintinueve" });
});

describe("[FL-054] a case reaches the supervisor on duty", () => {
  it("copies the roster in force, sends caso_escalado with the buttons, tells the installer and arms the PRIMARY wait", async () => {
    for (const stepRef of ["DIAG-03", "DIAG-03-b", "DIAG-03-c"]) {
      await kit.world.connector.workOrders.appendStep({ workOrderId: ORDER, clockId: CLOCK, symptom: "LOW_POWER", stepRef, outcome: "NO_CHANGE", recordedAtSim: mx("2026-10-13 11:40") });
    }
    const { caseItem, existing } = await open();
    expect(existing).toBe(false);
    expect(caseItem.roster).toEqual({ primaryId: "sup-adriana", secondaryId: "sup-hector", zoneChiefId: "zc-marisol" });
    expect(caseItem.rung).toBe("PRIMARY");
    expect(ladderOf(caseItem)).toEqual([["PRIMARY", "NOTIFIED", "TEMPLATE"]]);
    expect(kit.outbound.delivered()).toEqual(["CASE_REQUEST:TEMPLATE:sup-adriana", "CASE_NOTICE:TEXT:inst-rogelio"]);
    const request = kit.outbound.sent[0]?.request;
    expect(request?.form === "TEMPLATE" && request.templateName).toBe("caso_escalado");
    expect(request?.form === "TEMPLATE" && request.params).toEqual([`C-${caseItem.caseId.slice(-4)}`, "Rogelio", "24818", "potencia fuera de rango después de 3 pasos"]);
    expect(request?.form === "TEMPLATE" && request.buttons.map((button) => button.action)).toEqual(["TAKE_CASE", "DECLINE_CASE"]);
    const notice = kit.outbound.sent[1]?.request;
    expect(notice?.form === "TEXT" && notice.text).toBe(esMX.caseOpened("Adriana"));
    expect(await timersOf(caseItem.caseId)).toEqual([{ id: "PRIMARY", status: "SCHEDULED", dueAtSim: new Date(Date.parse(OPENED_AT) + 600_000).toISOString(), rungVersion: 0 }]);
    expect(await auditActions()).toEqual(expect.arrayContaining(["ACTION CASE_OPENED LAD-OPEN", "ACTION CASE_NOTIFIED LAD-NOTIFY"]));
  });

  it("waits demoCaseTimeoutSec (60 s) only while the demo world's clock is RUNNING", async () => {
    kit = await caseKit({ clockMode: "RUNNING" });
    await inbound(kit.world, "inst-rogelio", mx("2026-10-13 11:45"));
    const { caseItem } = await open();
    expect((await timersOf(caseItem.caseId))[0]?.dueAtSim).toBe(new Date(Date.parse(OPENED_AT) + 60_000).toISOString());
  });
});

describe("[FL-023] [FL-022] one case per order and reason", () => {
  it("returns the open case of the same reason without notifying anyone again", async () => {
    const first = await open("NOT_PROVISIONED");
    const second = await open("NOT_PROVISIONED");
    expect(second.existing).toBe(true);
    expect(second.caseItem.caseId).toBe(first.caseItem.caseId);
    expect(await kit.world.connector.cases.listCasesOfWorkOrder(ORDER)).toHaveLength(1);
    expect(kit.outbound.delivered().filter((line) => line.startsWith("CASE_NOTICE"))).toHaveLength(1);
    const other = await open("INSTALLER_ASKED");
    expect(other.existing).toBe(false);
    expect(await kit.world.connector.cases.listCasesOfWorkOrder(ORDER)).toHaveLength(2);
  });
});

describe("[FL-060] a rung that times out moves to the backup", () => {
  it("records TIMED_OUT, sends caso_reasignado to the backup with a new rungVersion and tells the installer", async () => {
    const { caseItem } = await open();
    const moved = await advanceLadder(kit.deps, caseItem.caseId, { kind: "TIMEOUT", rungVersion: 0, firedBy: "CLOCK" }, mx("2026-10-13 12:00"));
    expect(moved.status).toBe("MOVED");
    expect(moved.caseItem.rung).toBe("SECONDARY");
    expect(moved.caseItem.rungVersion).toBe(1);
    expect(ladderOf(moved.caseItem)).toEqual([
      ["PRIMARY", "NOTIFIED", "TEMPLATE"],
      ["PRIMARY", "TIMED_OUT", "CLOCK"],
      ["SECONDARY", "NOTIFIED", "TEMPLATE"],
    ]);
    const request = kit.outbound.sent.find((record) => record.request.personId === "sup-hector")?.request;
    expect(request?.form === "TEMPLATE" && request.templateName).toBe("caso_reasignado");
    expect(kit.outbound.sent.at(-1)?.request.form === "TEXT" && (kit.outbound.sent.at(-1)?.request as { text: string }).text).toBe(esMX.caseReassigned("Héctor"));
    expect(await timersOf(caseItem.caseId)).toContainEqual({ id: "SECONDARY", status: "SCHEDULED", dueAtSim: new Date(Date.parse(mx("2026-10-13 12:00")) + 600_000).toISOString(), rungVersion: 1 });
  });

  it("moves on when the armed timer fires, with the rungVersion of its payload", async () => {
    const { caseItem } = await open();
    const [timer] = kit.timers.armed;
    if (timer === undefined) throw new Error("no timer armed");
    expect(timer.payload).toEqual({ caseId: caseItem.caseId, rung: "PRIMARY", rungVersion: 0 });
    const moved = await onCaseTimeout(kit.deps, timer, timer.dueAtSim, "SCHEDULER");
    expect(moved.caseItem.rung).toBe("SECONDARY");
    expect(moved.caseItem.ladder[1]).toMatchObject({ rung: "PRIMARY", outcome: "TIMED_OUT", reason: "SCHEDULER" });
    expect((await onCaseTimeout(kit.deps, timer, timer.dueAtSim, "MANUAL")).status).toBe("STALE");
  });

  it("ignores and audits a timeout with an old rungVersion", async () => {
    const { caseItem } = await open();
    await advanceLadder(kit.deps, caseItem.caseId, { kind: "TIMEOUT", rungVersion: 0 }, mx("2026-10-13 12:00"));
    const before = kit.outbound.sent.length;
    const stale = await advanceLadder(kit.deps, caseItem.caseId, { kind: "TIMEOUT", rungVersion: 0 }, mx("2026-10-13 12:01"));
    expect(stale.status).toBe("STALE");
    expect(stale.caseItem.rung).toBe("SECONDARY");
    expect(kit.outbound.sent).toHaveLength(before);
    expect(await auditActions()).toContain("DENY CASE_TIMEOUT_IGNORED LAD-STALE");
  });
});

describe("[FL-061] the second timeout alerts the zone chief", () => {
  it("emails the zone chief, tells the installer, keeps the case OPEN in the console and arms nothing more", async () => {
    const { caseItem } = await open();
    await advanceLadder(kit.deps, caseItem.caseId, { kind: "TIMEOUT", rungVersion: 0 }, mx("2026-10-13 12:00"));
    const last = await advanceLadder(kit.deps, caseItem.caseId, { kind: "TIMEOUT", rungVersion: 1 }, mx("2026-10-13 12:10"));
    expect(last.caseItem).toMatchObject({ status: "OPEN", rung: "ZONE_CHIEF" });
    expect(kit.outbound.emails.map((email) => [email.request.variant, email.request.zoneChiefId, email.outcome.status])).toEqual([["UNATTENDED", "zc-marisol", "SENT"]]);
    expect((kit.outbound.sent.at(-1)?.request as { text: string }).text).toBe(esMX.caseToZoneChief);
    expect((await timersOf(caseItem.caseId)).filter((timer) => timer.status === "SCHEDULED")).toEqual([]);
    expect((await advanceLadder(kit.deps, caseItem.caseId, { kind: "TIMEOUT", rungVersion: last.caseItem.rungVersion }, mx("2026-10-13 12:20"))).status).toBe("STALE");
  });
});

describe('[FL-059] "No puedo" moves to the backup without waiting', () => {
  it("cancels the PRIMARY wait and notifies the backup at once", async () => {
    const { caseItem } = await open();
    const moved = await advanceLadder(kit.deps, caseItem.caseId, { kind: "DECLINED", personId: "sup-adriana" }, mx("2026-10-13 11:52"));
    expect(moved.caseItem.rung).toBe("SECONDARY");
    expect(ladderOf(moved.caseItem).map(([rung, outcome]) => `${rung} ${outcome}`)).toEqual(["PRIMARY NOTIFIED", "PRIMARY DECLINED", "SECONDARY NOTIFIED"]);
    const timers = await timersOf(caseItem.caseId);
    expect(timers.find((timer) => timer.id === "PRIMARY")?.status).toBe("CANCELLED");
    expect(timers.find((timer) => timer.id === "SECONDARY")?.status).toBe("SCHEDULED");
    expect(await auditActions()).toContain("ACTION CASE_DECLINED LAD-DECLINE");
  });

  it("ignores a decline of someone who is not on the current rung", async () => {
    const { caseItem } = await open();
    const stale = await advanceLadder(kit.deps, caseItem.caseId, { kind: "DECLINED", personId: "sup-hector" }, mx("2026-10-13 11:52"));
    expect(stale.status).toBe("STALE");
    expect(stale.caseItem.rung).toBe("PRIMARY");
  });
});

describe("[FL-006] a supervisor who opted out leaves the ladder", () => {
  it("skips the rung as OPTED_OUT and sends nothing to that supervisor", async () => {
    await optOut("sup-adriana");
    const { caseItem } = await open();
    expect(ladderOf(caseItem)).toEqual([
      ["PRIMARY", "SKIPPED", "OPTED_OUT"],
      ["SECONDARY", "NOTIFIED", "TEMPLATE"],
    ]);
    expect(kit.outbound.delivered()).not.toContainEqual(expect.stringContaining("sup-adriana"));
    const request = kit.outbound.sent.find((record) => record.request.personId === "sup-hector")?.request;
    expect(request?.form === "TEMPLATE" && request.templateName).toBe("caso_escalado");
    expect(await auditActions()).toContain("ACTION CASE_SKIPPED LAD-SKIP");
  });
});

describe("[FL-066] nobody reachable on the supervisors' rungs", () => {
  it("skips both and alerts the zone chief at once, with no timer", async () => {
    await optOut("sup-adriana");
    await optOut("sup-hector");
    const { caseItem } = await open();
    expect(ladderOf(caseItem)).toEqual([
      ["PRIMARY", "SKIPPED", "OPTED_OUT"],
      ["SECONDARY", "SKIPPED", "OPTED_OUT"],
      ["ZONE_CHIEF", "NOTIFIED", "EMAIL"],
    ]);
    expect(kit.outbound.emails).toHaveLength(1);
    expect(await timersOf(caseItem.caseId)).toEqual([]);
  });
});

describe('[FL-074] plan B: the case template is not approved and the supervisor sent "TURNO"', () => {
  it("sends the same body as an interactive message inside the shift window", async () => {
    await kit.world.connector.isps.setTemplateStatus(ISP, "caso_escalado", "REJECTED", { actor: "QA", atSim: mx("2026-10-13 07:00") });
    await inbound(kit.world, "sup-adriana", mx("2026-10-13 07:05"), { text: "TURNO" });
    const { caseItem } = await open();
    expect(ladderOf(caseItem)).toEqual([["PRIMARY", "NOTIFIED", "INTERACTIVE"]]);
    expect(kit.outbound.delivered()[0]).toBe("CASE_REQUEST:INTERACTIVE:sup-adriana");
    const rows = (await kit.world.connector.audit.listByWorkOrder(ORDER)).filter((row) => row.action === "SEND_WHATSAPP");
    const toAdriana = rows.filter((row) => row.messageId?.includes("PRIMARY")).map((row) => `${row.decision} ${row.ruleIds[0] ?? ""}`);
    expect(toAdriana[0]).toBe("DENY CP-TEMPLATE-APPROVED");
    expect(toAdriana[1]).toMatch(/^ALLOW/);
    expect(await auditActions()).toContain("ACTION CASE_NOTIFIED LAD-NOTIFY,LAD-PLANB");
  });
});

describe("[FL-075] template not approved and no window: the rung is skipped", () => {
  it("skips PRIMARY and SECONDARY as NO_CHANNEL and alerts the zone chief", async () => {
    await kit.world.connector.isps.setTemplateStatus(ISP, "caso_escalado", "REJECTED", { actor: "QA", atSim: mx("2026-10-13 07:00") });
    const { caseItem } = await open();
    expect(ladderOf(caseItem)).toEqual([
      ["PRIMARY", "SKIPPED", "NO_CHANNEL"],
      ["SECONDARY", "SKIPPED", "NO_CHANNEL"],
      ["ZONE_CHIEF", "NOTIFIED", "EMAIL"],
    ]);
    expect(kit.outbound.delivered().filter((line) => line.startsWith("CASE_REQUEST"))).toEqual([]);
  });
});

describe("[FL-054] cases that do not climb by WhatsApp", () => {
  it("keeps a CERTIFICATE_UNDELIVERED case in the console only", async () => {
    const { caseItem } = await open("CERTIFICATE_UNDELIVERED");
    expect(ladderOf(caseItem)).toEqual([["PRIMARY", "NOTIFIED", "CONSOLE_ONLY"]]);
    expect(kit.outbound.sent).toEqual([]);
    expect(await timersOf(caseItem.caseId)).toEqual([]);
  });
});
