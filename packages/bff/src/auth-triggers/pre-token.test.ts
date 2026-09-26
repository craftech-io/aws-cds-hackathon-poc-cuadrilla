import type { PreTokenGenerationV2TriggerEvent } from "aws-lambda";
import { beforeEach, describe, expect, it } from "vitest";
import { AUTH_REASON } from "../auth/errors";
import { principalFromClaims } from "../auth/principal";
import { createTestIssuer } from "../auth/testing";
import { createMemoryConnector, type Connector } from "../connector/index";
import { createLogger } from "../lib/log";
import { CUSTOM_ISP_ID_ATTRIBUTE, type PreTokenDeps, createPreTokenHandler, decideTokenClaims } from "./pre-token";

const SUB_ADRIANA = "7f1c9d2e-0000-4000-8000-00000000ad01";
const SUB_JUDGE = "7f1c9d2e-0000-4000-8000-00000000d707";

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
    await data.isps.putUser({ ispId: "isp-judge-07", userId: "usr-judge-07", role: "JUDGE", name: "Jurado 07", cognitoSub: SUB_JUDGE });
  });

  const run = (attributes: Record<string, string>, triggerSource?: PreTokenGenerationV2TriggerEvent["triggerSource"]) =>
    createPreTokenHandler(() => deps)(event(attributes, triggerSource));

  it("[FL-079] stamps operator, user, role and judge flag from Isps/USER# by the token's sub", async () => {
    const result = await run({ sub: SUB_ADRIANA, email: "adriana@example.test" });
    expect(result.response.claimsAndScopeOverrideDetails).toEqual({
      idTokenGeneration: {
        claimsToAddOrOverride: { ispId: "isp-demo", userId: "usr-adriana", role: "SUPERVISOR", isJudge: "false" },
        claimsToSuppress: [CUSTOM_ISP_ID_ATTRIBUTE],
      },
      groupOverrideDetails: { groupsToOverride: ["SUPERVISOR"] },
    });
    const judge = await run({ sub: SUB_JUDGE }, "TokenGeneration_RefreshTokens");
    expect(judge.response.claimsAndScopeOverrideDetails.idTokenGeneration?.claimsToAddOrOverride).toEqual({ ispId: "isp-judge-07", userId: "usr-judge-07", role: "JUDGE", isJudge: "true" });
    expect(judge.response.claimsAndScopeOverrideDetails.groupOverrideDetails).toEqual({ groupsToOverride: ["JUDGE"] });
    expect(lines.join("\n")).not.toContain("adriana@example.test");
  });

  it("[FL-081] ignores a custom:ispId that differs from the registry and audits it in the registry's operator", async () => {
    const result = await run({ sub: SUB_JUDGE, [CUSTOM_ISP_ID_ATTRIBUTE]: "isp-judge-03" });
    expect(result.response.claimsAndScopeOverrideDetails.idTokenGeneration?.claimsToAddOrOverride?.ispId).toBe("isp-judge-07");
    expect(result.response.claimsAndScopeOverrideDetails.idTokenGeneration?.claimsToSuppress).toContain(CUSTOM_ISP_ID_ATTRIBUTE);
    const [row, ...others] = await data.audit.listByDecision("isp-judge-07", "DENY");
    expect(others).toEqual([]);
    expect(row).toMatchObject({
      ispId: "isp-judge-07",
      clockId: "JUDGE#isp-judge-07",
      decision: "DENY",
      action: "CUSTOM_ISP_ID_IGNORED",
      actor: "USER:usr-judge-07",
      refs: { userId: "usr-judge-07" },
      detail: { attributeIspId: "isp-judge-03" },
    });
    // Nothing is written to the operator the attribute named.
    expect(await data.audit.listByDecision("isp-judge-03", "DENY")).toEqual([]);
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
    const result = await run({ sub: SUB_JUDGE, [CUSTOM_ISP_ID_ATTRIBUTE]: "isp-demo" });
    const stamped = result.response.claimsAndScopeOverrideDetails.idTokenGeneration?.claimsToAddOrOverride ?? {};
    const token = issuer.idToken({ sub: SUB_JUDGE, "custom:ispId": "isp-demo", "cognito:groups": ["JUDGE"], ...stamped });
    const principal = principalFromClaims(await issuer.verifier().verify(token));
    expect(principal).toMatchObject({ ispId: "isp-judge-07", clockId: "JUDGE#isp-judge-07", role: "JUDGE", userId: "usr-judge-07" });
  });

  it("[FL-079] gives no operator nor role to a sub without a row, with two rows, or with a row that breaks the rules", async () => {
    const issuer = createTestIssuer();
    const verifier = issuer.verifier();
    const expectNoPrincipal = async (sub: string) => {
      const result = await run({ sub, [CUSTOM_ISP_ID_ATTRIBUTE]: "isp-demo" });
      expect(result.response.claimsAndScopeOverrideDetails).toEqual({ idTokenGeneration: { claimsToSuppress: [CUSTOM_ISP_ID_ATTRIBUTE] }, groupOverrideDetails: { groupsToOverride: [] } });
      // The token Cognito issues with that answer: nothing stamped, no groups, no custom:ispId.
      const claims = await verifier.verify(issuer.idToken({ sub, ispId: undefined, userId: undefined, role: undefined, isJudge: undefined, "cognito:groups": [] }));
      expect(() => principalFromClaims(claims)).toThrowError(expect.objectContaining({ reason: AUTH_REASON.PRINCIPAL_INCOMPLETE }));
    };

    await expectNoPrincipal("7f1c9d2e-0000-4000-8000-00000000beef");
    // A second row with the same sub would let a token pick its operator.
    await data.isps.putUser({ ispId: "isp-judge-03", userId: "usr-judge-03", role: "JUDGE", name: "Jurado 03", cognitoSub: SUB_ADRIANA });
    await expectNoPrincipal(SUB_ADRIANA);
    const SUB_MISPLACED = "7f1c9d2e-0000-4000-8000-00000000b0b0";
    await data.isps.putUser({ ispId: "isp-demo", userId: "usr-judge-99", role: "JUDGE", name: "Jurado fuera de lugar", cognitoSub: SUB_MISPLACED });
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
    await expect(createPreTokenHandler(() => noAudit)(event({ sub: SUB_JUDGE, [CUSTOM_ISP_ID_ATTRIBUTE]: "isp-judge-03" }))).rejects.toThrow("audit unavailable");
    await expect(run({})).rejects.toThrow("unexpected event");
    expect(lines.some((line) => line.includes("auth.pretoken.failed"))).toBe(true);
  });

  it("[FL-081] decides without I/O: registry first, attribute only to report the difference", () => {
    const user = { ispId: "isp-demo", userId: "usr-adriana", role: "SUPERVISOR", name: "Adriana", cognitoSub: SUB_ADRIANA, active: true } as const;
    const row = { ...user, entity: "ConsoleUser" as const, createdAt: "2026-10-13T13:00:00.000Z", updatedAt: "2026-10-13T13:00:00.000Z", version: 1, synthetic: false };
    expect(decideTokenClaims(row, undefined)).toEqual({ kind: "STAMP", user: row });
    expect(decideTokenClaims(row, "")).toEqual({ kind: "STAMP", user: row });
    expect(decideTokenClaims(row, "isp-judge-01")).toEqual({ kind: "STAMP", user: row, ignoredIspId: "isp-judge-01" });
    expect(decideTokenClaims(undefined, "isp-demo")).toEqual({ kind: "NO_PRINCIPAL", why: "UNREGISTERED" });
    expect(decideTokenClaims({ ...row, role: "JUDGE" }, undefined)).toEqual({ kind: "NO_PRINCIPAL", why: "INCONSISTENT" });
  });
});
