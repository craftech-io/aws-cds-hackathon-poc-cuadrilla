import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { TRPCError } from "@trpc/server";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { ToolError } from "@cuadrilla/shared";
import { AuthError } from "../auth/errors";
import { type TestContextDeps, createTestIssuer, testContextDeps } from "../auth/testing";
import { type Connector, createMemoryConnector } from "../connector/index";
import { signupUserId } from "../leads/testing";
import { DEMO as DEMO_SPEC, GUEST_07 as GUEST_SPEC } from "../services/people/testing";
import { type AccountPorts, createAccountRouter, deleteGuestOf, isSignupGuest, lambdaAccountPorts } from "./account";
import { consoleTestWorld } from "./console-testing";
import { createCallerFactory, createContextFactory, router } from "./trpc";

const SIGNUP = { ispId: "isp-guest-s261001abcde", userId: signupUserId(1), sub: "sub-signup-0001" };
const INVITED = { ispId: "isp-guest-07", userId: "usr-guest-07", sub: "sub-guest07-0001" };
const SUPERVISOR = { ispId: "isp-demo", userId: "usr-adriana", sub: "sub-adriana-0001" };
const OPS = { ispId: "isp-demo", userId: "usr-ops-lina", sub: "sub-ops-0001" };

const issuer = createTestIssuer();
const token = (who: { ispId: string; userId: string; sub: string }, role: string, extra: Record<string, unknown> = {}) =>
  issuer.idToken({ sub: who.sub, ispId: who.ispId, userId: who.userId, role, isGuest: role === "GUEST" ? "true" : "false", "cognito:groups": [role], ...extra });

async function reasonOf(call: Promise<unknown>): Promise<{ code: string; reason: string | undefined }> {
  try {
    await call;
  } catch (error) {
    if (!(error instanceof TRPCError)) throw error;
    const cause = error.cause;
    return { code: error.code, reason: cause instanceof AuthError ? cause.reason : cause instanceof ToolError ? (cause.reason ?? cause.code) : undefined };
  }
  throw new Error("expected the call to be refused");
}

