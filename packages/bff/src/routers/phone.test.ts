// The gate of the SMS code on the real `appRouter` (ADR-0029, FL-123 to FL-125): a Cognito session that
// has not passed its code reaches no procedure but the phone step; once passed, only that session gets
// through; an account the operator marked AUTOMATION never asks.
import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it } from "vitest";
import { AuthError } from "../auth/errors";
import { createTestIssuer, testContextDeps } from "../auth/testing";
import { type MemoryConnector, createMemoryConnector } from "../connector/index";
import { type MemoryPhone, memoryPhone } from "../phone/testing";
import { appRouter } from "./index";
import { PHONE_STEP_PROCEDURES, createCallerFactory, createContextFactory } from "./trpc";

const issuer = createTestIssuer();
const GUEST = { ispId: "isp-guest-07", userId: "usr-guest-07", sub: "sub-guest07-0001", role: "GUEST" };
const STAFF = { ispId: "isp-demo", userId: "usr-adriana", sub: "sub-adriana-0001", role: "SUPERVISOR" };
/** Procedures without a principal: they carry no world's data and never reach the gate. */
const PUBLIC = ["health.live", "brand.get", "signup.start"];

type Who = typeof GUEST;
const token = (who: Who, session = "jti-1") =>
  issuer.idToken({ sub: who.sub, ispId: who.ispId, userId: who.userId, role: who.role, isGuest: who.role === "GUEST" ? "true" : "false", "cognito:groups": [who.role], origin_jti: session });

async function reasonOf(call: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await call();
  } catch (error) {
    if (error instanceof TRPCError && error.cause instanceof AuthError) return error.cause.reason;
    return "OTHER";
  }
  return undefined;
}

const procedurePaths = (): string[] => Object.keys((appRouter as unknown as { _def: { procedures: Record<string, unknown> } })._def.procedures);

