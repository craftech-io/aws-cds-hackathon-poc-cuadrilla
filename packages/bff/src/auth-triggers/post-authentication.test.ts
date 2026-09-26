import { describe, expect, it } from "vitest";
import { MemoryTableClient } from "../connector/memory/table-client";
import { getGuestAccount } from "../guest/account";
import { EMAIL, SUB, authenticationEvent, confirmationEvent, guestHarness, hashOf, pendingLead, type GuestHarness } from "../guest/testing";
import { signupUserId } from "../leads/testing";
import { allRows } from "../worlds/testing";
import { createPostAuthenticationHandler } from "./post-authentication";
import { createPostConfirmationHandler } from "./post-confirmation";

const USER_ID = signupUserId(1);
const DAY_MS = 86_400_000;
const META = { createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", version: 1 };

function signIn(harness: GuestHarness, suffixes?: string[]) {
  return createPostAuthenticationHandler({ signIn: () => harness.signInDeps(suffixes), newLogger: () => harness.log });
}

async function signupGuest(harness: GuestHarness): Promise<void> {
  await pendingLead(harness);
  await createPostConfirmationHandler({ confirmation: () => harness.confirmationDeps(["abcde"]), newLogger: () => harness.log })(confirmationEvent());
  harness.provisioner.requests.length = 0;
}

async function staffRow(harness: GuestHarness, fields: { readonly ispId: string; readonly userId: string; readonly role: string; readonly sub: string }): Promise<void> {
  await harness.client.put("Isps", { PK: `ISP#${fields.ispId}`, SK: `USER#${fields.userId}`, entity: "ConsoleUser", ...fields, name: "Persona", cognitoSub: fields.sub, cognitoSubKey: `SUB#${fields.sub}`, active: true, ...META });
}

describe("[FL-108] post authentication of a guest of the own sign-up", () => {
  it("[FL-108] a sign-in with a current world: lastLoginAt and 24 more months of the lead, the world unchanged", async () => {
    const harness = guestHarness();
    await signupGuest(harness);
    harness.advance(2 * DAY_MS);
    const before = await getGuestAccount(harness.client, USER_ID);
    const event = authenticationEvent();
    expect(await signIn(harness)(event)).toBe(event);
    const lead = await harness.leads.store.get(hashOf(EMAIL));
    expect(lead?.lastLoginAt).toBe(harness.now().toISOString());
    expect(lead?.expiresAt).toBe(Date.parse("2028-10-03T15:00:00.000Z") / 1000);
    expect((await harness.leads.store.listEvents(hashOf(EMAIL))).map((item) => item.kind)).toContain("LOGIN");
    expect(await getGuestAccount(harness.client, USER_ID)).toEqual(before);
    expect(harness.provisioner.requests).toEqual([]);
  });

  it("[FL-111] a world past its 7 days: a new generation in one transaction (old row out, new row in, SUB# to the new one), GuestWorlds asked", async () => {
    const harness = guestHarness();
    await signupGuest(harness);
    harness.advance(8 * DAY_MS);
    await signIn(harness, ["vwxyz"])(authenticationEvent());
    const account = await getGuestAccount(harness.client, USER_ID);
    expect(account).toMatchObject({ clockId: "GUEST#isp-guest-s261009vwxyz", generation: 2, status: "PROVISIONING", expiresAtReal: "2026-10-16T15:00:00.000Z" });
    expect(await harness.client.get("Isps", { PK: "ISP#isp-guest-s261001abcde", SK: `USER#${USER_ID}` })).toBeUndefined();
    const rows = await harness.client.query("Isps", { index: "GSI1", hashValue: `SUB#${SUB}` });
    expect(rows.map((row) => row.PK)).toEqual(["ISP#isp-guest-s261009vwxyz"]);
    expect(rows[0]).toMatchObject({ guestOrigin: "SIGNUP", role: "GUEST", cognitoUsername: "gst-01K60000000000000000000001" });
    expect(harness.provisioner.requests).toEqual([{ userId: USER_ID, clockId: "GUEST#isp-guest-s261009vwxyz", origin: "SIGNUP" }]);
    // The lead and the account survive; the old generation is left to its TTL.
    expect((await harness.leads.store.get(hashOf(EMAIL)))?.status).toBe("CONFIRMED");
    expect(await harness.client.get("Isps", { PK: "ISP#isp-guest-s261001abcde", SK: "META" })).toBeDefined();
  });

  it("[FL-111] a missing account also gets a new generation", async () => {
    const harness = guestHarness();
    await signupGuest(harness);
    await harness.client.delete("Runtime", { PK: `GUESTACCOUNT#${USER_ID}`, SK: "META" });
    await signIn(harness, ["mnopq"])(authenticationEvent());
    expect(await getGuestAccount(harness.client, USER_ID)).toMatchObject({ clockId: "GUEST#isp-guest-s261001mnopq", generation: 1, status: "PROVISIONING" });
  });
});

describe("[FL-122] post authentication of everyone else", () => {
  it("[FL-108] an invited guest without a world: its account opens PROVISIONING without TTL and GuestWorlds builds it; no lead is touched", async () => {
    const harness = guestHarness();
    await staffRow(harness, { ispId: "isp-guest-07", userId: "usr-guest-07", role: "GUEST", sub: "sub-guest-07" });
    await signIn(harness)(authenticationEvent({ sub: "sub-guest-07" }));
    const account = await getGuestAccount(harness.client, "usr-guest-07");
    expect(account).toMatchObject({ guestOrigin: "INVITED", clockId: "GUEST#isp-guest-07", status: "PROVISIONING" });
    expect(account?.expiresAtReal).toBeUndefined();
    expect(harness.provisioner.requests).toEqual([{ userId: "usr-guest-07", clockId: "GUEST#isp-guest-07", origin: "INVITED" }]);
    expect(await harness.leads.store.scan()).toEqual([]);
    await signIn(harness)(authenticationEvent({ sub: "sub-guest-07" }));
    expect(harness.provisioner.requests).toHaveLength(1);
  });

  it("[FL-122] a supervisor, an operator or a sub without a row: no write, no invocation", async () => {
    const harness = guestHarness();
    await staffRow(harness, { ispId: "isp-demo", userId: "usr-adriana", role: "SUPERVISOR", sub: "sub-sup" });
    await staffRow(harness, { ispId: "isp-demo", userId: "usr-ops-lina", role: "OPS", sub: "sub-ops" });
    const before = JSON.stringify(allRows(harness));
    for (const sub of ["sub-sup", "sub-ops", "sub-nobody"]) await signIn(harness)(authenticationEvent({ sub }));
    await signIn(harness)(authenticationEvent({ sub: "sub-sup", triggerSource: "PostAuthentication_Authentication_Extra" }));
    expect(JSON.stringify(allRows(harness))).toBe(before);
    expect(harness.provisioner.requests).toEqual([]);
    expect(await harness.leads.store.scan()).toEqual([]);
  });

  it("a sign-in is never refused: a failure is logged and the event returned", async () => {
    const harness = guestHarness();
    class FailingClient extends MemoryTableClient {
      override async query(): Promise<never> {
        throw new Error("the registry did not answer");
      }
    }
    const broken = createPostAuthenticationHandler({ signIn: () => ({ ...harness.signInDeps(), client: new FailingClient() }), newLogger: () => harness.log });
    const event = authenticationEvent();
    expect(await broken(event)).toBe(event);
    expect(harness.lines.join("\n")).toContain("auth.postauthentication.failed");
  });
});
