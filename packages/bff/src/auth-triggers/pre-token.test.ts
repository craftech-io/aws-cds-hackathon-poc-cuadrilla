import type { PreTokenGenerationV2TriggerEvent } from "aws-lambda";
import { beforeEach, describe, expect, it } from "vitest";
import { AUTH_REASON } from "../auth/errors";
import { principalFromClaims } from "../auth/principal";
import { createTestIssuer } from "../auth/testing";
import { createMemoryConnector, type Connector } from "../connector/index";
import { createLogger } from "../lib/log";
import { CUSTOM_ISP_ID_ATTRIBUTE, INDEX_RETRY_DELAYS_MS, type PreTokenDeps, createPreTokenHandler, decideTokenClaims, resolveRegistryUser } from "./pre-token";

const SUB_ADRIANA = "7f1c9d2e-0000-4000-8000-00000000ad01";
const SUB_GUEST = "7f1c9d2e-0000-4000-8000-00000000d707";

function event(attributes: Record<string, string>, triggerSource: PreTokenGenerationV2TriggerEvent["triggerSource"] = "TokenGeneration_Authentication"): PreTokenGenerationV2TriggerEvent {
  return {
    version: "2",
    region: "us-east-1",
    userPoolId: "us-east-1_TESTPOOL1",
    triggerSource,
    userName: attributes.sub ?? "unknown",
    callerContext: { awsSdkVersion: "aws-sdk-unknown-unknown", clientId: "test-web-client" },
    request: { userAttributes: { "cognito:user_status": "CONFIRMED", ...attributes }, groupConfiguration: { groupsToOverride: ["SUPERVISOR"] }, scopes: [] },
    response: { claimsAndScopeOverrideDetails: {} },
  } as PreTokenGenerationV2TriggerEvent;
}

