import { beforeEach, describe, expect, it } from "vitest";
import { deleteGuestAccount } from "./deletion";
import { EMAIL, GENERATION, SUB, type World, otherAccount, signupGuest, world } from "./deletion-testing";
import { CONFIRMED_ACCOUNTS, guestAccountKey, signupKeyKey, signupSubKey } from "./guest-accounts";
import { T0, confirmedLead, hashOf, signupUserId, startLead, username } from "./testing";
import { buildWorld } from "../worlds/factory";
import { signupGenerationDestroyer } from "../worlds/guest-lifecycle";
import { worldHarness } from "../worlds/testing";

const at = T0.toISOString();

describe("GuestAccountDeletion [FL-118]", () => {
  let w: World;
  beforeEach(() => {
    w = world();
  });

  it("[FL-118] deletes the user and its pending siblings, the lead and its events, the row, GUESTACCOUNT#, SIGNUPSUB#, the world, and subtracts SIGNUPKEY#", async () => {
    await startLead(w.store, { user: 2 });
    await signupGuest(w, { user: 1 });
    const lead = await w.store.get(hashOf(EMAIL));
    const result = await deleteGuestAccount(w.deps, { userId: signupUserId(1) });
    expect(result).toEqual({ outcome: "DELETED", leadId: lead?.leadId, deletedUsers: 2 });
    expect([...w.cognitoCalls].sort()).toEqual([username(1), username(2)].sort());
    expect(w.destroyed).toEqual([{ userId: signupUserId(1), clockId: GENERATION.clockId, guestOrigin: "SIGNUP", status: "READY" }]);
    expect(await w.store.get(hashOf(EMAIL))).toBeUndefined();
    expect(await w.store.listEvents(hashOf(EMAIL))).toEqual([]);
    expect(w.data.dump("Isps")).toEqual([]);
    expect(await w.data.get("Runtime", guestAccountKey(signupUserId(1)))).toBeUndefined();
    expect(await w.data.get("Runtime", signupSubKey(SUB))).toBeUndefined();
    expect((await w.data.get("Runtime", signupKeyKey(lead?.abuseHash ?? "")))?.[CONFIRMED_ACCOUNTS]).toBe(0);
  });

  it("[FL-118] [W4 review B4] a Memory purge that fails never keeps the Cognito user, the lead or the world's items", async () => {
    const worlds = worldHarness();
    await buildWorld(worlds.factoryDeps(), { ispId: GENERATION.ispId, origin: "SIGNUP", ownerUserId: signupUserId(1) });
    const failing = signupGenerationDestroyer({ ...worlds.destroyDeps(), purgeMemory: async () => Promise.reject(new Error("ThrottlingException")), log: w.deps.log });
    await signupGuest(w, { user: 1 });
    const result = await deleteGuestAccount({ ...w.deps, worlds: failing }, { userId: signupUserId(1) });
    expect(result).toMatchObject({ outcome: "DELETED" });
    expect(w.cognitoCalls).toEqual([username(1)]);
    expect(await w.store.get(hashOf(EMAIL))).toBeUndefined();
    expect(await worlds.connector.runtime.getClock(GENERATION.clockId)).toBeUndefined();
    expect(w.lines.some((line) => line.includes("MemoryPurgeIncomplete"))).toBe(true);
  });

  it("[FL-114] an account opened over the person's limit (PERSON_LIMIT) never counted: its deletion gives nothing back", async () => {
    await signupGuest(w, { user: 1 });
    const abuseHash = (await w.store.get(hashOf(EMAIL)))?.abuseHash ?? "";
    await w.data.update("Runtime", guestAccountKey(signupUserId(1)), { status: "PERSON_LIMIT" }, at);
    await w.data.update("Runtime", signupKeyKey(abuseHash), { [CONFIRMED_ACCOUNTS]: 2 }, at);
    expect(await deleteGuestAccount(w.deps, { userId: signupUserId(1) })).toMatchObject({ outcome: "DELETED" });
    expect(await w.data.get("Runtime", guestAccountKey(signupUserId(1)))).toBeUndefined();
    expect((await w.data.get("Runtime", signupKeyKey(abuseHash)))?.[CONFIRMED_ACCOUNTS]).toBe(2);
  });

  it("[FL-118] logs LEAD_DELETED with the leadId, never the email nor its hash, and never calls Cognito with the email", async () => {
    await signupGuest(w);
    const leadId = (await w.store.get(hashOf(EMAIL)))?.leadId;
    await deleteGuestAccount(w.deps, { userId: signupUserId(1) });
    expect(w.table.logs).toEqual([expect.objectContaining({ kind: "LEAD_DELETED", leadId, actor: "GUEST" })]);
    const trail = JSON.stringify([w.table.logs, w.lines, w.cognitoCalls]);
    expect(trail).not.toContain(EMAIL);
    expect(trail).not.toContain(hashOf(EMAIL));
    for (const name of w.cognitoCalls) expect(name).toMatch(/^gst-[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("[FL-118] is idempotent: a second call finds nothing, subtracts nothing and deletes nothing", async () => {
    await signupGuest(w);
    const abuseHash = (await w.store.get(hashOf(EMAIL)))?.abuseHash ?? "";
    await deleteGuestAccount(w.deps, { userId: signupUserId(1) });
    expect(await deleteGuestAccount(w.deps, { userId: signupUserId(1) })).toEqual({ outcome: "NOTHING_TO_DELETE" });
    expect(await deleteGuestAccount(w.deps, { email: EMAIL })).toEqual({ outcome: "NOTHING_TO_DELETE" });
    expect((await w.data.get("Runtime", signupKeyKey(abuseHash)))?.[CONFIRMED_ACCOUNTS]).toBe(0);
    expect(w.cognitoCalls).toHaveLength(1);
  });

  it("[FL-118] resolves the target from the registry or the lead, never from the payload: {email} of the operator finds the same account", async () => {
    await signupGuest(w);
    const result = await deleteGuestAccount(w.deps, { email: " Ana.Prueba@Example.com " });
    expect(result).toMatchObject({ outcome: "DELETED", deletedUsers: 1 });
    expect(w.cognitoCalls).toEqual([username(1)]);
    expect(w.destroyed).toHaveLength(1);
    expect(w.table.logs).toEqual([expect.objectContaining({ kind: "LEAD_DELETED", actor: "OPERATOR" })]);
  });

  it("[FL-118] a pending lead without a registry row ({email}) goes with its pending users", async () => {
    await startLead(w.store, { user: 1 });
    await startLead(w.store, { user: 2 });
    expect(await deleteGuestAccount(w.deps, { email: EMAIL })).toMatchObject({ outcome: "DELETED", deletedUsers: 2 });
    expect(w.cognitoCalls).toEqual([username(1), username(2)]);
    expect(w.destroyed).toEqual([]);
    expect(await w.store.get(hashOf(EMAIL))).toBeUndefined();
  });

  it("[FL-118] refuses a SUPERVISOR, an OPS and an invited guest-NN: NOT_A_SIGNUP_GUEST, nothing deleted, DELETION_REFUSED", async () => {
    await otherAccount(w, { ispId: "isp-demo", userId: "usr-adriana", role: "SUPERVISOR", cognitoUsername: "adriana" });
    await otherAccount(w, { ispId: "isp-demo", userId: "usr-ops-lina", role: "OPS", cognitoUsername: "lina" });
    await otherAccount(w, { ispId: "isp-guest-07", userId: "usr-guest-07", role: "GUEST", guestOrigin: "INVITED", cognitoUsername: "guest-07" });
    for (const userId of ["usr-adriana", "usr-ops-lina", "usr-guest-07", "usr-guest-test"]) {
      expect(await deleteGuestAccount(w.deps, { userId }), userId).toEqual({ outcome: "REFUSED", reason: "NOT_A_SIGNUP_GUEST" });
    }
    expect(w.cognitoCalls).toEqual([]);
    expect(w.destroyed).toEqual([]);
    expect(w.data.dump("Isps")).toHaveLength(3);
    expect(w.table.logs.map((entry) => entry.kind)).toEqual(["DELETION_REFUSED", "DELETION_REFUSED", "DELETION_REFUSED", "DELETION_REFUSED"]);
    expect(w.lines.filter((line) => line.includes('"metric":"DeletionRefused"'))).toHaveLength(4);
  });

  it("[FL-118] refuses a usr-g id whose row is not a guest of the own sign-up", async () => {
    const userId = signupUserId(7);
    await otherAccount(w, { ispId: GENERATION.ispId, userId, role: "SUPERVISOR", cognitoUsername: username(7) });
    await w.data.put("Runtime", { ...guestAccountKey(userId), entity: "GuestAccount", clockId: GENERATION.clockId, version: 1, createdAt: at, updatedAt: at });
    expect(await deleteGuestAccount(w.deps, { userId })).toEqual({ outcome: "REFUSED", reason: "NOT_A_SIGNUP_GUEST" });
    expect(w.cognitoCalls).toEqual([]);
  });

  it("[FL-118] refuses through {email} when the lead's sub belongs to an account that is not a sign-up guest", async () => {
    await confirmedLead(w.store, { sub: "sub-usr-adriana" });
    await otherAccount(w, { ispId: "isp-demo", userId: "usr-adriana", role: "SUPERVISOR", cognitoUsername: "adriana" });
    expect(await deleteGuestAccount(w.deps, { email: EMAIL })).toEqual({ outcome: "REFUSED", reason: "NOT_A_SIGNUP_GUEST" });
    expect(await w.store.get(hashOf(EMAIL))).toBeDefined();
  });

  it("[FL-118] the expiry of a confirmed lead (its item already gone) still removes the account and subtracts with the hint", async () => {
    await signupGuest(w);
    const lead = await w.store.get(hashOf(EMAIL));
    await w.table.deleteMeta(hashOf(EMAIL));
    const result = await deleteGuestAccount(w.deps, { userId: signupUserId(1), actor: "TTL", abuseHash: lead?.abuseHash });
    expect(result).toMatchObject({ outcome: "DELETED", deletedUsers: 1 });
    expect((await w.data.get("Runtime", signupKeyKey(lead?.abuseHash ?? "")))?.[CONFIRMED_ACCOUNTS]).toBe(0);
    expect(w.table.logs).toEqual([expect.objectContaining({ kind: "LEAD_DELETED", actor: "TTL" })]);
  });

  it("[FL-118] accepts only {userId} or {email}; the abuse hint only with an expiry", async () => {
    await expect(deleteGuestAccount(w.deps, { userId: signupUserId(1), email: EMAIL } as never)).rejects.toThrow();
    await expect(deleteGuestAccount(w.deps, { userId: signupUserId(1), abuseHash: "a".repeat(64) })).rejects.toThrow();
    await expect(deleteGuestAccount(w.deps, { username: username(1) } as never)).rejects.toThrow();
  });
});