describe("the SMS code gates every procedure of a session [FL-123] [FL-124] [FL-125]", () => {
  let memory: MemoryConnector;
  let phone: MemoryPhone;
  const callerAs = async (who: Who, session = "jti-1") => {
    const deps = testContextDeps(issuer, { connector: memory.connector, phoneGate: phone.gate, phone: () => phone.ports });
    return createCallerFactory(appRouter)(await createContextFactory(() => deps)({ event: { headers: { authorization: `Bearer ${token(who, session)}` } }, edge: { viewerIp: "203.0.113.10" } }));
  };
  const call = (caller: unknown, path: string) => () => {
    const target = path.split(".").reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], caller) as (input?: unknown) => Promise<unknown>;
    return target({});
  };

  beforeEach(async () => {
    memory = createMemoryConnector();
    phone = memoryPhone({ client: memory.client, codes: () => "246810" });
    await memory.connector.isps.putUser({ ispId: GUEST.ispId, userId: GUEST.userId, role: "GUEST", name: "Invitado 07", cognitoSub: GUEST.sub });
    await memory.connector.isps.putUser({ ispId: STAFF.ispId, userId: STAFF.userId, role: "SUPERVISOR", name: "Supervisora", cognitoSub: STAFF.sub });
  });

  it("[FL-123] a session that has not passed its code gets PHONE_VERIFICATION_REQUIRED from every procedure but the phone step", async () => {
    const guest = await callerAs(GUEST);
    const answered: string[] = [];
    for (const path of procedurePaths().filter((name) => !PUBLIC.includes(name))) {
      if ((await reasonOf(call(guest, path))) !== "PHONE_VERIFICATION_REQUIRED") answered.push(path);
    }
    expect(answered.sort()).toEqual([...PHONE_STEP_PROCEDURES].sort());
    expect(phone.sms.sent).toEqual([]);
  });

  it("[FL-123] who is signed in answers before the code, without claiming the world's session", async () => {
    const guest = await callerAs(GUEST);
    expect(await guest.account.session()).toMatchObject({ userId: GUEST.userId, phoneVerificationRequired: true, otherSession: false });
    expect(memory.client.dump("Runtime").filter((row) => row.PK.startsWith("WORLDSESSION#"))).toEqual([]);
  });

  it("[FL-123] [FL-124] staff too: a supervisor passes the same code before the console answers anything", async () => {
    const staff = await callerAs(STAFF);
    expect(await reasonOf(() => staff.orders.list({}))).toBe("PHONE_VERIFICATION_REQUIRED");
    await staff.phone.sendCode({ locale: "es-MX", phone: "+525512345678" });
    expect(await staff.phone.verifyCode({ code: "246810" })).toMatchObject({ state: "PASSED" });
    expect(await reasonOf(() => staff.account.session())).toBeUndefined();
    expect(await reasonOf(() => staff.orders.list({}))).not.toBe("PHONE_VERIFICATION_REQUIRED");
  });

  it("[FL-124] the right code opens only that session; another sign-in of the same account asks again; a refresh keeps it open", async () => {
    const first = await callerAs(GUEST, "jti-1");
    await first.phone.sendCode({ locale: "es-MX", phone: "+525512345678" });
    await first.phone.verifyCode({ code: "246810" });
    expect(await reasonOf(() => first.guest.world())).not.toBe("PHONE_VERIFICATION_REQUIRED");
    // A refreshed id token keeps `origin_jti`: the same session, no code.
    const refreshed = await callerAs(GUEST, "jti-1");
    expect(await refreshed.account.session()).toMatchObject({ phoneVerificationRequired: false });
    const second = await callerAs(GUEST, "jti-2");
    expect(await reasonOf(() => second.guest.world())).toBe("PHONE_VERIFICATION_REQUIRED");
    expect(await second.phone.status()).toMatchObject({ state: "SIGN_IN", maskedPhone: "•••• 5678" });
    await expect(second.phone.sendCode({ locale: "es-MX", phone: "+525599999999" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("[FL-124] the password asked again inside a passed session keeps the pass; a session that never passed, or another user's, carries nothing", async () => {
    const first = await callerAs(GUEST, "jti-1");
    await first.phone.sendCode({ locale: "es-MX", phone: "+525512345678" });
    await first.phone.verifyCode({ code: "246810" });
    const stepUp = await callerAs(GUEST, "jti-2");
    expect(await stepUp.phone.carrySession({ previousIdToken: token(GUEST, "jti-1") })).toMatchObject({ state: "PASSED" });
    expect(await reasonOf(() => stepUp.guest.world())).not.toBe("PHONE_VERIFICATION_REQUIRED");

    const fresh = await callerAs(GUEST, "jti-3");
    await expect(fresh.phone.carrySession({ previousIdToken: token(GUEST, "jti-9") })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(fresh.phone.carrySession({ previousIdToken: token(STAFF, "jti-1") })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(fresh.phone.carrySession({ previousIdToken: "not-a-token" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await reasonOf(() => fresh.guest.world())).toBe("PHONE_VERIFICATION_REQUIRED");
  });

  it("[FL-124] the sign-out ends the session's pass", async () => {
    const guest = await callerAs(GUEST);
    await guest.phone.sendCode({ locale: "es-MX", phone: "+525512345678" });
    await guest.phone.verifyCode({ code: "246810" });
    await guest.phone.endSession();
    expect(await reasonOf(() => guest.guest.world())).toBe("PHONE_VERIFICATION_REQUIRED");
  });

  it("[FL-125] an account the operator marked AUTOMATION is never asked", async () => {
    await memory.connector.isps.putUser({ ispId: GUEST.ispId, userId: GUEST.userId, role: "GUEST", name: "Invitado 07", cognitoSub: GUEST.sub, phoneCheck: "AUTOMATION" });
    const automation = await callerAs(GUEST);
    expect(await reasonOf(() => automation.guest.world())).not.toBe("PHONE_VERIFICATION_REQUIRED");
    expect(await automation.phone.status()).toMatchObject({ state: "PASSED" });
  });
});
