// The local UI server's "Reiniciar demo" and "Saltar a escena" run the real world factory (W4 review,
// flows-tests B2): a reset reloads the world's orders, a scene seeds its state (the "Cerrar instalación"
// offer, the evidence photos the console opens, the case on its rung).
import { describe, expect, it } from "vitest";
import { GUEST_TEST_CLOCK_ID } from "@cuadrilla/shared";
import { createQaCaller } from "../../packages/bff/src/routers/index";
import { createUiApp } from "./app";

async function uiApp() {
  const app = await createUiApp({ origin: "http://127.0.0.1:0", pool: { userPoolId: "us-east-1_uiserver", clientIds: ["ui-server"] }, jwks: { keys: [] } });
  const guest = createQaCaller({ role: "GUEST", clockId: GUEST_TEST_CLOCK_ID }, app.deps);
  const orders = () => app.memory.client.dump("WorkOrders").filter((row) => row.entity === "WorkOrder" && row.clockId === GUEST_TEST_CLOCK_ID);
  return { app, guest, orders };
}

describe("UI server world factory [FL-084] [FL-086]", () => {
  it("[FL-086] Reiniciar demo reloads the world's orders at the next epoch", async () => {
    const { guest, orders } = await uiApp();
    const before = orders().map((row) => row.workOrderId).sort();
    expect(before.length).toBeGreaterThan(0);
    const reset = await guest.clock.reset();
    expect(reset.worldEpoch).toBe(reset.previousEpoch + 1);
    expect(orders().map((row) => row.workOrderId).sort()).toEqual(before);
    expect(orders().every((row) => row.worldEpoch === reset.worldEpoch)).toBe(true);
  });

  it("[FL-084] Saltar a escena seeds the scene: the CLOSE_INSTALLATION offer, the evidence objects, the case on its rung", async () => {
    const { app, guest } = await uiApp();
    const jumped = await guest.clock.jumpToScene({ sceneId: "checklist-completo" });
    const offers = app.memory.client.dump("Conversations").filter((row) => row.clockId === GUEST_TEST_CLOCK_ID && row.seeded === true && (row.refs as { offer?: string } | undefined)?.offer === "CLOSE_INSTALLATION");
    expect(offers).toHaveLength(1);
    const evidence = app.memory.client.dump("WorkOrders").filter((row) => row.entity === "Evidence" && row.clockId === GUEST_TEST_CLOCK_ID && row.worldEpoch === jumped.worldEpoch && row.seeded === true);
    expect(evidence.length).toBeGreaterThan(0);
    for (const row of evidence) expect((await app.ports.objects.get("Evidence", String(row.s3Key)))?.contentType).toBe("image/jpeg");
    await guest.clock.jumpToScene({ sceneId: "caso-con-supervisora" });
    const cases = app.memory.client.dump("Cases").filter((row) => row.entity === "Case" && row.clockId === GUEST_TEST_CLOCK_ID && row.status !== "CLOSED");
    expect(cases.map((row) => row.rung)).toContain("PRIMARY");
  });
});
