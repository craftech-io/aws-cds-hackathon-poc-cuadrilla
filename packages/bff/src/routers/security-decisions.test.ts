// Security decisions by name (ADR-0030, FL-127): every refusal of the gate writes a line with a fixed
// `metric` (second factor pending, account blocked, cross-tenant, …), and the SMS code's refusals and caps
// theirs, never with a phone, an email or a code on it. Cognito and SNS are doubles.
import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it } from "vitest";
import { AUTH_REASON, AUTH_REFUSAL_METRIC } from "../auth/errors";
import { type TestContextDeps, createTestIssuer, testContextDeps } from "../auth/testing";
import { type MemoryConnector, createMemoryConnector } from "../connector/index";
import { createLogger } from "../lib/log";
import { blockAccount } from "../phone/block";
import { withRefusalLog } from "../phone/decisions";
import { smsDayKey } from "../phone/limits";
import { type MemoryPhone, memoryPhone } from "../phone/testing";
import { appRouter } from "./index";
import { createCallerFactory, createContextFactory } from "./trpc";
import { ToolError } from "@cuadrilla/shared";

const issuer = createTestIssuer();
const GUEST = { ispId: "isp-guest-07", userId: "usr-guest-07", sub: "sub-guest07-0001", role: "GUEST" };
const PHONE = "+525512345678";
const token = () => issuer.idToken({ sub: GUEST.sub, ispId: GUEST.ispId, userId: GUEST.userId, role: GUEST.role, isGuest: "true", "cognito:groups": [GUEST.role], origin_jti: "jti-1" });
const parsed = (lines: readonly string[]) => lines.map((line) => JSON.parse(line) as Record<string, unknown>);

describe("the gate's refusals carry a fixed metric [FL-127]", () => {
  it("[FL-127] every reason of a refusal has its metric", () => {
    expect(Object.keys(AUTH_REFUSAL_METRIC).sort()).toEqual(Object.keys(AUTH_REASON).sort());
    expect(AUTH_REFUSAL_METRIC).toMatchObject({ PHONE_VERIFICATION_REQUIRED: "SecondFactorPending", ACCOUNT_BLOCKED: "AccountBlocked", CROSS_ISP: "CrossTenantDenied", USER_INACTIVE: "UserInactive" });
  });

  describe("on the real appRouter", () => {
    let memory: MemoryConnector;
    let phone: MemoryPhone;
    let deps: TestContextDeps;
    const caller = async () => {
      deps = testContextDeps(issuer, { connector: memory.connector, phoneGate: phone.gate, phone: () => phone.ports });
      return createCallerFactory(appRouter)(await createContextFactory(() => deps)({ event: { headers: { authorization: `Bearer ${token()}` } }, edge: { viewerIp: "203.0.113.10" } }));
    };
    const refusal = async (call: () => Promise<unknown>) => call().then(() => undefined, (error: unknown) => (error instanceof TRPCError ? error.code : "OTHER"));

    beforeEach(async () => {
      memory = createMemoryConnector();
      phone = memoryPhone({ client: memory.client, codes: () => "246810" });
      await memory.connector.isps.putUser({ ispId: GUEST.ispId, userId: GUEST.userId, role: "GUEST", name: "Invitado 07", cognitoSub: GUEST.sub });
    });

    it("[FL-127] a session without its SMS code: SecondFactorPending, with the path and the reason only", async () => {
      const guest = await caller();
      expect(await refusal(() => guest.guest.world())).toBe("FORBIDDEN");
      const line = parsed(deps.lines).find((item) => item.metric === "SecondFactorPending");
      expect(line).toMatchObject({ message: "console.auth.refused", path: "guest.world", reason: "PHONE_VERIFICATION_REQUIRED", value: 1 });
      expect(JSON.stringify(line)).not.toContain(GUEST.sub);
    });

    it("[FL-127] a blocked account: AccountBlocked", async () => {
      await blockAccount({ client: memory.client, cognito: { disable: async () => undefined, enable: async () => undefined, signOutEverywhere: async () => undefined }, now: () => new Date(), wait: async () => undefined }, { username: "gst-x", sub: GUEST.sub }, "BLOCK");
      const guest = await caller();
      expect(await refusal(() => guest.phone.sendCode({ locale: "es-MX", phone: PHONE }))).toBe("FORBIDDEN");
      expect(parsed(deps.lines).find((item) => item.metric === "AccountBlocked")).toMatchObject({ reason: "ACCOUNT_BLOCKED", path: "phone.sendCode" });
    });

    it("[FL-127] an SMS cap and a refused number: SmsCapHits and PhoneCodeRefused, never the number", async () => {
      await memory.client.put("Runtime", { PK: smsDayKey(new Date()), SK: "META", used: 40 });
      const guest = await caller();
      expect(await refusal(() => guest.phone.sendCode({ locale: "es-MX", phone: PHONE }))).toBe("TOO_MANY_REQUESTS");
      expect(await refusal(() => guest.phone.sendCode({ locale: "es-MX", phone: "+34612345678" }))).toBe("BAD_REQUEST");
      const lines = parsed(deps.lines).filter((item) => item.message === "phone.code.refused");
      expect(lines.map((item) => [item.metric, item.reason, item.step])).toEqual([
        ["SmsCapHits", "SMS_DAILY_LIMIT", "SEND"],
        ["PhoneCodeRefused", "PHONE_COUNTRY_NOT_ALLOWED", "SEND"],
      ]);
      for (const secret of ["5512345678", "612345678"]) expect(JSON.stringify(lines)).not.toContain(secret);
    });
  });
});

describe("withRefusalLog [FL-127]", () => {
  it("[FL-127] names a typed refusal and throws it on; a wrong code keeps its own metric; any other error is not a decision", async () => {
    const lines: string[] = [];
    const log = createLogger({ level: "debug", sink: (line) => void lines.push(line) });
    await expect(withRefusalLog(log, "usr-1", "VERIFY", async () => Promise.reject(new ToolError("INVALID", "x", "CODE_EXHAUSTED")))).rejects.toMatchObject({ reason: "CODE_EXHAUSTED" });
    await expect(withRefusalLog(log, "usr-1", "VERIFY", async () => Promise.reject(new ToolError("INVALID", "x", "CODE_WRONG")))).rejects.toMatchObject({ reason: "CODE_WRONG" });
    await expect(withRefusalLog(log, "usr-1", "SEND", async () => Promise.reject(new Error("network")))).rejects.toThrow("network");
    expect(parsed(lines).map((item) => [item.metric, item.reason, item.step])).toEqual([["PhoneCodeRefused", "CODE_EXHAUSTED", "VERIFY"]]);
    await expect(withRefusalLog(log, "usr-1", "SEND", async () => "ok")).resolves.toBe("ok");
  });
});
