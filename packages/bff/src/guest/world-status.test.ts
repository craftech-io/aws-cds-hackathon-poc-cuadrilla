import { describe, expect, it } from "vitest";
import { resolveBrand } from "../copy/brand";
import { buildWorld } from "../worlds/factory";
import { NEUTRAL, SIGNUP_CLOCK, SIGNUP_ISP, SIGNUP_USER } from "../worlds/testing";
import { createAccountOp, setStatus } from "./account";
import { guestHarness, type GuestHarness } from "./testing";
import { type GuestPrincipal, RETRY_PROVISIONING_AFTER_MS, worldStatusOf } from "./world-status";

const SIGNUP: GuestPrincipal = { role: "GUEST", isGuest: true, ispId: SIGNUP_ISP, userId: SIGNUP_USER, clockId: SIGNUP_CLOCK };
const INVITED: GuestPrincipal = { role: "GUEST", isGuest: true, ispId: "isp-guest-07", userId: "usr-guest-07", clockId: "GUEST#isp-guest-07" };
const DAY_MS = 86_400_000;

async function account(harness: GuestHarness, status: "PROVISIONING" | "READY" | "FAILED" | "CAP_FULL", principal: GuestPrincipal = SIGNUP, origin: "SIGNUP" | "INVITED" = "SIGNUP"): Promise<void> {
  await harness.client.transact([createAccountOp({ userId: principal.userId, guestOrigin: origin, ispId: principal.ispId, clockId: principal.clockId, generation: 1, status }, harness.now())], harness.now().toISOString());
}

const ports = (harness: GuestHarness) => ({ client: harness.client, connector: harness.connector, now: harness.now });

describe("[FL-107] the state of a guest's world for its portada", () => {
  it("[FL-107] PROVISIONING, FAILED and CAP_FULL, with the dates and the deletion of a sign-up guest", async () => {
    const harness = guestHarness();
    await account(harness, "PROVISIONING");
    expect(await worldStatusOf(ports(harness), SIGNUP)).toEqual({
      status: "PROVISIONING",
      origin: "SIGNUP",
      canDeleteAccount: true,
      canRetry: false,
      refreshSession: false,
      createdAtReal: "2026-10-01T15:00:00.000Z",
      expiresAtReal: "2026-10-08T15:00:00.000Z",
    });
    harness.advance(RETRY_PROVISIONING_AFTER_MS);
    expect((await worldStatusOf(ports(harness), SIGNUP)).canRetry).toBe(true);
    await setStatus(harness.client, SIGNUP_USER, { to: "FAILED", clockId: SIGNUP_CLOCK }, harness.now());
    expect(await worldStatusOf(ports(harness), SIGNUP)).toMatchObject({ status: "FAILED", canRetry: true });
    await setStatus(harness.client, SIGNUP_USER, { to: "CAP_FULL", clockId: SIGNUP_CLOCK }, harness.now());
    expect(await worldStatusOf(ports(harness), SIGNUP)).toMatchObject({ status: "CAP_FULL", canRetry: true });
  });

  it("[FL-107] READY: the operator's visible name, the seeded installers and supervisors, the orders of the simulated day and its time", async () => {
    const harness = guestHarness();
    await buildWorld(harness.factoryDeps(), { ispId: SIGNUP_ISP, origin: "SIGNUP", ownerUserId: SIGNUP_USER });
    await account(harness, "READY");
    const view = await worldStatusOf(ports(harness), SIGNUP);
    expect(view).toMatchObject({ status: "READY", canRetry: false, canDeleteAccount: true });
    expect(view.summary).toMatchObject({ operatorName: resolveBrand(NEUTRAL).operatorName, supervisors: 4, simNow: "2026-10-13T07:00:00-06:00" });
    expect(view.summary?.installers).toContain("Rogelio Méndez");
    expect(view.summary?.installers).toHaveLength(4);
    expect(view.summary?.workOrders).toBeGreaterThan(0);
    // No raw id reaches the portada.
    expect(JSON.stringify(view.summary)).not.toMatch(/\b(?:isp|usr|wo|inst|sup)-/);
  });

  it("[FL-107] an invited guest never sees the expiry nor the deletion; a world built before its account row is READY", async () => {
    const harness = guestHarness();
    await account(harness, "PROVISIONING", INVITED, "INVITED");
    const view = await worldStatusOf(ports(harness), INVITED);
    expect(view).toMatchObject({ status: "PROVISIONING", origin: "INVITED", canDeleteAccount: false });
    expect(view.expiresAtReal).toBeUndefined();
    const fresh = guestHarness();
    expect(await worldStatusOf(ports(fresh), INVITED)).toMatchObject({ status: "PROVISIONING", canRetry: true });
    await buildWorld(fresh.factoryDeps(), { ispId: "isp-guest-07", origin: "INVITED" });
    expect(await worldStatusOf(ports(fresh), INVITED)).toMatchObject({ status: "READY", canDeleteAccount: false });
  });

  it("[FL-111] a sign-up world past its 7 days, with the session still alive, asks for a retry; an older session is told to refresh", async () => {
    const harness = guestHarness();
    await account(harness, "READY");
    harness.advance(7 * DAY_MS);
    expect(await worldStatusOf(ports(harness), SIGNUP)).toMatchObject({ status: "FAILED", canRetry: true });
    expect(await worldStatusOf(ports(harness), { ...SIGNUP, ispId: "isp-guest-s260920aaaaa", clockId: "GUEST#isp-guest-s260920aaaaa" })).toMatchObject({ refreshSession: true });
  });
});
