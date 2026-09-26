import { describe, expect, it } from "vitest";
import { FetchError } from "aws-jwt-verify/error";
import { AUTH_REASON, AuthError } from "./errors";
import { bearerToken, createCognitoIdTokenVerifier } from "./jwt";
import { TEST_POOL, createTestIssuer } from "./testing";

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AuthError) return error.reason;
    throw error;
  }
  throw new Error("expected the verification to fail");
}

describe("Cognito id token verification [FL-079]", () => {
  const issuer = createTestIssuer();
  const verifier = issuer.verifier();

  it("accepts a token signed by the pool and returns its claims", async () => {
    const claims = await verifier.verify(issuer.idToken());
    expect(claims.sub).toBe("7f1c9d2e-0000-4000-8000-000000000001");
    expect(claims.ispId).toBe("isp-demo");
    expect(claims.role).toBe("SUPERVISOR");
    expect(claims.token_use).toBe("id");
  });

  it("fetches the JWKS once and serves later tokens from the cache", async () => {
    await verifier.verify(issuer.idToken());
    await verifier.verify(issuer.idToken({ sub: "another-user" }));
    expect(issuer.fetcher.requests).toBe(1);
  });

  it("rejects a token signed with another key under the same kid", async () => {
    const forger = createTestIssuer({ kid: issuer.kid });
    expect(await reasonOf(verifier.verify(forger.idToken()))).toBe(AUTH_REASON.TOKEN_INVALID);
  });

  it("rejects a token whose payload was edited after signing", async () => {
    const [header, , signature] = issuer.idToken().split(".");
    const [, forgedPayload] = issuer.idToken({ ispId: "isp-judge-07" }).split(".");
    const tampered = `${header}.${forgedPayload}.${signature}`;
    expect(await reasonOf(verifier.verify(tampered))).toBe(AUTH_REASON.TOKEN_INVALID);
  });

  it("rejects an unsigned token (alg none)", async () => {
    const [, payload] = issuer.idToken().split(".");
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT", kid: issuer.kid })).toString("base64url");
    expect(await reasonOf(verifier.verify(`${header}.${payload}.`))).toBe(AUTH_REASON.TOKEN_INVALID);
  });

  it("rejects an expired token as TOKEN_EXPIRED", async () => {
    const past = Math.floor(Date.now() / 1000) - 7200;
    const token = issuer.idToken({ iat: past, auth_time: past, exp: past + 3600 });
    expect(await reasonOf(verifier.verify(token))).toBe(AUTH_REASON.TOKEN_EXPIRED);
  });

  it("rejects an access token", async () => {
    const token = issuer.idToken({ token_use: "access", client_id: TEST_POOL.clientId, aud: undefined });
    expect(await reasonOf(verifier.verify(token))).toBe(AUTH_REASON.TOKEN_INVALID);
  });

  it("rejects a token issued for another app client", async () => {
    expect(await reasonOf(verifier.verify(issuer.idToken({ aud: "some-other-client" })))).toBe(AUTH_REASON.TOKEN_INVALID);
  });

  it("rejects a token of another user pool", async () => {
    const token = issuer.idToken({ iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_OTHERPOOL" });
    expect(await reasonOf(verifier.verify(token))).toBe(AUTH_REASON.TOKEN_INVALID);
  });

  it("rejects a token without auth_time: the recent-login window could not be evaluated", async () => {
    expect(await reasonOf(verifier.verify(issuer.idToken({ auth_time: undefined })))).toBe(AUTH_REASON.TOKEN_INVALID);
  });

  it("rejects garbage", async () => {
    expect(await reasonOf(verifier.verify("not-a-jwt"))).toBe(AUTH_REASON.TOKEN_INVALID);
  });

  it("reports an outage, not a bad token, when the JWKS cannot be fetched", async () => {
    const offline = createCognitoIdTokenVerifier(TEST_POOL, {
      fetcher: { fetch: () => Promise.reject(new FetchError("https://cognito-idp.test/jwks.json", "socket hang up")) },
    });
    expect(await reasonOf(offline.verify(issuer.idToken()))).toBe(AUTH_REASON.AUTH_UNAVAILABLE);
  });
});

describe("bearerToken", () => {
  it("extracts the token, whatever the case of the scheme", () => {
    expect(bearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(bearerToken("bearer abc.def.ghi")).toBe("abc.def.ghi");
  });

  it.each([undefined, "", "Basic dXNlcjpwYXNz", "Bearer", "Bearer a b"])("refuses %j as TOKEN_MISSING", (value) => {
    expect(() => bearerToken(value)).toThrowError(expect.objectContaining({ reason: AUTH_REASON.TOKEN_MISSING }));
  });
});
