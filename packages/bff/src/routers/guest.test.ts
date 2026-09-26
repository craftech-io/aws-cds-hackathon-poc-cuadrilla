import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it } from "vitest";
import { ToolError } from "@cuadrilla/shared";
import { AuthError } from "../auth/errors";
import { createTestIssuer, testContextDeps } from "../auth/testing";
import { createAccountOp, getGuestAccount } from "../guest/account";
import { worldsDayKey } from "../guest/slots";
import { guestHarness, type GuestHarness } from "../guest/testing";
import { buildWorld } from "../worlds/factory";
import { SIGNUP_CLOCK, SIGNUP_ISP, SIGNUP_USER } from "../worlds/testing";
import { createGuestRouter } from "./guest";
import { createCallerFactory, createContextFactory, router } from "./trpc";

const issuer = createTestIssuer();
const SIGNUP = { ispId: SIGNUP_ISP, userId: SIGNUP_USER, sub: "sub-signup-0001" };
const INVITED = { ispId: "isp-guest-07", userId: "usr-guest-07", sub: "sub-guest07-0001" };
const SUPERVISOR = { ispId: "isp-demo", userId: "usr-adriana", sub: "sub-adriana-0001" };
const DAY_MS = 86_400_000;

const token = (who: { ispId: string; userId: string; sub: string }, role: string) =>
  issuer.idToken({ sub: who.sub, ispId: who.ispId, userId: who.userId, role, isGuest: role === "GUEST" ? "true" : "false", "cognito:groups": [role] });

async function refusalOf(call: Promise<unknown>): Promise<{ code: string; reason: string | undefined }> {
  try {
    await call;
  } catch (error) {
    if (!(error instanceof TRPCError)) throw error;
    const cause = error.cause;
    return { code: error.code, reason: cause instanceof AuthError ? cause.reason : cause instanceof ToolError ? (cause.reason ?? cause.code) : undefined };
  }
  throw new Error("expected a refusal");
}

