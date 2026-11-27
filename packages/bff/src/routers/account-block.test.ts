// The operator's block on the real `appRouter` (ADR-0029 §11, FL-126): an account with a valid id token
// and a session that already passed its SMS code reaches nothing once blocked, gets no SMS and has its
// passed sessions deleted; the unblock opens it again, and the old session asks for a new code. Cognito
// is a double: nothing reaches AWS.
import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it } from "vitest";
import { AuthError } from "../auth/errors";
import { createTestIssuer, testContextDeps } from "../auth/testing";
import { type MemoryConnector, createMemoryConnector } from "../connector/index";
import { createLogger } from "../lib/log";
import { type CognitoAccounts, blockAccount } from "../phone/block";
import { sendPhoneCode, verifyPhoneCode } from "../phone/flow";
import { type MemoryPhone, memoryPhone } from "../phone/testing";
import { appRouter } from "./index";
import { createCallerFactory, createContextFactory } from "./trpc";

const issuer = createTestIssuer();
const GUEST = { ispId: "isp-guest-07", userId: "usr-guest-07", sub: "sub-guest07-0001", role: "GUEST" };
const PUBLIC = ["health.live", "brand.get", "signup.start"];
const PHONE = "+525512345678";
const log = createLogger({ sink: () => undefined });

const token = (session: string) => issuer.idToken({ sub: GUEST.sub, ispId: GUEST.ispId, userId: GUEST.userId, role: GUEST.role, isGuest: "true", "cognito:groups": [GUEST.role], origin_jti: session });

async function reasonOf(call: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await call();
  } catch (error) {
    if (error instanceof TRPCError && error.cause instanceof AuthError) return error.cause.reason;
    if (error instanceof TRPCError) return (error.cause as { reason?: string } | undefined)?.reason ?? "OTHER";
    return "OTHER";
  }
  return undefined;
}

const procedurePaths = (): string[] => Object.keys((appRouter as unknown as { _def: { procedures: Record<string, unknown> } })._def.procedures);

function fakeCognito(): CognitoAccounts & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    disable: async (username) => void calls.push(`disable:${username}`),
    enable: async (username) => void calls.push(`enable:${username}`),
    signOutEverywhere: async (username) => void calls.push(`signOut:${username}`),
  };
}

