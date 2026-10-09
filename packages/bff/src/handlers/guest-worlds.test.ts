import { describe, expect, it } from "vitest";
import { ConnectorError, ToolError } from "@cuadrilla/shared";
import { createAccountOp, getGuestAccount } from "../guest/account";
import { guestHarness, type GuestHarness } from "../guest/testing";
import { buildWorld } from "../worlds/factory";
import { SIGNUP_CLOCK, SIGNUP_ISP, SIGNUP_USER, allRows } from "../worlds/testing";
import { type GuestWorldsDeps, failureDetail, handleGuestWorlds } from "./guest-worlds";

const REQUEST = { userId: SIGNUP_USER, clockId: SIGNUP_CLOCK, origin: "SIGNUP" } as const;

function depsOf(harness: GuestHarness, template?: () => Promise<string>): GuestWorldsDeps {
  const factory = harness.factoryDeps();
  return { client: harness.client, factory: template === undefined ? factory : { ...factory, template }, now: harness.now, log: harness.log };
}

async function openAccount(harness: GuestHarness, status: "PROVISIONING" | "CAP_FULL" | "FAILED" = "PROVISIONING", fields: Partial<{ userId: string; ispId: string; clockId: string; guestOrigin: "SIGNUP" | "INVITED" }> = {}): Promise<void> {
  const op = createAccountOp({ userId: SIGNUP_USER, guestOrigin: "SIGNUP", ispId: SIGNUP_ISP, clockId: SIGNUP_CLOCK, generation: 1, status, ...fields }, harness.now());
  await harness.client.transact([op], harness.now().toISOString());
}