describe("guest router [FL-107] [FL-112]", () => {
  let harness: GuestHarness;
  const callerOf = () => {
    const deps = testContextDeps(issuer, { connector: harness.connector });
    const caller = createCallerFactory(router({ guest: createGuestRouter(() => ({ client: harness.client, connector: harness.connector, provisioner: harness.provisioner, now: harness.now, suffix: () => "rstuv" })) }));
    return async (bearer?: string) => caller(await createContextFactory(() => deps)({ event: { headers: bearer === undefined ? {} : { authorization: `Bearer ${bearer}` } } }));
  };
  const openAccount = async (status: "PROVISIONING" | "READY" | "FAILED" | "CAP_FULL", who = SIGNUP, origin: "SIGNUP" | "INVITED" = "SIGNUP") =>
    harness.client.transact([createAccountOp({ userId: who.userId, guestOrigin: origin, ispId: who.ispId, clockId: `GUEST#${who.ispId}`, generation: 1, status }, harness.now())], harness.now().toISOString());

  beforeEach(async () => {
    harness = guestHarness();
    await harness.connector.isps.putUser({ ispId: SIGNUP.ispId, userId: SIGNUP.userId, role: "GUEST", name: "Invitado", cognitoSub: SIGNUP.sub, guestOrigin: "SIGNUP", cognitoUsername: "gst-01K60000000000000000000001" });
    await harness.connector.isps.putUser({ ispId: INVITED.ispId, userId: INVITED.userId, role: "GUEST", name: "Invitado 07", cognitoSub: INVITED.sub });
    await harness.connector.isps.putUser({ ispId: SUPERVISOR.ispId, userId: SUPERVISOR.userId, role: "SUPERVISOR", name: "Supervisora", cognitoSub: SUPERVISOR.sub });
  });

  it("[FL-107] guest.world answers the four states of the portada for the principal's own world", async () => {
    const as = callerOf();
    await openAccount("PROVISIONING");
    expect(await (await as(token(SIGNUP, "GUEST"))).guest.world()).toMatchObject({ status: "PROVISIONING", origin: "SIGNUP", canDeleteAccount: true });
    await buildWorld(harness.factoryDeps(), { ispId: SIGNUP_ISP, origin: "SIGNUP", ownerUserId: SIGNUP_USER });
    await harness.client.update("Runtime", { PK: `GUESTACCOUNT#${SIGNUP_USER}`, SK: "META" }, { status: "READY" }, harness.now().toISOString());
    const ready = await (await as(token(SIGNUP, "GUEST"))).guest.world({});
    expect(ready.status).toBe("READY");
    expect(ready.summary?.installers).toContain("Rogelio Méndez");
    await harness.client.update("Runtime", { PK: `GUESTACCOUNT#${SIGNUP_USER}`, SK: "META" }, { status: "CAP_FULL" }, harness.now().toISOString());
    expect(await (await as(token(SIGNUP, "GUEST"))).guest.world()).toMatchObject({ status: "CAP_FULL", canRetry: true });
  });

  it("[FL-107] an invited guest's portada never offers the deletion; a supervisor, or no token, gets nothing", async () => {
    const as = callerOf();
    await openAccount("READY", INVITED, "INVITED");
    expect(await (await as(token(INVITED, "GUEST"))).guest.world()).toMatchObject({ origin: "INVITED", canDeleteAccount: false });
    expect(await refusalOf((await as(token(SUPERVISOR, "SUPERVISOR"))).guest.world())).toEqual({ code: "FORBIDDEN", reason: "ROLE_NOT_ALLOWED" });
    expect((await refusalOf((await as()).guest.world())).code).toBe("UNAUTHORIZED");
  });

  it("[FL-107] the input names nothing: another user or operator in it is refused", async () => {
    const as = callerOf();
    await openAccount("PROVISIONING");
    const guest = await as(token(SIGNUP, "GUEST"));
    expect((await refusalOf(guest.guest.world({ userId: INVITED.userId } as never))).code).toBe("BAD_REQUEST");
    expect(["BAD_REQUEST", "FORBIDDEN"]).toContain((await refusalOf(guest.guest.retryWorld({ ispId: "isp-demo" } as never))).code);
    expect(harness.provisioner.requests).toEqual([]);
  });

  it("[FL-107] retryWorld after a failure asks GuestWorlds again, once a minute", async () => {
    const as = callerOf();
    await openAccount("FAILED");
    const guest = await as(token(SIGNUP, "GUEST"));
    expect(await guest.guest.retryWorld()).toMatchObject({ status: "PROVISIONING" });
    expect(harness.provisioner.requests).toEqual([{ userId: SIGNUP_USER, clockId: SIGNUP_CLOCK, origin: "SIGNUP" }]);
    expect(await refusalOf(guest.guest.retryWorld())).toEqual({ code: "TOO_MANY_REQUESTS", reason: "RETRY_TOO_SOON" });
    expect(harness.provisioner.requests).toHaveLength(1);
  });

  it("[FL-112] retryWorld out of CAP_FULL takes a slot when there is room, and stays CAP_FULL when there is none", async () => {
    const as = callerOf();
    await openAccount("CAP_FULL");
    await harness.client.put("Runtime", { PK: worldsDayKey("PUBLIC", "261001"), SK: "META", count: 150 });
    const guest = await as(token(SIGNUP, "GUEST"));
    expect(await guest.guest.retryWorld()).toMatchObject({ status: "CAP_FULL" });
    expect(harness.provisioner.requests).toEqual([]);
    await harness.client.put("Runtime", { PK: worldsDayKey("PUBLIC", "261001"), SK: "META", count: 10 });
    harness.advance(60_000);
    expect(await guest.guest.retryWorld()).toMatchObject({ status: "PROVISIONING" });
    expect(await getGuestAccount(harness.client, SIGNUP_USER)).toMatchObject({ status: "PROVISIONING", slotDay: "261001" });
    expect(harness.provisioner.requests).toHaveLength(1);
  });

  it("[FL-111] retryWorld of an expired sign-up world opens a new generation with its clock, and the portada asks for a fresh session", async () => {
    const as = callerOf();
    await openAccount("READY");
    harness.advance(8 * DAY_MS);
    const view = await (await as(token(SIGNUP, "GUEST"))).guest.retryWorld();
    expect(view).toMatchObject({ status: "PROVISIONING", refreshSession: true });
    const account = await getGuestAccount(harness.client, SIGNUP_USER);
    expect(account).toMatchObject({ clockId: "GUEST#isp-guest-s261009rstuv", generation: 2 });
    expect(await harness.connector.runtime.getClock("GUEST#isp-guest-s261009rstuv")).toMatchObject({ mode: "PAUSED", worldEpoch: 1, settings: { ownerUserId: SIGNUP_USER } });
    expect(await harness.connector.isps.getUser("isp-guest-s261009rstuv", SIGNUP_USER)).toMatchObject({ guestOrigin: "SIGNUP" });
    expect(harness.provisioner.requests).toEqual([{ userId: SIGNUP_USER, clockId: "GUEST#isp-guest-s261009rstuv", origin: "SIGNUP" }]);
  });
});