describe("an account the operator blocked reaches nothing [FL-126]", () => {
  let memory: MemoryConnector;
  let phone: MemoryPhone;
  let cognito: ReturnType<typeof fakeCognito>;
  /** Moves the real clock of the SMS code's ports: a container's cache of a passed session lasts a minute. */
  let offsetMs = 0;
  const callerAs = async (session = "jti-1") => {
    const deps = testContextDeps(issuer, { connector: memory.connector, phoneGate: phone.gate, phone: () => phone.ports });
    return createCallerFactory(appRouter)(await createContextFactory(() => deps)({ event: { headers: { authorization: `Bearer ${token(session)}` } }, edge: { viewerIp: "203.0.113.10" } }));
  };
  const call = (caller: unknown, path: string) => () => {
    const target = path.split(".").reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], caller) as (input?: unknown) => Promise<unknown>;
    return target({});
  };
  const block = (action: "BLOCK" | "UNBLOCK") => blockAccount({ client: memory.client, cognito, now: () => new Date(), wait: async () => undefined }, { username: "gst-01K80000000000000000000007", sub: GUEST.sub }, action);
  const sessionRows = () => memory.client.dump("Runtime").filter((row) => String(row.PK).startsWith("PHONESESSION"));

  beforeEach(async () => {
    memory = createMemoryConnector();
    offsetMs = 0;
    phone = memoryPhone({ client: memory.client, codes: () => "246810", now: () => new Date(Date.now() + offsetMs) });
    cognito = fakeCognito();
    await memory.connector.isps.putUser({ ispId: GUEST.ispId, userId: GUEST.userId, role: "GUEST", name: "Invitado 07", cognitoSub: GUEST.sub });
    const guest = await callerAs("jti-1");
    await guest.phone.sendCode({ locale: "es-MX", phone: PHONE });
    await guest.phone.verifyCode({ code: "246810" });
    expect(await reasonOf(() => guest.guest.world())).not.toBe("PHONE_VERIFICATION_REQUIRED");
  });

  it("[FL-126] with a valid token and a passed session, every procedure, the SMS code's included, answers ACCOUNT_BLOCKED and no SMS goes out", async () => {
    expect(sessionRows().length).toBeGreaterThan(0);
    expect(await block("BLOCK")).toEqual({ outcome: "BLOCKED", userId: GUEST.userId, ispId: GUEST.ispId, sessionsCleared: 1 });
    const sent = phone.sms.sent.length;
    const guest = await callerAs("jti-1");
    const answered: string[] = [];
    for (const path of procedurePaths().filter((name) => !PUBLIC.includes(name))) {
      if ((await reasonOf(call(guest, path))) !== "ACCOUNT_BLOCKED") answered.push(path);
    }
    expect(answered).toEqual([]);
    expect(await reasonOf(() => guest.phone.sendCode({ locale: "es-MX" }))).toBe("ACCOUNT_BLOCKED");
    expect(await reasonOf(() => guest.phone.verifyCode({ code: "246810" }))).toBe("ACCOUNT_BLOCKED");
    expect(phone.sms.sent).toHaveLength(sent);
  });

  it("[FL-126] the block marks the row, disables and signs out the Cognito user and deletes every passed session and code out", async () => {
    const other = await callerAs("jti-2");
    await other.phone.sendCode({ locale: "es-MX" });
    await block("BLOCK");
    expect(await memory.client.get("Isps", { PK: `ISP#${GUEST.ispId}`, SK: `USER#${GUEST.userId}` })).toMatchObject({ blockedAt: expect.any(String) });
    expect(cognito.calls).toEqual(["disable:gst-01K80000000000000000000007", "signOut:gst-01K80000000000000000000007"]);
    expect(sessionRows()).toEqual([]);
    expect(memory.client.dump("Runtime").filter((row) => String(row.PK).startsWith("PHONECODE#"))).toEqual([]);
  });

  it("[FL-126] the SMS code's own steps read the row on every call: a blocked account gets no SMS even past the gate", async () => {
    await block("BLOCK");
    const principal = { origin: "COGNITO", sub: GUEST.sub, username: GUEST.userId, userId: GUEST.userId, ispId: GUEST.ispId, clockId: `GUEST#${GUEST.ispId}`, role: "GUEST", isGuest: true, authTime: Math.floor(Date.now() / 1000), sessionId: "jti-3" } as const;
    await expect(sendPhoneCode(phone.ports, { principal, viewerIp: "203.0.113.10", log }, { locale: "es-MX" })).rejects.toMatchObject({ reason: "ACCOUNT_BLOCKED" });
    await expect(verifyPhoneCode(phone.ports, { principal, viewerIp: "203.0.113.10", log }, "246810")).rejects.toMatchObject({ reason: "ACCOUNT_BLOCKED" });
  });

  it("[FL-126] the unblock takes the mark away and enables the user; the old session asks for a new code", async () => {
    await block("BLOCK");
    expect(await block("UNBLOCK")).toEqual({ outcome: "UNBLOCKED", userId: GUEST.userId, ispId: GUEST.ispId });
    expect((await memory.client.get("Isps", { PK: `ISP#${GUEST.ispId}`, SK: `USER#${GUEST.userId}` }))?.blockedAt).toBeUndefined();
    expect(cognito.calls.at(-1)).toBe("enable:gst-01K80000000000000000000007");
    offsetMs = 61_000;
    const guest = await callerAs("jti-1");
    expect(await reasonOf(() => guest.guest.world())).toBe("PHONE_VERIFICATION_REQUIRED");
  });

  it("[FL-126] an account without a registry row is NO_ROW and Cognito is not touched", async () => {
    expect(await blockAccount({ client: memory.client, cognito, now: () => new Date(), wait: async () => undefined }, { username: "nadie", sub: "sub-nobody" }, "BLOCK")).toEqual({ outcome: "NO_ROW" });
    expect(cognito.calls).toEqual([]);
  });
});
