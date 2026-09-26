import { describe, expect, it } from "vitest";
import { AUTH_REASON } from "./errors";
import { IdTokenClaims } from "./jwt";
import { isSignInFresh, principalFromClaims, roleWorldMismatch } from "./principal";
import { QA_USER_BY_ROLE, qaPrincipal } from "./qa-principal";
import { createUserDirectory } from "./staff";

const NOW = Math.floor(Date.parse("2026-10-14T13:30:00Z") / 1000);

function claims(overrides: Record<string, unknown> = {}): IdTokenClaims {
  const payload: Record<string, unknown> = {
    sub: "sub-1",
    iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TESTPOOL1",
    aud: "client",
    token_use: "id",
    exp: NOW + 900,
    iat: NOW,
    auth_time: NOW,
    origin_jti: "origin-a",
    "cognito:username": "sub-1",
    "cognito:groups": ["SUPERVISOR"],
    ispId: "isp-demo",
    userId: "usr-adriana",
    role: "SUPERVISOR",
    isJudge: "false",
    ...overrides,
  };
  for (const [claim, value] of Object.entries(payload)) if (value === undefined) delete payload[claim];
  return IdTokenClaims.parse(payload);
}

const incomplete = expect.objectContaining({ reason: AUTH_REASON.PRINCIPAL_INCOMPLETE });

describe("principal of a console token [FL-079]", () => {
  it("[FL-079] takes operator, user and role from the claims the trigger stamps, bound to the operator's world", () => {
    expect(principalFromClaims(claims())).toEqual({
      origin: "COGNITO",
      sub: "sub-1",
      username: "sub-1",
      userId: "usr-adriana",
      ispId: "isp-demo",
      clockId: "GLOBAL#isp-demo",
      role: "SUPERVISOR",
      isJudge: false,
      authTime: NOW,
      sessionId: "origin-a",
    });
    expect(principalFromClaims(claims({ role: "OPS", userId: "usr-ops-lina", "cognito:groups": ["OPS"] }))).toMatchObject({ role: "OPS", userId: "usr-ops-lina" });
  });

  it("[FL-079] binds a judge to its own judge world", () => {
    const judge = principalFromClaims(claims({ ispId: "isp-judge-07", userId: "usr-judge-07", role: "JUDGE", isJudge: "true", "cognito:groups": ["JUDGE"] }));
    expect(judge).toMatchObject({ ispId: "isp-judge-07", clockId: "JUDGE#isp-judge-07", role: "JUDGE", isJudge: true });
    expect(principalFromClaims(claims({ ispId: "isp-judge-test", userId: "usr-judge-test", role: "JUDGE", isJudge: undefined })).clockId).toBe("JUDGE#isp-judge-test");
  });

  it("[FL-079] never reads the informative custom:ispId attribute nor the Cognito groups", () => {
    const principal = principalFromClaims(claims({ "custom:ispId": "isp-judge-99", "cognito:groups": ["JUDGE", "OPS"] }));
    expect(principal).toMatchObject({ ispId: "isp-demo", role: "SUPERVISOR" });
    expect(() => principalFromClaims(claims({ ispId: undefined, "custom:ispId": "isp-demo" }))).toThrowError(incomplete);
    // A role the registry did not stamp is not taken from the groups.
    expect(() => principalFromClaims(claims({ role: undefined, "cognito:groups": ["SUPERVISOR"] }))).toThrowError(incomplete);
  });

  it("[FL-079] refuses a token without operator, user or role, or with malformed ones", () => {
    for (const missing of ["ispId", "userId", "role"]) expect(() => principalFromClaims(claims({ [missing]: undefined }))).toThrowError(incomplete);
    expect(() => principalFromClaims(claims({ ispId: "Isp Demo" }))).toThrowError(incomplete);
    expect(() => principalFromClaims(claims({ userId: "adriana" }))).toThrowError(incomplete);
    expect(() => principalFromClaims(claims({ role: "ADMIN" }))).toThrowError(incomplete);
  });

  it("[FL-079] refuses what the trigger never stamps: judges outside judge operators, staff inside them, QA and evaluation operators", () => {
    expect(() => principalFromClaims(claims({ role: "JUDGE", isJudge: "true" }))).toThrowError(incomplete);
    expect(() => principalFromClaims(claims({ ispId: "isp-judge-03" }))).toThrowError(incomplete);
    expect(() => principalFromClaims(claims({ ispId: "isp-qa-812-1-sc-13" }))).toThrowError(incomplete);
    expect(() => principalFromClaims(claims({ ispId: "isp-eval-812-1" }))).toThrowError(incomplete);
    expect(() => principalFromClaims(claims({ isJudge: "true" }))).toThrowError(incomplete);
    expect(roleWorldMismatch("JUDGE", "JUDGE")).toBeUndefined();
    expect(roleWorldMismatch("OPS", "JUDGE")).toBeDefined();
  });

  it("[FL-079] tells sign-ins apart by origin_jti, and falls back to the sign-in instant", () => {
    expect(principalFromClaims(claims({ origin_jti: "origin-b" })).sessionId).toBe("origin-b");
    expect(principalFromClaims(claims({ origin_jti: undefined })).sessionId).toBe(`auth-${NOW}`);
  });

  it("[FL-079] keeps the recent-login window at 15 minutes with 60 s of skew", () => {
    const at = (seconds: number) => new Date((NOW + seconds) * 1000);
    expect(isSignInFresh({ authTime: NOW }, at(15 * 60))).toBe(true);
    expect(isSignInFresh({ authTime: NOW }, at(15 * 60 + 1))).toBe(false);
    expect(isSignInFresh({ authTime: NOW }, at(-60))).toBe(true);
    expect(isSignInFresh({ authTime: NOW }, at(-61))).toBe(false);
  });
});

