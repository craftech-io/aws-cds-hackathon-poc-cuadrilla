import { describe, expect, it } from "vitest";
import { parseIdTokenClaims, principalFromClaims, principalFromIdToken, signInIdOf } from "./auth-claims";

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", kid: "k" })}.${encode(payload)}.signature`;
}

const base = {
  sub: "sub-1",
  iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_x",
  aud: "client",
  exp: 1_800_000_000,
  iat: 1_799_996_400,
  token_use: "id",
  email: "ana@example.test",
};

describe("principal from the id token", () => {
  it("[FL-079] signs an invited guest without email in again by its username", () => {
    const { email: _email, ...withoutEmail } = base;
    const guest = principalFromIdToken(jwt({ ...withoutEmail, "cognito:username": "guest-01", role: "GUEST" }));
    expect(guest).toMatchObject({ username: "guest-01", isGuest: true });
    expect(guest.email).toBeUndefined();
    expect(signInIdOf(guest)).toBe("guest-01");
    expect(signInIdOf(principalFromIdToken(jwt({ ...base, "cognito:username": "gst-1" })))).toBe("ana@example.test");
  });

  it("reads ispId, the stamped role and groups", () => {
    const principal = principalFromIdToken(jwt({ ...base, ispId: "isp-demo", role: "SUPERVISOR", "cognito:groups": ["OPS"] }));
    expect(principal).toMatchObject({ sub: "sub-1", ispId: "isp-demo", role: "SUPERVISOR", groups: ["OPS"], expiresAt: 1_800_000_000_000 });
  });

  it("falls back to the highest-precedence group and drops unknown groups", () => {
    const principal = principalFromClaims(parseIdTokenClaims(jwt({ ...base, "cognito:groups": ["OPS", "custom-thing", "SUPERVISOR"] })));
    expect(principal.role).toBe("SUPERVISOR");
    expect(principal.groups).toEqual(["SUPERVISOR", "OPS"]);
    expect(principal.ispId).toBeUndefined();
  });

  it("ignores an invalid role and leaves role undefined without groups", () => {
    const principal = principalFromIdToken(jwt({ ...base, role: "ROOT" }));
    expect(principal.role).toBeUndefined();
  });

  it("marks guests from the stamped role or the isGuest claim", () => {
    expect(principalFromIdToken(jwt({ ...base, ispId: "isp-guest-07", role: "GUEST" })).isGuest).toBe(true);
    expect(principalFromIdToken(jwt({ ...base, ispId: "isp-guest-07", role: "SUPERVISOR", isGuest: "true" })).isGuest).toBe(true);
    expect(principalFromIdToken(jwt({ ...base, ispId: "isp-demo", role: "SUPERVISOR" })).isGuest).toBe(false);
  });

  it("never takes the operator from the informative custom:ispId attribute", () => {
    expect(principalFromIdToken(jwt({ ...base, "custom:ispId": "isp-demo" })).ispId).toBeUndefined();
  });

  it("rejects access tokens and malformed tokens", () => {
    expect(() => principalFromIdToken(jwt({ ...base, token_use: "access" }))).toThrow();
    expect(() => principalFromIdToken("not-a-jwt")).toThrow();
  });
});