describe("pre token generation trigger [FL-079] [FL-081]", () => {
  let data: Connector;
  let lines: string[];
  let deps: PreTokenDeps;

  beforeEach(async () => {
    data = createMemoryConnector().connector;
    lines = [];
    deps = {
      findUserBySub: (sub) => data.isps.findUserBySub(sub),
      audit: data.audit,
      newLogger: () => createLogger({ level: "debug", sink: (line) => void lines.push(line) }),
    };
    await data.isps.putUser({ ispId: "isp-demo", userId: "usr-adriana", role: "SUPERVISOR", name: "Adriana Solís", cognitoSub: SUB_ADRIANA });
    await data.isps.putUser({ ispId: "isp-guest-07", userId: "usr-guest-07", role: "GUEST", name: "Invitado 07", cognitoSub: SUB_GUEST });
  });

  const run = (attributes: Record<string, string>, triggerSource?: PreTokenGenerationV2TriggerEvent["triggerSource"]) =>
    createPreTokenHandler(() => deps)(event(attributes, triggerSource));

  it("[FL-079] stamps operator, user, role and guest flag from Isps/USER# by the token's sub", async () => {
    const result = await run({ sub: SUB_ADRIANA, email: "adriana@example.test" });
    expect(result.response.claimsAndScopeOverrideDetails).toEqual({
      idTokenGeneration: {
        claimsToAddOrOverride: { ispId: "isp-demo", userId: "usr-adriana", role: "SUPERVISOR", isGuest: "false" },
        claimsToSuppress: [CUSTOM_ISP_ID_ATTRIBUTE],
      },
      groupOverrideDetails: { groupsToOverride: ["SUPERVISOR"] },
    });
    const guest = await run({ sub: SUB_GUEST }, "TokenGeneration_RefreshTokens");
    expect(guest.response.claimsAndScopeOverrideDetails.idTokenGeneration?.claimsToAddOrOverride).toEqual({ ispId: "isp-guest-07", userId: "usr-guest-07", role: "GUEST", isGuest: "true" });
    expect(guest.response.claimsAndScopeOverrideDetails.groupOverrideDetails).toEqual({ groupsToOverride: ["GUEST"] });
    expect(lines.join("\n")).not.toContain("adriana@example.test");
  });

  it("[FL-081] ignores a custom:ispId that differs from the registry and audits it in the registry's operator", async () => {
    const result = await run({ sub: SUB_GUEST, [CUSTOM_ISP_ID_ATTRIBUTE]: "isp-guest-03" });
    expect(result.response.claimsAndScopeOverrideDetails.idTokenGeneration?.claimsToAddOrOverride?.ispId).toBe("isp-guest-07");
    expect(result.response.claimsAndScopeOverrideDetails.idTokenGeneration?.claimsToSuppress).toContain(CUSTOM_ISP_ID_ATTRIBUTE);
    const [row, ...others] = await data.audit.listByDecision("isp-guest-07", "DENY");
    expect(others).toEqual([]);
    expect(row).toMatchObject({
      ispId: "isp-guest-07",
      clockId: "GUEST#isp-guest-07",
      decision: "DENY",
      action: "CUSTOM_ISP_ID_IGNORED",
      actor: "USER:usr-guest-07",
      refs: { userId: "usr-guest-07" },
      detail: { attributeIspId: "isp-guest-03" },
    });
    // Nothing is written to the operator the attribute named.
    expect(await data.audit.listByDecision("isp-guest-03", "DENY")).toEqual([]);
    expect(lines.some((line) => line.includes("auth.pretoken.custom_ispid_ignored"))).toBe(true);
  });

  it("[FL-081] audits nothing when the attribute agrees with the registry, and never repeats a value that is not an operator id", async () => {
    await run({ sub: SUB_ADRIANA, [CUSTOM_ISP_ID_ATTRIBUTE]: "isp-demo" });
    expect(await data.audit.listByDecision("isp-demo", "DENY")).toEqual([]);
    await run({ sub: SUB_ADRIANA, [CUSTOM_ISP_ID_ATTRIBUTE]: "<script>alert(1)</script>" });
    expect((await data.audit.listByDecision("isp-demo", "DENY"))[0]?.detail).toEqual({ attributeIspId: "(not an operator id)" });
  });

  it("[FL-079] a changed custom:ispId never changes the operator the BFF sees", async () => {
    const issuer = createTestIssuer();
    const result = await run({ sub: SUB_GUEST, [CUSTOM_ISP_ID_ATTRIBUTE]: "isp-demo" });
    const stamped = result.response.claimsAndScopeOverrideDetails.idTokenGeneration?.claimsToAddOrOverride ?? {};
    const token = issuer.idToken({ sub: SUB_GUEST, "custom:ispId": "isp-demo", "cognito:groups": ["GUEST"], ...stamped });
    const principal = principalFromClaims(await issuer.verifier().verify(token));
    expect(principal).toMatchObject({ ispId: "isp-guest-07", clockId: "GUEST#isp-guest-07", role: "GUEST", userId: "usr-guest-07" });
  });

  it("[FL-079] gives no operator nor role to a sub without a row, with two rows, or with a row that breaks the rules", async () => {
    const issuer = createTestIssuer();
    const verifier = issuer.verifier();
    const expectNoPrincipal = async (sub: string) => {
      const result = await run({ sub, [CUSTOM_ISP_ID_ATTRIBUTE]: "isp-demo" });
      expect(result.response.claimsAndScopeOverrideDetails).toEqual({ idTokenGeneration: { claimsToSuppress: [CUSTOM_ISP_ID_ATTRIBUTE] }, groupOverrideDetails: { groupsToOverride: [] } });
      // The token Cognito issues with that answer: nothing stamped, no groups, no custom:ispId.
      const claims = await verifier.verify(issuer.idToken({ sub, ispId: undefined, userId: undefined, role: undefined, isGuest: undefined, "cognito:groups": [] }));
      expect(() => principalFromClaims(claims)).toThrowError(expect.objectContaining({ reason: AUTH_REASON.PRINCIPAL_INCOMPLETE }));
    };

    await expectNoPrincipal("7f1c9d2e-0000-4000-8000-00000000beef");
    // A second row with the same sub would let a token pick its operator.
    await data.isps.putUser({ ispId: "isp-guest-03", userId: "usr-guest-03", role: "GUEST", name: "Invitado 03", cognitoSub: SUB_ADRIANA });
    await expectNoPrincipal(SUB_ADRIANA);
    const SUB_MISPLACED = "7f1c9d2e-0000-4000-8000-00000000b0b0";
    await data.isps.putUser({ ispId: "isp-demo", userId: "usr-guest-99", role: "GUEST", name: "Invitado fuera de lugar", cognitoSub: SUB_MISPLACED });
    await expectNoPrincipal(SUB_MISPLACED);
    const SUB_QA = "7f1c9d2e-0000-4000-8000-00000000c0c0";
    await data.isps.putUser({ ispId: "isp-qa-812-1-sc-13", userId: "usr-qa-sup", role: "SUPERVISOR", name: "QA", cognitoSub: SUB_QA });
    await expectNoPrincipal(SUB_QA);
    expect(lines.filter((line) => line.includes("auth.pretoken.no_principal"))).toHaveLength(4);
  });

  it("[FL-079] stamps an inactive user like any other: the BFF refuses it on every request", async () => {
    await data.isps.setUserActive("isp-demo", "usr-adriana", false);
    const result = await run({ sub: SUB_ADRIANA });
    expect(result.response.claimsAndScopeOverrideDetails.idTokenGeneration?.claimsToAddOrOverride?.userId).toBe("usr-adriana");
  });

  it("[FL-079] fails the sign-in when the registry or the audit cannot answer, or the event has no sub", async () => {
    const failing: PreTokenDeps = { ...deps, findUserBySub: () => Promise.reject(new Error("dynamodb unreachable")) };
    await expect(createPreTokenHandler(() => failing)(event({ sub: SUB_ADRIANA }))).rejects.toThrow("dynamodb unreachable");
    const noAudit: PreTokenDeps = { ...deps, audit: { append: () => Promise.reject(new Error("audit unavailable")) } };
    await expect(createPreTokenHandler(() => noAudit)(event({ sub: SUB_GUEST, [CUSTOM_ISP_ID_ATTRIBUTE]: "isp-guest-03" }))).rejects.toThrow("audit unavailable");
    await expect(run({})).rejects.toThrow("unexpected event");
    expect(lines.some((line) => line.includes("auth.pretoken.failed"))).toBe(true);
  });

  it("[FL-081] decides without I/O: registry first, attribute only to report the difference", () => {
    const user = { ispId: "isp-demo", userId: "usr-adriana", role: "SUPERVISOR", name: "Adriana", cognitoSub: SUB_ADRIANA, active: true } as const;
    const row = { ...user, entity: "ConsoleUser" as const, createdAt: "2026-10-13T13:00:00.000Z", updatedAt: "2026-10-13T13:00:00.000Z", version: 1, synthetic: false };
    expect(decideTokenClaims(row, undefined)).toEqual({ kind: "STAMP", user: row });
    expect(decideTokenClaims(row, "")).toEqual({ kind: "STAMP", user: row });
    expect(decideTokenClaims(row, "isp-guest-01")).toEqual({ kind: "STAMP", user: row, ignoredIspId: "isp-guest-01" });
    expect(decideTokenClaims(undefined, "isp-demo")).toEqual({ kind: "NO_PRINCIPAL", why: "UNREGISTERED" });
    expect(decideTokenClaims({ ...row, role: "GUEST" }, undefined)).toEqual({ kind: "NO_PRINCIPAL", why: "INCONSISTENT" });
  });
});

