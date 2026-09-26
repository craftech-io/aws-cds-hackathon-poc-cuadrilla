import { describe, expect, it } from "vitest";
import { AUTH_REASON } from "./errors";
import { IdTokenClaims } from "./jwt";
import { consoleRolesOf, isSignInFresh, principalFromClaims } from "./principal";
import { createUserDirectory } from "./staff";

const NOW = Math.floor(Date.parse("2026-10-14T13:30:00Z") / 1000);

function claims(overrides: Record<string, unknown> = {}): IdTokenClaims {
  return IdTokenClaims.parse({
    sub: "sub-1",
    iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TESTPOOL1",
    aud: "client",
    token_use: "id",
    exp: NOW + 900,
    iat: NOW,
    auth_time: NOW,
    "cognito:username": "sub-1",
    "cognito:groups": ["OPS", "SUPERVISOR"],
    ispId: "isp-demo",
    ...overrides,
  });
}

describe("principal [FL-079]", () => {
  it("takes operator and role from the stamped claims, the highest-precedence group when no role is stamped", () => {
    const principal = principalFromClaims(claims());
    expect(principal).toMatchObject({ ispId: "isp-demo", role: "SUPERVISOR", groups: ["SUPERVISOR", "OPS"], isJudge: false, authTime: NOW });
    expect(principalFromClaims(claims({ role: "OPS" })).role).toBe("OPS");
    expect(principalFromClaims(claims({ userId: "usr-sup-01" })).userId).toBe("usr-sup-01");
    expect(consoleRolesOf(["Admins", "JUDGE"])).toEqual(["JUDGE"]);
  });

  it("marks judge accounts", () => {
    expect(principalFromClaims(claims({ "cognito:groups": ["JUDGE"], ispId: "isp-judge-03" })).isJudge).toBe(true);
    expect(principalFromClaims(claims({ isJudge: "true" })).isJudge).toBe(true);
  });

  it("never reads the informative custom:ispId attribute", () => {
    const principal = principalFromClaims(claims({ "custom:ispId": "isp-judge-99" }));
    expect(principal.ispId).toBe("isp-demo");
    expect(() => principalFromClaims(claims({ ispId: undefined, "custom:ispId": "isp-demo" }))).toThrowError(expect.objectContaining({ reason: AUTH_REASON.PRINCIPAL_INCOMPLETE }));
  });

  it("refuses a token without an operator or without a role", () => {
    expect(() => principalFromClaims(claims({ ispId: undefined }))).toThrowError(expect.objectContaining({ reason: AUTH_REASON.PRINCIPAL_INCOMPLETE }));
    expect(() => principalFromClaims(claims({ ispId: "Isp Demo" }))).toThrowError(expect.objectContaining({ reason: AUTH_REASON.PRINCIPAL_INCOMPLETE }));
    expect(() => principalFromClaims(claims({ "cognito:groups": [] }))).toThrowError(expect.objectContaining({ reason: AUTH_REASON.PRINCIPAL_INCOMPLETE }));
  });

  it("keeps the recent-login window at 15 minutes with 60 s of skew", () => {
    const at = (seconds: number) => new Date((NOW + seconds) * 1000);
    expect(isSignInFresh({ authTime: NOW }, at(15 * 60))).toBe(true);
    expect(isSignInFresh({ authTime: NOW }, at(15 * 60 + 1))).toBe(false);
    expect(isSignInFresh({ authTime: NOW }, at(-60))).toBe(true);
    expect(isSignInFresh({ authTime: NOW }, at(-61))).toBe(false);
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
