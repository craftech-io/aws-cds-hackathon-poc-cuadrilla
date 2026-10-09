import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import type { RouterOutputs } from "../../lib/trpc-router";
import { ordersCopy } from "./copy";
import { clockTime, dayLabel, dbm, nearbyDays, rangeText, simDateTime, windowText } from "./format";
import { CHECKLIST_ORDER, checklistItemLabel, labelOf, workOrderStatusLabel } from "./labels";
import { type OrderRow, OrdersPage, checklistMarks, checklistProgress, crewIdsOf, crewLabel, filterOptions, filterRows, fullName, inScope, orderHref } from "./orders-model";

function row(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    workOrderId: "wo-24817",
    workOrderNumber: "24817",
    status: "SCHEDULED",
    crewId: "crew-n3",
    installer: { personId: "inst-rogelio", firstName: "Rogelio", lastName: "Méndez" },
    customer: { firstName: "Lucía", lastName: "Treviño", neighborhood: "Las Lomitas" },
    window: { startSim: "2026-10-13T09:00:00-06:00", endSim: "2026-10-13T11:00:00-06:00" },
    plan: "Fibra 300",
    checklist: [],
    onu: null,
    openCases: 0,
    onHoldSafety: false,
    mainStory: false,
    ...overrides,
  };
}

describe("orders.list at the edge [FL-080]", () => {
  it("[FL-080] reads what the BFF answers, the main story's flag included, and refuses a malformed answer", () => {
    const answer = {
      day: "2026-10-13",
      simNow: "2026-10-13T07:00:00-06:00",
      workOrders: [{ ...row({ mainStory: true }), onu: { operState: "ONLINE", rxPowerDbm: -21.4, txPowerDbm: 2.1, inRange: true, observedAtSim: "2026-10-13T09:40:00-06:00", source: "AGENT" } }],
    };
    const page = OrdersPage.parse(answer);
    expect(page.workOrders[0]?.mainStory).toBe(true);
    expect(page.workOrders[0]?.onu).toEqual({ operState: "ONLINE", rxPowerDbm: -21.4, inRange: true });
    expect(OrdersPage.safeParse({ ...answer, simNow: "13/10 07:00" }).success).toBe(false);
  });

  it("[FL-080] the contract matches the router's answer type", () => {
    expectTypeOf<RouterOutputs["orders"]["list"]>().toExtend<z.input<typeof OrdersPage>>();
  });
});

describe("orders filters [FL-080]", () => {
  const rows = [
    row({ workOrderId: "a", status: "SCHEDULED" }),
    row({ workOrderId: "b", status: "IN_PROGRESS", openCases: 1 }),
    row({ workOrderId: "c", status: "CLOSED" }),
    row({ workOrderId: "d", status: "IN_PROGRESS", onHoldSafety: true, openCases: 2 }),
    row({ workOrderId: "e", status: "FAILED_VISIT" }),
  ];

  it("[FL-080] status and open cases filter together; an order on hold for safety counts as an incident, not as work to do", () => {
    expect(filterRows(rows, "OPEN", "ALL").map((found) => found.workOrderId)).toEqual(["a", "b"]);
    expect(filterRows(rows, "ISSUES", "ALL").map((found) => found.workOrderId)).toEqual(["d", "e"]);
    expect(filterRows(rows, "ALL", "WITH_CASES").map((found) => found.workOrderId)).toEqual(["b", "d"]);
    expect(filterRows(rows, "OPEN", "WITH_CASES").map((found) => found.workOrderId)).toEqual(["b"]);
  });

  it("[FL-080] each pill is counted over what the other filter leaves", () => {
    const { statusOptions, caseOptions } = filterOptions(rows, "ALL", "WITH_CASES", ordersCopy.filters);
    expect(statusOptions.map((option) => [option.value, option.count])).toEqual([
      ["ALL", 2],
      ["OPEN", 1],
      ["CLOSED", 0],
      ["ISSUES", 1],
    ]);
    expect(caseOptions.map((option) => [option.value, option.count])).toEqual([
      ["ALL", 5],
      ["WITH_CASES", 2],
    ]);
    expect(statusOptions[0]?.label).toBe("Todas");
  });

  it("[FL-080] the scope's crew filters on screen; no crew keeps every row", () => {
    const two = [row({ workOrderId: "a" }), row({ workOrderId: "b", crewId: "crew-s1" })];
    expect(inScope(two, undefined)).toHaveLength(2);
    expect(inScope(two, "crew-s1").map((found) => found.workOrderId)).toEqual(["b"]);
    expect(crewIdsOf([...two, row({ workOrderId: "c" })])).toEqual(["crew-n3", "crew-s1"]);
  });

  it("[FL-080] a crew reads as its roster's name, or by its place while the name is unknown; never its id", () => {
    expect(crewLabel("crew-n3", { "crew-n3": "Equipo Norte 3" }, ["crew-n3"], ordersCopy.scope.crewFallback)).toBe("Equipo Norte 3");
    expect(crewLabel("crew-s1", {}, ["crew-n3", "crew-s1"], ordersCopy.scope.crewFallback)).toBe("Equipo 2");
  });
});