describe("[FL-108] the registry row of a guest of the own sign-up, as the post triggers leave it", () => {
  const SUB_SIGNUP = "7f1c9d2e-0000-4000-8000-00000000s001";
  const OLD = "isp-guest-s261001abcde";
  const NEW = "isp-guest-s261009vwxyz";
  const USER = "usr-g01K60000000000000000000001";
  const signupRow = (ispId: string) => ({ ispId, userId: USER, role: "GUEST" as const, name: "Invitado", cognitoSub: SUB_SIGNUP, guestOrigin: "SIGNUP" as const, cognitoUsername: "gst-01K60000000000000000000001" });

  it("[FL-108] stamps the generation's operator, role GUEST and isGuest for a sign-up guest", async () => {
    const data = createMemoryConnector().connector;
    await data.isps.putUser(signupRow(NEW));
    const deps: PreTokenDeps = { findUserBySub: (sub) => resolveRegistryUser(data.isps, sub, async () => undefined), audit: data.audit, newLogger: () => createLogger({ sink: () => undefined }) };
    const result = await createPreTokenHandler(() => deps)(event({ sub: SUB_SIGNUP }));
    expect(result.response.claimsAndScopeOverrideDetails.idTokenGeneration?.claimsToAddOrOverride).toEqual({ ispId: NEW, userId: USER, role: "GUEST", isGuest: "true" });
  });

  it("[FL-111] right after a new generation the index may still list the old row: only the live one is stamped", async () => {
    const data = createMemoryConnector().connector;
    await data.isps.putUser(signupRow(NEW));
    const stale = { ...(await data.isps.getUser(NEW, USER)), ispId: OLD };
    const isps = { listUsersBySub: async () => [stale as never, (await data.isps.getUser(NEW, USER)) as never], getUser: (ispId: string, userId: string) => data.isps.getUser(ispId, userId) };
    expect((await resolveRegistryUser(isps, SUB_SIGNUP, async () => undefined))?.ispId).toBe(NEW);
  });

  it("[FL-105] an index that does not show the row yet is read again within the deadline; nothing live after that opens nothing", async () => {
    const data = createMemoryConnector().connector;
    const waits: number[] = [];
    let reads = 0;
    const isps = {
      listUsersBySub: async (sub: string, limit: number) => {
        reads += 1;
        if (reads === 2) await data.isps.putUser(signupRow(NEW));
        return data.isps.listUsersBySub(sub, limit);
      },
      getUser: (ispId: string, userId: string) => data.isps.getUser(ispId, userId),
    };
    expect((await resolveRegistryUser(isps, SUB_SIGNUP, async (ms) => void waits.push(ms)))?.ispId).toBe(NEW);
    expect(waits).toEqual([INDEX_RETRY_DELAYS_MS[0]]);
    const none: number[] = [];
    expect(await resolveRegistryUser(data.isps, "sub-nobody", async (ms) => void none.push(ms))).toBeUndefined();
    expect(none).toEqual([...INDEX_RETRY_DELAYS_MS]);
    expect(INDEX_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0)).toBeLessThan(2_000);
  });

  it("two live rows of one sub open nothing", async () => {
    const data = createMemoryConnector().connector;
    await data.isps.putUser(signupRow(NEW));
    await data.isps.putUser(signupRow(OLD));
    expect(await resolveRegistryUser(data.isps, SUB_SIGNUP, async () => undefined)).toBeUndefined();
  });
});
