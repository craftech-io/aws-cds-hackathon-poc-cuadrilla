import { describe, expect, it } from "vitest";
import { ROUTES } from "../routes";
import { type ModuleOf, type ViewProps, PANELS, VIEWS, createModuleRegistry } from "./view-registry";

const load = () => Promise.resolve<ModuleOf<ViewProps>>({ default: () => null });

describe("createModuleRegistry", () => {
  it("finds a module by the directory of its view and hands back one lazy component per view", () => {
    const registry = createModuleRegistry<ViewProps>({ "../views/orders/view.tsx": load, "../views/order-detail/view.tsx": load });
    expect(registry.names).toEqual(["order-detail", "orders"]);
    const first = registry.component("orders");
    expect(first).toBeDefined();
    expect(registry.component("orders")).toBe(first);
    expect(registry.component("order-detail")).not.toBe(first);
  });

  it("has nothing for a view that does not exist yet, nor for a path outside views/", () => {
    const registry = createModuleRegistry<ViewProps>({ "../lib/view.tsx": load, "../views/Bad_Name/view.tsx": load });
    expect(registry.names).toEqual([]);
    expect(registry.component("cases")).toBeUndefined();
  });
});

describe("the views of this build", () => {
  it("every view module belongs to a console route or a public page", () => {
    const known = new Set<string>([...ROUTES.map((route) => route.id), "join"]);
    for (const name of VIEWS.names) expect(known).toContain(name);
    for (const name of PANELS.names) expect(name).toBe("tour");
  });
});
