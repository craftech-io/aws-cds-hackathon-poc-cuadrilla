import { describe, expect, it } from "vitest";
import { getGuestAccount } from "../guest/account";
import { SIGNUP_WORLD_LIMITS, worldsDayKey } from "../guest/slots";
import { EMAIL, QA_EMAIL, SUB, confirmationEvent, guestHarness, hashOf, pendingLead, type GuestHarness } from "../guest/testing";
import { signupUserId, username } from "../leads/testing";
import { createPostConfirmationHandler } from "./post-confirmation";

const USER_ID = signupUserId(1);

function handlerOf(harness: GuestHarness, suffixes?: string[]) {
  return createPostConfirmationHandler({ confirmation: () => harness.confirmationDeps(suffixes), newLogger: () => harness.log });
}

const guestRows = (harness: GuestHarness) => harness.client.dump("Isps").filter((row) => row.entity === "ConsoleUser");
const ignoredLog = (harness: GuestHarness) => harness.leads.table.logs;

describe("[FL-105] post confirmation: a confirmed sign-up becomes a guest with a world", () => {
  it("[FL-105] a gst-* user with a pending lead that lists it: registry row GUEST/SIGNUP, SIGNUPSUB#, account PROVISIONING, lead CONFIRMED, GuestWorlds asked asynchronously", async () => {
    const harness = guestHarness();
    await pendingLead(harness);
    const event = confirmationEvent();
    const started = Date.now();
    const answer = await handlerOf(harness, ["abcde"])(event);
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(answer).toBe(event);

    const [row] = guestRows(harness);
    expect(guestRows(harness)).toHaveLength(1);
    expect(row).toMatchObject({ PK: "ISP#isp-guest-s261001abcde", SK: `USER#${USER_ID}`, role: "GUEST", guestOrigin: "SIGNUP", cognitoUsername: username(1), cognitoSub: SUB, cognitoSubKey: `SUB#${SUB}`, name: "Invitado" });
    expect(row).not.toHaveProperty("expiresAt");
    expect(row).not.toHaveProperty("email");
    expect(harness.client.dump("Isps").find((item) => item.SK === "META")).toMatchObject({ ispId: "isp-guest-s261001abcde", kind: "GUEST", world: "guest" });
    expect(await harness.client.get("Runtime", { PK: `SIGNUPSUB#${SUB}`, SK: "META" })).toMatchObject({ userId: USER_ID, username: username(1) });
    expect(await getGuestAccount(harness.client, USER_ID)).toMatchObject({ guestOrigin: "SIGNUP", clockId: "GUEST#isp-guest-s261001abcde", status: "PROVISIONING", generation: 1, slotDay: "261001", slotScope: "PUBLIC", expiresAtReal: "2026-10-08T15:00:00.000Z" });
    const lead = await harness.leads.store.get(hashOf(EMAIL));
    expect(lead).toMatchObject({ status: "CONFIRMED", cognitoSub: SUB, cognitoUsername: username(1), userId: USER_ID });
    expect(harness.provisioner.requests).toEqual([{ userId: USER_ID, clockId: "GUEST#isp-guest-s261001abcde", origin: "SIGNUP" }]);
    const counters = await harness.client.get("Runtime", { PK: `SIGNUPKEY#${lead?.abuseHash ?? ""}`, SK: "META" });
    expect(counters).toMatchObject({ confirmedAccounts: 1 });
    expect(await harness.client.get("Runtime", { PK: worldsDayKey("PUBLIC", "261001"), SK: "META" })).toMatchObject({ count: 1 });
    expect(harness.lines.join("\n")).not.toContain(EMAIL);
  });

  it("[FL-105] the same confirmation twice → one row, one account, one lead confirmation", async () => {
    const harness = guestHarness();
    await pendingLead(harness);
    await handlerOf(harness, ["abcde"])(confirmationEvent());
    await handlerOf(harness, ["fghij"])(confirmationEvent());
    expect(guestRows(harness)).toHaveLength(1);
    expect(harness.client.dump("Isps").filter((item) => item.SK === "META")).toHaveLength(1);
    expect(harness.provisioner.requests).toHaveLength(2);
    expect(new Set(harness.provisioner.requests.map((request) => request.clockId)).size).toBe(1);
  });

  it("[FL-105] a retry after the registry was written but not the lead finishes the lead, with still one row", async () => {
    const harness = guestHarness();
    await pendingLead(harness);
    const leadsDown = { ...harness.leads.store, confirm: async () => Promise.reject(new Error("the leads table did not answer")) };
    const failing = createPostConfirmationHandler({ confirmation: () => ({ ...harness.confirmationDeps(["abcde"]), leads: leadsDown }), newLogger: () => harness.log });
    await expect(failing(confirmationEvent())).rejects.toThrow();
    expect((await harness.leads.store.get(hashOf(EMAIL)))?.status).toBeUndefined();
    await handlerOf(harness, ["fghij"])(confirmationEvent());
    expect((await harness.leads.store.get(hashOf(EMAIL)))?.status).toBe("CONFIRMED");
    expect(guestRows(harness)).toHaveLength(1);
    expect(harness.provisioner.requests.map((request) => request.clockId)).toEqual(["GUEST#isp-guest-s261001abcde"]);
  });

  it("[FL-122] an account made by AdminCreateUser finishing its first password (guest-07, an internal user) → no row, no world, SIGNUP_CONFIRM_IGNORED without email", async () => {
    const harness = guestHarness();
    await pendingLead(harness);
    for (const userName of ["guest-07", "supervisora-ana"]) {
      const event = confirmationEvent({ userName, sub: `sub-${userName}` });
      expect(await handlerOf(harness)(event)).toBe(event);
    }
    expect(guestRows(harness)).toEqual([]);
    expect(harness.provisioner.requests).toEqual([]);
    const log = ignoredLog(harness);
    expect(log.map((entry) => [entry.kind, entry.reason, entry.sub])).toEqual([
      ["SIGNUP_CONFIRM_IGNORED", "NOT_SIGNUP_USER", "sub-guest-07"],
      ["SIGNUP_CONFIRM_IGNORED", "NOT_SIGNUP_USER", "sub-supervisora-ana"],
    ]);
    expect(JSON.stringify(log)).not.toContain(EMAIL);
    expect((await harness.leads.store.get(hashOf(EMAIL)))?.status).toBeUndefined();
  });

  it("[FL-122] a gst-* without a lead, with a lead that does not list it, with a sub that already has a row, or another trigger source → nothing", async () => {
    const harness = guestHarness();
    await handlerOf(harness)(confirmationEvent());
    await pendingLead(harness, { user: 2 });
    await handlerOf(harness)(confirmationEvent({ user: 3 }));
    await harness.client.put("Isps", { PK: "ISP#isp-guest-07", SK: "USER#usr-guest-07", entity: "ConsoleUser", ispId: "isp-guest-07", userId: "usr-guest-07", role: "GUEST", name: "Invitado 07", cognitoSub: "sub-taken", cognitoSubKey: "SUB#sub-taken", active: true, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", version: 1 });
    await handlerOf(harness)(confirmationEvent({ user: 2, sub: "sub-taken" }));
    await handlerOf(harness)(confirmationEvent({ user: 2, triggerSource: "PostConfirmation_ConfirmForgotPassword" }));
    expect(guestRows(harness).map((row) => row.userId)).toEqual(["usr-guest-07"]);
    expect(harness.provisioner.requests).toEqual([]);
    expect(ignoredLog(harness).map((entry) => entry.reason)).toEqual(["NO_PENDING_LEAD", "NO_PENDING_LEAD", "SUB_REGISTERED", "NOT_CONFIRM_SIGNUP"]);
  });

  it("[FL-112] with the cap of active sign-up worlds full: account and lead created, world CAP_FULL, GuestWorlds not asked", async () => {
    const harness = guestHarness();
    await harness.client.put("Runtime", { PK: worldsDayKey("PUBLIC", "260930"), SK: "META", count: SIGNUP_WORLD_LIMITS.activeWorlds });
    await pendingLead(harness);
    await handlerOf(harness, ["abcde"])(confirmationEvent());
    expect(guestRows(harness)).toHaveLength(1);
    expect(await getGuestAccount(harness.client, USER_ID)).toMatchObject({ status: "CAP_FULL" });
    expect((await getGuestAccount(harness.client, USER_ID))?.slotDay).toBeUndefined();
    expect((await harness.leads.store.get(hashOf(EMAIL)))?.status).toBe("CONFIRMED");
    expect(harness.provisioner.requests).toEqual([]);
  });

  it("an address of the QA seam takes the slots of the QA scope, never the public ones", async () => {
    const harness = guestHarness();
    await pendingLead(harness, { email: QA_EMAIL });
    await handlerOf(harness, ["abcde"])(confirmationEvent({ email: QA_EMAIL }));
    expect(await getGuestAccount(harness.client, USER_ID)).toMatchObject({ status: "PROVISIONING", slotScope: "QA" });
    expect(await harness.client.get("Runtime", { PK: worldsDayKey("QA", "261001"), SK: "META" })).toMatchObject({ count: 1 });
    expect(await harness.client.get("Runtime", { PK: worldsDayKey("PUBLIC", "261001"), SK: "META" })).toBeUndefined();
  });

  it("a generation id already taken is retried with another suffix", async () => {
    const harness = guestHarness();
    await harness.client.put("Isps", { PK: "ISP#isp-guest-s261001abcde", SK: "META", entity: "Isp", ispId: "isp-guest-s261001abcde" });
    await pendingLead(harness);
    await handlerOf(harness, ["abcde", "bcdef"])(confirmationEvent());
    expect(await getGuestAccount(harness.client, USER_ID)).toMatchObject({ clockId: "GUEST#isp-guest-s261001bcdef" });
  });
});