describe("account.deleteGuest [FL-118]", () => {
  let data: Connector;
  let deps: TestContextDeps;
  let payloads: Array<{ readonly userId: string }>;
  const ports: AccountPorts = {
    async deleteGuestAccount(payload) {
      payloads.push(payload);
      return { outcome: "DELETED", leadId: "01K6ABCDEFGHJKMNPQRSTVWXYZ", deletedUsers: 1 };
    },
  };
  const caller = createCallerFactory(router({ account: createAccountRouter(() => ports) }));
  const as = async (bearer: string) => caller(await createContextFactory(() => deps)({ event: { headers: { authorization: `Bearer ${bearer}` } } }));

  beforeEach(async () => {
    payloads = [];
    data = createMemoryConnector().connector;
    deps = testContextDeps(issuer, { connector: data });
    await data.isps.putUser({ ispId: SUPERVISOR.ispId, userId: SUPERVISOR.userId, role: "SUPERVISOR", name: "Supervisora", cognitoSub: SUPERVISOR.sub });
    await data.isps.putUser({ ispId: OPS.ispId, userId: OPS.userId, role: "OPS", name: "Operaciones", cognitoSub: OPS.sub });
    await data.isps.putUser({ ispId: INVITED.ispId, userId: INVITED.userId, role: "GUEST", name: "Invitado 07", cognitoSub: INVITED.sub });
  });

  it("[FL-118] a guest of the own sign-up: invokes GuestAccountDeletion with exactly {userId} of the principal", async () => {
    const principal = { role: "GUEST", isGuest: true, ispId: SIGNUP.ispId, userId: SIGNUP.userId } as const;
    expect(isSignupGuest(principal)).toBe(true);
    expect(await deleteGuestOf(principal, ports)).toEqual({ deleted: true });
    expect(payloads).toEqual([{ userId: SIGNUP.userId }]);
  });

  it("[FL-118] a refusal of the function is a 403, never a success", async () => {
    const refusing: AccountPorts = { deleteGuestAccount: async () => ({ outcome: "REFUSED", reason: "NOT_A_SIGNUP_GUEST" }) };
    await expect(deleteGuestOf({ role: "GUEST", isGuest: true, ispId: SIGNUP.ispId, userId: SIGNUP.userId }, refusing)).rejects.toMatchObject({ code: "FORBIDDEN", reason: "NOT_A_SIGNUP_GUEST" });
  });

  it("[FL-118] an INVITED guest (guest-NN) gets 403 and nothing is invoked", async () => {
    expect(await reasonOf((await as(token(INVITED, "GUEST"))).account.deleteGuest())).toEqual({ code: "FORBIDDEN", reason: "NOT_A_SIGNUP_GUEST" });
    expect(payloads).toEqual([]);
  });

  it("[FL-118] a SUPERVISOR or an OPS gets 403 and nothing is invoked", async () => {
    expect(await reasonOf((await as(token(SUPERVISOR, "SUPERVISOR"))).account.deleteGuest())).toEqual({ code: "FORBIDDEN", reason: "ROLE_NOT_ALLOWED" });
    expect(await reasonOf((await as(token(OPS, "OPS"))).account.deleteGuest())).toEqual({ code: "FORBIDDEN", reason: "ROLE_NOT_ALLOWED" });
    expect(payloads).toEqual([]);
  });

  it("[FL-118] needs a sign-in of at most 15 minutes", async () => {
    const stale = Math.floor(Date.now() / 1000) - 20 * 60;
    expect(await reasonOf((await as(token(INVITED, "GUEST", { auth_time: stale }))).account.deleteGuest())).toEqual({ code: "FORBIDDEN", reason: "LOGIN_NOT_RECENT" });
    expect(payloads).toEqual([]);
  });

  it("[FL-118] through the router: an input with another id or an email never changes the payload", async () => {
    await data.isps.putUser({ ispId: SIGNUP.ispId, userId: SIGNUP.userId, role: "GUEST", name: "Invitado", cognitoSub: SIGNUP.sub });
    const guest = await as(token(SIGNUP, "GUEST"));
    expect(await guest.account.deleteGuest({ userId: signupUserId(2), email: "otra.persona@example.com" })).toEqual({ deleted: true });
    expect(await guest.account.deleteGuest()).toEqual({ deleted: true });
    expect(payloads).toEqual([{ userId: SIGNUP.userId }, { userId: SIGNUP.userId }]);
  });
});