describe("checklist marks [FL-080]", () => {
  it("[FL-080] five marks in closing order; a manual validation counts as done and a missing item as pending", () => {
    const marks = checklistMarks([
      { item: "CUSTOMER_OK", status: "PASSED" },
      { item: "ONU_LABEL_PHOTO", status: "REJECTED" },
      { item: "POWER_READING_PHOTO", status: "OVERRIDDEN" },
      { item: "ROSETTE_PHOTO", status: "IN_REVIEW" },
    ]);
    expect(marks.map((mark) => mark.item)).toEqual(CHECKLIST_ORDER);
    expect(marks.map((mark) => mark.state)).toEqual(["pending", "done", "rejected", "review", "done"]);
    expect(marks[2]?.label).toBe("Foto de la etiqueta: Rechazado");
    expect(checklistProgress([{ item: "CUSTOMER_OK", status: "PASSED" }, { item: "ONU_ONLINE", status: "PASSED" }])).toEqual({ done: 2, total: 5 });
  });
});

describe("how the views write it [FL-080]", () => {
  it("[FL-080] times from the instant's own offset, power with the true minus sign and a decimal comma", () => {
    expect(clockTime("2026-10-13T09:20:00-06:00")).toBe("09:20");
    expect(clockTime("not a time")).toBe("—");
    expect(simDateTime("2026-10-13T09:20:00-06:00")).toBe("mar 13/10 09:20");
    expect(windowText({ startSim: "2026-10-13T09:00:00-06:00", endSim: "2026-10-13T11:00:00-06:00" })).toBe("09:00–11:00");
    expect(dbm(-21.4)).toBe("−21,4 dBm");
    expect(dbm(null)).toBe("—");
    expect(rangeText({ minDbm: -25, maxDbm: -8 })).toBe("−25 a −8 dBm");
    expect(fullName({ firstName: "Rogelio", lastName: "Méndez" })).toBe("Rogelio Méndez");
    expect(fullName(null)).toBe("—");
  });

  it("[FL-080] the world's day first, then yesterday and tomorrow, labelled as a person reads them", () => {
    expect(nearbyDays("2026-10-13")).toEqual(["2026-10-13", "2026-10-12", "2026-10-14"]);
    expect(dayLabel("2026-10-13", "2026-10-13", "hoy")).toBe("mar 13/10 (hoy)");
    expect(dayLabel("2026-10-12", "2026-10-13", "hoy")).toBe("lun 12/10");
  });

  it("[FL-080] every status has a label, an unknown code falls back and never shows raw, and links are built from the console prefix", () => {
    expect(Object.keys(workOrderStatusLabel)).toHaveLength(7);
    expect(Object.keys(checklistItemLabel)).toEqual(expect.arrayContaining([...CHECKLIST_ORDER]));
    expect(labelOf({ A: "uno" }, "NEW_CODE", "Otro")).toBe("Otro");
    expect(labelOf({ A: "uno" }, null, "Otro")).toBe("Otro");
    expect(orderHref("wo-24817")).toBe("/app/orders/wo-24817");
  });
});
