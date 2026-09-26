import { describe, expect, it } from "vitest";
import { copy } from "../copy/console";
import { CONSOLE_HOME, ROUTES, activeNavId, isConsoleRoot, matchRoute, navRoutes, pathOf, routeAllows, routeHref } from "../routes";

// Console views of docs/build-plan.md §1 (landing, login and join are public; the tour is the
// shell's dock).
const CONSOLE_VIEWS = ["orders", "order-detail", "cases", "evidence", "people", "clock", "simulator", "outbox", "manual", "metrics", "audit"];

describe("route table", () => {
  it("has one route per console view, each with its title and description", () => {
    expect(ROUTES.map((route) => route.id).sort()).toEqual([...CONSOLE_VIEWS].sort());
    for (const route of ROUTES) {
      expect(copy.views[route.id].title.length).toBeGreaterThan(0);
      expect(copy.views[route.id].description.length).toBeGreaterThan(0);
    }
    for (const route of navRoutes("SUPERVISOR")) expect(routeHref(route)).not.toContain(":");
  });

  it("matches each pattern exactly and hands back the named segments", () => {
    expect(matchRoute("/app/orders")?.route.id).toBe("orders");
    expect(matchRoute("/app/orders/wo-24817")).toEqual({ route: expect.objectContaining({ id: "order-detail" }), params: { workOrderId: "wo-24817" } });
    expect(matchRoute("/app/cases/case-01")).toMatchObject({ route: { id: "cases" }, params: { caseId: "case-01" } });
    expect(matchRoute("/app/manual/COM-04")).toMatchObject({ route: { id: "manual" }, params: { sectionId: "COM-04" } });
    expect(matchRoute("/app/clock/")?.route.id).toBe("clock");
    expect(matchRoute("/app/orders/wo-24817/extra")).toBeUndefined();
    expect(matchRoute("/app/unknown")).toBeUndefined();
  });

  it("sends /app to the console's home", () => {
    expect(isConsoleRoot("/app")).toBe(true);
    expect(isConsoleRoot("/app/")).toBe(true);
    expect(isConsoleRoot("/app/orders")).toBe(false);
    expect(CONSOLE_HOME).toBe(pathOf("orders"));
  });

  it("lists the detail views under the view they come from", () => {
    expect(navRoutes("GUEST").map((route) => route.id)).not.toContain("order-detail");
    expect(activeNavId("/app/orders/wo-24817")).toBe("orders");
    expect(activeNavId("/app/cases/case-01")).toBe("cases");
    expect(activeNavId("/nowhere")).toBeUndefined();
  });

  it("opens every view to the three console roles and none to a principal without role", () => {
    for (const route of ROUTES) {
      for (const role of ["SUPERVISOR", "OPS", "GUEST"] as const) expect(routeAllows(route, role)).toBe(true);
      expect(routeAllows(route, undefined)).toBe(false);
    }
    expect(navRoutes(undefined)).toEqual([]);
  });
});