describe("the Lambda port of account.deleteGuest [FL-118]", () => {
  const lambda = mockClient(LambdaClient);
  const port = () => lambdaAccountPorts(new LambdaClient({}), () => "app-poc-guest-account-deletion");
  beforeEach(() => lambda.reset());

  it("[FL-118] invokes the function synchronously with {userId} only and parses its answer", async () => {
    lambda.on(InvokeCommand).resolves({ StatusCode: 200, Payload: new TextEncoder().encode(JSON.stringify({ outcome: "DELETED", deletedUsers: 1 })) as never });
    expect(await port().deleteGuestAccount({ userId: SIGNUP.userId })).toEqual({ outcome: "DELETED", deletedUsers: 1 });
    const input = lambda.commandCalls(InvokeCommand)[0]?.args[0].input;
    expect(input).toMatchObject({ FunctionName: "app-poc-guest-account-deletion", InvocationType: "RequestResponse" });
    expect(JSON.parse(new TextDecoder().decode(input?.Payload as Uint8Array))).toEqual({ userId: SIGNUP.userId });
  });

  it("[FL-118] a failed or malformed answer is UNAVAILABLE, never a success", async () => {
    lambda.on(InvokeCommand).resolvesOnce({ StatusCode: 200, FunctionError: "Unhandled", Payload: new TextEncoder().encode("{}") as never }).resolvesOnce({ StatusCode: 200, Payload: new TextEncoder().encode('{"outcome":"MAYBE"}') as never });
    await expect(port().deleteGuestAccount({ userId: SIGNUP.userId })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(port().deleteGuestAccount({ userId: SIGNUP.userId })).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
});

describe("account.session, changePassword and mfa.setup", () => {
  const GUEST_TEST = { ispId: "isp-guest-test", tag: "-gtest", installerBlock: "0299", supervisorBlock: "0299" };

  it("a guest's world keeps one session: another active session gets the notice and no reset; the first keeps acting", async () => {
    const t = await consoleTestWorld(GUEST_TEST);
    const a = t.qa("GUEST", { sessionId: "session-a" });
    const b = t.qa("GUEST", { sessionId: "session-b" });
    expect(await a.account.session()).toMatchObject({ role: "GUEST", otherSession: false, canReset: true, canChangePassword: false, canSetupMfa: false, canDeleteAccount: false });
    expect(await b.account.session()).toMatchObject({ otherSession: true, canReset: false });
    expect(await a.account.session()).toMatchObject({ otherSession: false, canReset: true });
    expect(await t.memory.connector.worlds.getWorldSession(t.world.clockId)).toMatchObject({ sessionId: "session-a", userId: "usr-qa-guest" });
  });

  it("[W4 review B3] recording the session never moves the clock: a reset read before it still applies", async () => {
    const t = await consoleTestWorld(GUEST_TEST);
    const clock = await t.memory.connector.runtime.getClock(t.world.clockId);
    if (clock === undefined) throw new Error("no clock");
    for (const sessionId of ["session-a", "session-a", "session-b"]) await t.qa("GUEST", { sessionId }).account.session();
    expect(await t.memory.connector.runtime.getClock(t.world.clockId)).toEqual(clock);
    // The reset's own conditional write on the version it read before the session polls still succeeds.
    await expect(t.memory.connector.runtime.updateClock(clock.clockId, { mode: "PAUSED" }, clock.version)).resolves.toMatchObject({ version: clock.version + 1 });
    await expect(t.qa("GUEST", { sessionId: "session-a" }).clock.reset()).resolves.toMatchObject({ previousEpoch: 1 });
  });

  it("[W4 review B3] the world's own session is written again only when it is more than 5 minutes old", async () => {
    const t = await consoleTestWorld(GUEST_TEST);
    await t.qa("GUEST", { sessionId: "session-a" }).account.session();
    const first = await t.memory.connector.worlds.getWorldSession(t.world.clockId);
    await t.qa("GUEST", { sessionId: "session-a" }).account.session();
    expect(await t.memory.connector.worlds.getWorldSession(t.world.clockId)).toEqual(first);
  });

  it("staff change their password and set up TOTP (the console asks first); a guest gets 403", async () => {
    const demo = await consoleTestWorld(DEMO_SPEC);
    const staff = await demo.as();
    expect(await staff.account.session()).toMatchObject({ role: "SUPERVISOR", otherSession: false, canReset: true, canChangePassword: true });
    expect(await staff.account.changePassword()).toEqual({ allowed: true });
    expect(await staff.account.mfa.setup()).toEqual({ allowed: true });
    expect((await demo.world.decisions()).map((row) => row.action)).toEqual(expect.arrayContaining(["PASSWORD_CHANGE_REQUESTED", "MFA_SETUP_REQUESTED"]));
    const guest = await (await consoleTestWorld(GUEST_SPEC)).as();
    expect(await reasonOf(guest.account.changePassword())).toEqual({ code: "FORBIDDEN", reason: "GUEST_ACCOUNT" });
    expect(await reasonOf(guest.account.mfa.setup())).toEqual({ code: "FORBIDDEN", reason: "GUEST_ACCOUNT" });
    expect((await (await demo.as("OPS", "usr-ops")).account.session()).canReset).toBe(false);
  });
});
