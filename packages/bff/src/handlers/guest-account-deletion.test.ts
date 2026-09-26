import { beforeEach, describe, expect, it } from "vitest";
import { ToolError } from "@cuadrilla/shared";
import { EMAIL, type World, otherAccount, signupGuest, world } from "../leads/deletion-testing";
import { hashOf, signupUserId, username } from "../leads/testing";
import { handleGuestAccountDeletion } from "./guest-account-deletion";

describe("GuestAccountDeletion handler [FL-118]", () => {
  let w: World;
  beforeEach(() => {
    w = world();
  });

  it("[FL-118] deletes a guest of the own sign-up from {userId} and answers the outcome its callers parse", async () => {
    await signupGuest(w);
    const leadId = (await w.store.get(hashOf(EMAIL)))?.leadId;
    expect(await handleGuestAccountDeletion({ userId: signupUserId(1) }, w.deps)).toEqual({ outcome: "DELETED", leadId, deletedUsers: 1 });
    expect(w.cognitoCalls).toEqual([username(1)]);
    expect(w.destroyed).toHaveLength(1);
  });

  it("[FL-118] refuses a SUPERVISOR, an OPS and a guest-NN account: NOT_A_SIGNUP_GUEST, DELETION_REFUSED, nothing deleted", async () => {
    await otherAccount(w, { ispId: "isp-demo", userId: "usr-adriana", role: "SUPERVISOR", cognitoUsername: "adriana" });
    await otherAccount(w, { ispId: "isp-demo", userId: "usr-ops-lina", role: "OPS", cognitoUsername: "lina" });
    await otherAccount(w, { ispId: "isp-guest-07", userId: "usr-guest-07", role: "GUEST", guestOrigin: "INVITED", cognitoUsername: "guest-07" });
    for (const userId of ["usr-adriana", "usr-ops-lina", "usr-guest-07"]) {
      expect(await handleGuestAccountDeletion({ userId }, w.deps), userId).toEqual({ outcome: "REFUSED", reason: "NOT_A_SIGNUP_GUEST" });
    }
    expect(w.table.logs.map((entry) => [entry.kind, entry.reason])).toEqual([
      ["DELETION_REFUSED", "NOT_A_SIGNUP_GUEST"],
      ["DELETION_REFUSED", "NOT_A_SIGNUP_GUEST"],
      ["DELETION_REFUSED", "NOT_A_SIGNUP_GUEST"],
    ]);
    expect(w.cognitoCalls).toEqual([]);
    expect(w.destroyed).toEqual([]);
    expect(w.data.dump("Isps")).toHaveLength(3);
  });

  it("[FL-118] refuses any other payload before reading anything (INVALID)", async () => {
    await signupGuest(w);
    for (const payload of [undefined, {}, { username: username(1) }, { userId: signupUserId(1), email: EMAIL }, { email: EMAIL, actor: "GUEST" }, "usr-g01"]) {
      await expect(handleGuestAccountDeletion(payload, w.deps), JSON.stringify(payload)).rejects.toMatchObject({ code: "INVALID" });
    }
    expect(w.cognitoCalls).toEqual([]);
  });

  it("[FL-118] a generation that cannot be destroyed deletes nothing (Cognito user, account, lead) and the retry converges", async () => {
    await signupGuest(w);
    const failing = { destroyGeneration: async () => Promise.reject(new ToolError("UNAVAILABLE", "the world could not be destroyed")) };
    await expect(handleGuestAccountDeletion({ userId: signupUserId(1) }, { ...w.deps, worlds: failing })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(w.cognitoCalls).toEqual([]);
    expect(await w.store.get(hashOf(EMAIL))).toBeDefined();
    expect(w.data.dump("Isps")).toHaveLength(1);
    expect(await handleGuestAccountDeletion({ userId: signupUserId(1) }, w.deps)).toMatchObject({ outcome: "DELETED" });
    expect(await w.store.get(hashOf(EMAIL))).toBeUndefined();
  });
});
