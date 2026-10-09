import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import type { RouterOutputs } from "../../lib/trpc-router";
import { CaseDetail, CaseList, type CaseSummary, caseActions, caseHref, filterCases, isConsoleOnly, ladderOf, matchesStatus, reasonsOf } from "./cases-model";

const T = (time: string) => `2026-10-13T${time}:00-06:00`;

function summary(overrides: Partial<CaseSummary> = {}): CaseSummary {
  return {
    caseId: "case-1",
    workOrderId: "wo-24818",
    workOrderNumber: "24818",
    installer: "Rogelio Méndez",
    kind: "ESCALATION",
    reason: "DIAGNOSIS_ATTEMPTS",
    status: "OPEN",
    rung: "PRIMARY",
    takenBy: null,
    createdAtSim: T("11:50"),
    closedAtSim: null,
    ...overrides,
  };
}

const roster = { primary: "Adriana Solís", secondary: "Héctor Ibarra", zoneChief: "Marisol Cárdenas" };

describe("cases at the edge [FL-065]", () => {
  it("[FL-065] the inbox and the detail read what the BFF answers", () => {
    expect(CaseList.parse([summary(), summary({ caseId: "case-2", status: "TAKEN", takenBy: "Héctor Ibarra" })])).toHaveLength(2);
    const detail = CaseDetail.parse({
      ...summary({ rung: "SECONDARY" }),
      summary: "luz PON apagada después de 3 pasos",
      hazardCategory: null,
      roster,
      ladder: [{ rung: "PRIMARY", outcome: "NOTIFIED", personId: "sup-adriana", channel: "TEMPLATE", messageId: "m-1", atSim: T("11:50"), person: "Adriana Solís" }],
      pendingTimeout: { dueAtSim: T("12:10"), rung: "SECONDARY" },
      bridge: { open: false, pendingRelays: 0 },
      messages: [],
      closeSummary: null,
      evidenceIds: [],
    });
    expect(detail.ladder[0]?.person).toBe("Adriana Solís");
  });

  it("[FL-065] the contracts match the router's answer types", () => {
    expectTypeOf<RouterOutputs["cases"]["list"]>().toExtend<z.input<typeof CaseList>>();
    expectTypeOf<RouterOutputs["cases"]["get"]>().toExtend<z.input<typeof CaseDetail>>();
  });
});

describe("the inbox [FL-051] [FL-065]", () => {
  const rows = [
    summary({ caseId: "a" }),
    summary({ caseId: "b", status: "TAKEN" }),
    summary({ caseId: "c", status: "CLOSED", reason: "PHOTO_ATTEMPTS" }),
    summary({ caseId: "d", reason: "CERTIFICATE_UNDELIVERED" }),
  ];

  it("[FL-065] open or taken by default; each status alone; every case", () => {
    expect(filterCases(rows, "ACTIVE", "ALL").map((row) => row.caseId)).toEqual(["a", "b", "d"]);
    expect(filterCases(rows, "CLOSED", "ALL").map((row) => row.caseId)).toEqual(["c"]);
    expect(filterCases(rows, "ALL", "DIAGNOSIS_ATTEMPTS").map((row) => row.caseId)).toEqual(["a", "b"]);
    expect(matchesStatus({ status: "TAKEN" }, "OPEN")).toBe(false);
  });

  it("[FL-051] the reasons on offer are the ones present, counted; an undelivered certificate is a console-only case", () => {
    expect(reasonsOf(rows)).toEqual([
      { reason: "DIAGNOSIS_ATTEMPTS", count: 2 },
      { reason: "PHOTO_ATTEMPTS", count: 1 },
      { reason: "CERTIFICATE_UNDELIVERED", count: 1 },
    ]);
    expect(isConsoleOnly("CERTIFICATE_UNDELIVERED")).toBe(true);
    expect(isConsoleOnly("SAFETY")).toBe(false);
  });
});

describe("the ladder, rung by rung [FL-055] [FL-065]", () => {
  it("[FL-065] a case that moved to the backup: the primary notified and timed out, the backup current with its timeout pending, the zone chief ahead", () => {
    const rungs = ladderOf({
      rung: "SECONDARY",
      status: "OPEN",
      roster,
      pendingTimeout: { dueAtSim: T("12:10"), rung: "SECONDARY" },
      ladder: [
        { rung: "PRIMARY", outcome: "NOTIFIED", person: "Adriana Solís", channel: "TEMPLATE", atSim: T("11:50") },
        { rung: "PRIMARY", outcome: "TIMED_OUT", person: "Adriana Solís", atSim: T("12:00") },
        { rung: "SECONDARY", outcome: "NOTIFIED", person: "Héctor Ibarra", channel: "TEMPLATE", atSim: T("12:00") },
      ],
    });
    expect(rungs.map((rung) => [rung.rung, rung.current, rung.ahead, rung.steps.map((step) => step.outcome)])).toEqual([
      ["PRIMARY", false, false, ["NOTIFIED", "TIMED_OUT"]],
      ["SECONDARY", true, false, ["NOTIFIED"]],
      ["ZONE_CHIEF", false, true, []],
    ]);
    expect(rungs[1]?.pendingDueAtSim).toBe(T("12:10"));
    expect(rungs[2]?.person).toBe("Marisol Cárdenas");
  });

  it("[FL-055] a skipped rung keeps its reason and is not 'ahead'; a taken case has no rung pending", () => {
    const rungs = ladderOf({
      rung: "SECONDARY",
      status: "TAKEN",
      roster: { ...roster, primary: null },
      pendingTimeout: null,
      ladder: [
        { rung: "PRIMARY", outcome: "SKIPPED", person: null, reason: "NO_CHANNEL", atSim: T("11:50") },
        { rung: "SECONDARY", outcome: "NOTIFIED", person: "Héctor Ibarra", channel: "TEMPLATE", atSim: T("11:50") },
        { rung: "SECONDARY", outcome: "TAKEN", person: "Héctor Ibarra", channel: "CONSOLE", atSim: T("11:52") },
      ],
    });
    expect(rungs[0]).toMatchObject({ person: null, ahead: false, steps: [{ outcome: "SKIPPED", reason: "NO_CHANNEL" }] });
    expect(rungs[1]).toMatchObject({ current: true, pendingDueAtSim: null });
    const closed = ladderOf({ rung: "SECONDARY", status: "CLOSED", roster, pendingTimeout: null, ladder: [] });
    expect(closed.some((rung) => rung.current)).toBe(false);
  });
});

describe("Tomar and Cerrar from the console [FL-065]", () => {
  it("[FL-065] supervisors and guests take an open case and close a taken one; operations staff never act", () => {
    expect(caseActions("SUPERVISOR", "OPEN")).toEqual({ take: true, close: false });
    expect(caseActions("GUEST", "TAKEN")).toEqual({ take: false, close: true });
    expect(caseActions("SUPERVISOR", "CLOSED")).toEqual({ take: false, close: false });
    expect(caseActions("OPS", "OPEN")).toEqual({ take: false, close: false });
    expect(caseHref("case-01M4")).toBe("/app/cases/case-01M4");
  });
});