describe("principals the QaDriver builds on the server [FL-079] [FL-081]", () => {
  const now = new Date(NOW * 1000);
  const notAllowed = expect.objectContaining({ reason: AUTH_REASON.ROLE_NOT_ALLOWED });

  it("[FL-081] binds SUPERVISOR and OPS to the scenario's QA operator and world", () => {
    expect(qaPrincipal({ role: "SUPERVISOR", clockId: "qa-812-1-sc-13" }, now)).toEqual({
      origin: "QA",
      sub: "qa-driver",
      username: "qa-driver",
      userId: QA_USER_BY_ROLE.SUPERVISOR,
      ispId: "isp-qa-812-1-sc-13",
      clockId: "qa-812-1-sc-13",
      role: "SUPERVISOR",
      isJudge: false,
      authTime: NOW,
      sessionId: "qa-usr-qa-sup",
    });
    expect(qaPrincipal({ role: "OPS", clockId: "eval-812-1" }, now)).toMatchObject({ userId: "usr-qa-ops", ispId: "isp-eval-812-1" });
  });

  it("[FL-079] binds the JUDGE principal to isp-judge-test, with the sign-in time and session the scenario sets", () => {
    const judge = qaPrincipal({ role: "JUDGE", clockId: "JUDGE#isp-judge-test", authTime: NOW - 1200, sessionId: "B" }, now);
    expect(judge).toMatchObject({ userId: "usr-qa-judge", ispId: "isp-judge-test", role: "JUDGE", isJudge: true, authTime: NOW - 1200, sessionId: "B" });
  });

  it("[FL-081] refuses any other world or role", () => {
    expect(() => qaPrincipal({ role: "SUPERVISOR", clockId: "GLOBAL#isp-demo" }, now)).toThrowError(notAllowed);
    expect(() => qaPrincipal({ role: "JUDGE", clockId: "JUDGE#isp-judge-07" }, now)).toThrowError(notAllowed);
    expect(() => qaPrincipal({ role: "JUDGE", clockId: "qa-812-1-sc-13" }, now)).toThrowError(notAllowed);
    expect(() => qaPrincipal({ role: "SUPERVISOR", clockId: "JUDGE#isp-judge-test" }, now)).toThrowError(notAllowed);
    expect(() => qaPrincipal({ role: "OPS", clockId: "not-a-world" }, now)).toThrowError(notAllowed);
  });
});

describe("user directory", () => {
  it("reads a console user once per minute and per user", async () => {
    let reads = 0;
    let now = Date.parse("2026-10-14T13:30:00Z");
    const directory = createUserDirectory(
      { findBySub: async (_isp, sub) => { reads += 1; return sub === "sub-1" ? { userId: "usr-sup-01", active: true } : undefined; } },
      () => new Date(now),
    );
    expect(await directory.find("isp-demo", "sub-1")).toEqual({ userId: "usr-sup-01", active: true });
    await directory.find("isp-demo", "sub-1");
    expect(reads).toBe(1);
    now += 60_000;
    await directory.find("isp-demo", "sub-1");
    expect(reads).toBe(2);
    expect(await directory.find("isp-demo", "sub-2")).toBeUndefined();
  });
});