describe("[FL-107] GuestWorlds", () => {
  it("[FL-107] builds the world of a PROVISIONING account and marks it READY within 60 s; a second invocation changes nothing", async () => {
    const harness = guestHarness();
    await openAccount(harness);
    expect(await handleGuestWorlds(depsOf(harness), REQUEST)).toEqual({ outcome: "READY" });
    expect(await getGuestAccount(harness.client, SIGNUP_USER)).toMatchObject({ status: "READY" });
    const ready = harness.lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((line) => line.message === "guest.world.ready");
    expect(ready).toMatchObject({ metric: "GuestWorldReadyMs" });
    expect(Number(ready?.value)).toBeLessThan(60_000);
    expect(await harness.connector.isps.getSettings(SIGNUP_ISP)).toMatchObject({ capsProfile: "SIGNUP", ownerUserId: SIGNUP_USER });

    const before = JSON.stringify(allRows(harness));
    expect(await handleGuestWorlds(depsOf(harness), REQUEST)).toEqual({ outcome: "ALREADY_READY" });
    expect(JSON.stringify(allRows(harness))).toBe(before);
  });

  it("[FL-107] a request for another generation than the account's, or without an account, is stale and builds nothing", async () => {
    const harness = guestHarness();
    expect(await handleGuestWorlds(depsOf(harness), REQUEST)).toEqual({ outcome: "STALE" });
    await openAccount(harness, "PROVISIONING", { ispId: "isp-guest-s261001fghij", clockId: "GUEST#isp-guest-s261001fghij" });
    expect(await handleGuestWorlds(depsOf(harness), REQUEST)).toEqual({ outcome: "STALE" });
    expect(await handleGuestWorlds(depsOf(harness), { ...REQUEST, clockId: "GUEST#isp-guest-s261001fghij", origin: "INVITED" })).toEqual({ outcome: "STALE" });
    expect(allRows(harness).filter(({ row }) => row.entity !== "GuestAccount")).toEqual([]);
  });

  it("[FL-112] an account waiting in CAP_FULL gets no world", async () => {
    const harness = guestHarness();
    await openAccount(harness, "CAP_FULL");
    expect(await handleGuestWorlds(depsOf(harness), REQUEST)).toEqual({ outcome: "NO_SLOT" });
    expect(await harness.connector.runtime.getClock(SIGNUP_CLOCK)).toBeUndefined();
  });

  it("[FL-107] a failed build leaves the account FAILED with its reason, and a retried request builds it", async () => {
    const harness = guestHarness();
    await openAccount(harness);
    expect(await handleGuestWorlds(depsOf(harness, async () => "{"), REQUEST)).toEqual({ outcome: "FAILED" });
    expect(await getGuestAccount(harness.client, SIGNUP_USER)).toMatchObject({ status: "FAILED", failure: "TEMPLATE_INVALID" });
    expect(await handleGuestWorlds(depsOf(harness), REQUEST)).toEqual({ outcome: "READY" });
  });

  it("[FL-107] a clock of the generation that belongs to another guest is a collision: FAILED, the other world untouched", async () => {
    const harness = guestHarness();
    await buildWorld(harness.factoryDeps(), { ispId: SIGNUP_ISP, origin: "SIGNUP", ownerUserId: "usr-g01K60000000000000000000009" });
    await harness.connector.seed.deleteItems("Isps", [{ PK: `ISP#${SIGNUP_ISP}`, SK: "SETTINGS" }]);
    await openAccount(harness);
    expect(await handleGuestWorlds(depsOf(harness), REQUEST)).toEqual({ outcome: "FAILED" });
    expect(await getGuestAccount(harness.client, SIGNUP_USER)).toMatchObject({ status: "FAILED", failure: "GENERATION_COLLISION" });
  });

  it("[FL-107] an invited guest's complete world is marked READY without being built again", async () => {
    const harness = guestHarness();
    await buildWorld(harness.factoryDeps(), { ispId: "isp-guest-07", origin: "INVITED" });
    const before = JSON.stringify(allRows(harness).filter(({ row }) => row.entity !== "GuestAccount"));
    await openAccount(harness, "PROVISIONING", { userId: "usr-guest-07", ispId: "isp-guest-07", clockId: "GUEST#isp-guest-07", guestOrigin: "INVITED" });
    expect(await handleGuestWorlds(depsOf(harness), { userId: "usr-guest-07", clockId: "GUEST#isp-guest-07", origin: "INVITED" })).toEqual({ outcome: "READY" });
    expect(JSON.stringify(allRows(harness).filter(({ row }) => row.entity !== "GuestAccount"))).toBe(before);
  });

  it("takes {userId, clockId, origin} and nothing else", async () => {
    const harness = guestHarness();
    await expect(handleGuestWorlds(depsOf(harness), { ...REQUEST, ispId: "isp-demo" })).rejects.toBeInstanceOf(ToolError);
    await expect(handleGuestWorlds(depsOf(harness), { ...REQUEST, clockId: "GLOBAL#isp-demo#x" })).rejects.toBeInstanceOf(ToolError);
  });

  it("[FL-111] QA_FORCE_EXPIRE ends only the generation of a QA run's sign-up account, builds nothing, and refuses any other account [W5 review B1]", async () => {
    const harness = guestHarness();
    const op = createAccountOp({ userId: SIGNUP_USER, guestOrigin: "SIGNUP", ispId: SIGNUP_ISP, clockId: SIGNUP_CLOCK, generation: 1, status: "READY", slotScope: "QA#qa-812-1" }, harness.now());
    await harness.client.transact([op], harness.now().toISOString());
    const expired = await handleGuestWorlds(depsOf(harness), { op: "QA_FORCE_EXPIRE", userId: SIGNUP_USER });
    expect(expired).toMatchObject({ outcome: "EXPIRED", userId: SIGNUP_USER, clockId: SIGNUP_CLOCK });
    expect(Date.parse((await getGuestAccount(harness.client, SIGNUP_USER))?.expiresAtReal ?? "")).toBeLessThan(harness.now().getTime());
    expect(allRows(harness).filter(({ row }) => row.entity !== "GuestAccount")).toEqual([]);

    const other = "usr-g01K60000000000000000000002";
    await openAccount(harness, "PROVISIONING", { userId: other });
    expect(await handleGuestWorlds(depsOf(harness), { op: "QA_FORCE_EXPIRE", userId: other })).toEqual({ outcome: "REFUSED", reason: "NOT_A_QA_ACCOUNT" });
    expect(await handleGuestWorlds(depsOf(harness), { op: "QA_FORCE_EXPIRE", userId: "usr-g01K60000000000000000000003" })).toEqual({ outcome: "REFUSED", reason: "NO_ACCOUNT" });
    await expect(handleGuestWorlds(depsOf(harness), { op: "QA_FORCE_EXPIRE", userId: "usr-guest-07" })).rejects.toBeInstanceOf(ToolError);
    await expect(handleGuestWorlds(depsOf(harness), { op: "QA_FORCE_EXPIRE", userId: SIGNUP_USER, expiresAtReal: "2020-01-01T00:00:00.000Z" })).rejects.toBeInstanceOf(ToolError);
  });

  it("[FL-105] a failure is logged with the store's code, table and cause, never a row", () => {
    const cause = Object.assign(new Error("denied"), { name: "AccessDeniedException" });
    expect(failureDetail(new ConnectorError("UNAVAILABLE", "dynamodb failure on Runtime", "Runtime", { cause }))).toEqual({ error: "ConnectorError", code: "UNAVAILABLE", table: "Runtime", cause: "AccessDeniedException" });
    expect(failureDetail(new RangeError("x"))).toEqual({ error: "RangeError" });
    expect(failureDetail("boom")).toEqual({ error: "unknown" });
  });
});
